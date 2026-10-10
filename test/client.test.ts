import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FixFlowApiError, FixFlowClient } from '../src/fixflow/client.js';
import { sampleRequest, startHarness, type Harness } from './helpers.js';

describe('FixFlowClient against the mock', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('verifies the key and names the manufacturer', async () => {
    const info = await h.client.verifyKey();
    assert.equal(info.manufacturer.name, 'Demo Manufacturer');
    assert.equal(info.key.prefix, 'ffmfr_test_k');
  });

  it('rejects a wrong key with 401 problem details', async () => {
    const wrong = new FixFlowClient({ baseUrl: h.baseUrl, apiKey: 'ffmfr_wrong' });
    await assert.rejects(wrong.verifyKey(), (error: unknown) => {
      assert.ok(error instanceof FixFlowApiError);
      assert.equal(error.status, 401);
      assert.equal(error.problem.title, 'Unauthorized');
      return true;
    });
  });

  it('creates a work order once and replays it for the same externalReference', async () => {
    const request = sampleRequest();
    const first = await h.client.createWorkOrder(request);
    assert.equal(first.replayed, false);
    assert.equal(first.workOrder.status, 'New');
    assert.equal(first.workOrder.externalReference, request.externalReference);

    const again = await h.client.createWorkOrder({ ...request, description: 'changed text is ignored' });
    assert.equal(again.replayed, true);
    assert.equal(again.workOrder.id, first.workOrder.id);
    assert.equal(again.workOrder.description, request.description);
  });

  it('returns 422 field errors keyed by JSON path', async () => {
    const invalid = sampleRequest({
      customer: { name: '' },
      serviceLocation: { addressLine1: 'x', city: 'Trenton', state: 'NJ', zip: '' },
      urgency: 'Whenever' as never,
    });
    await assert.rejects(h.client.createWorkOrder(invalid), (error: unknown) => {
      assert.ok(error instanceof FixFlowApiError);
      assert.equal(error.status, 422);
      assert.deepEqual(Object.keys(error.fieldErrors).sort(), ['customer.name', 'serviceLocation.zip', 'urgency']);
      return true;
    });
  });

  it('reads one work order by id and by reference; unknown is null', async () => {
    const { workOrder } = await h.client.createWorkOrder(sampleRequest());
    assert.equal((await h.client.getWorkOrder(workOrder.id))?.number, workOrder.number);
    assert.equal((await h.client.getWorkOrderByReference(workOrder.externalReference!))?.id, workOrder.id);
    assert.equal(await h.client.getWorkOrder(999_999), null);
    assert.equal(await h.client.getWorkOrderByReference('NO-SUCH-CLAIM'), null);
  });

  it('reads a batch and lists what it could not find', async () => {
    const { workOrder } = await h.client.createWorkOrder(sampleRequest());
    const batch = await h.client.getWorkOrders({ ids: [workOrder.id, 999_999], references: ['NO-SUCH-CLAIM'] });
    assert.deepEqual(batch.items.map((w) => w.id), [workOrder.id]);
    assert.deepEqual(batch.notFound, { ids: [999_999], references: ['NO-SUCH-CLAIM'] });
  });
});

describe('change feed through the client', () => {
  it('subscribes from now, holds back young changes, coalesces and pages without loss', async () => {
    const h = await startHarness();
    try {
      const a = (await h.client.createWorkOrder(sampleRequest())).workOrder;
      const b = (await h.client.createWorkOrder(sampleRequest())).workOrder;

      // Subscribing returns no items, only the current cursor.
      const head = await h.client.getChanges();
      assert.deepEqual(head.items, []);

      // Two status steps for both work orders; still inside the 5 s lag → nothing yet.
      h.mock.advanceAll();
      h.mock.advanceAll();
      const young = await h.client.getChanges({ cursor: head.nextCursor });
      assert.deepEqual(young.items, []);
      assert.equal(young.nextCursor, head.nextCursor);

      // Past the lag: page through with limit 1 until hasMore is false. Every item is the CURRENT
      // snapshot; the same work order may come again on a later page (at-least-once), so the client
      // applies by id. Nothing may be lost.
      h.advanceClock(6_000);
      const first = await h.client.getChanges({ cursor: head.nextCursor, limit: 1 });
      assert.equal(first.items.length, 1);
      assert.equal(first.items[0]?.id, a.id);
      assert.equal(first.items[0]?.status, 'Assigned');
      assert.equal(first.hasMore, true);

      const latest = new Map<number, string>([[a.id, first.items[0]!.status]]);
      let cursor = first.nextCursor;
      let more: boolean = first.hasMore;
      for (let pages = 0; more; pages++) {
        assert.ok(pages < 10, 'the feed terminates');
        const page = await h.client.getChanges({ cursor, limit: 1 });
        for (const item of page.items) latest.set(item.id, item.status);
        cursor = page.nextCursor;
        more = page.hasMore;
      }
      assert.deepEqual(Object.fromEntries(latest), { [a.id]: 'Assigned', [b.id]: 'Assigned' });

      // Caught up: the next call from the last cursor is empty.
      const caughtUp = await h.client.getChanges({ cursor });
      assert.deepEqual(caughtUp.items, []);
      assert.equal(caughtUp.hasMore, false);
    } finally {
      await h.close();
    }
  });

  it('replays history with since', async () => {
    const h = await startHarness();
    try {
      const { workOrder } = await h.client.createWorkOrder(sampleRequest());
      h.mock.advanceAll();
      h.advanceClock(6_000);
      const page = await h.client.getChanges({ since: '2026-10-10T00:00:00Z' });
      assert.deepEqual(page.items.map((w) => w.id), [workOrder.id]);
    } finally {
      await h.close();
    }
  });
});

describe('rate limiting', () => {
  it('surfaces 429 with Retry-After when retries are exhausted', async () => {
    const h = await startHarness({ rateLimitPerMinute: 1 });
    try {
      await h.client.verifyKey();
      await assert.rejects(h.client.verifyKey(), (error: unknown) => {
        assert.ok(error instanceof FixFlowApiError);
        assert.equal(error.status, 429);
        return true;
      });
    } finally {
      await h.close();
    }
  });

  it('waits for Retry-After and retries a 429', async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ title: 'Too many requests', status: 429 }), {
            status: 429,
            headers: { 'Retry-After': '1', 'Content-Type': 'application/problem+json' },
          })
        : Response.json({ manufacturer: { id: 1, name: 'M' }, key: { name: 'k', prefix: 'ffmfr_', createdAt: '', lastUsedAt: null } });
    };
    const client = new FixFlowClient({ baseUrl: 'http://example.invalid/fixflow', apiKey: 'k', fetch: fakeFetch });
    const started = Date.now();
    const info = await client.verifyKey();
    assert.equal(info.manufacturer.name, 'M');
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 900, 'waited for Retry-After');
  });
});
