import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FixFlowApiError, FixFlowClient } from '../src/fixflow/client.js';
import { keysOnlyRequest, sampleRequest, startHarness, type Harness } from './helpers.js';

/** Runs `call` and returns the FixFlowApiError it throws. */
async function apiError(call: Promise<unknown>): Promise<FixFlowApiError> {
  try {
    await call;
  } catch (error) {
    assert.ok(error instanceof FixFlowApiError, `expected a FixFlowApiError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

describe('the key', () => {
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
    const error = await apiError(wrong.verifyKey());
    assert.equal(error.status, 401);
    assert.equal(error.problem.title, 'Unauthorized');
  });
});

describe('work orders addressed by your keys', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('creates a work order once and replays it for the same externalReference', async () => {
    const request = sampleRequest();
    const first = await h.client.createWorkOrder(request);
    assert.equal(first.replayed, false);
    assert.equal(first.workOrder.status, 'New');
    assert.equal(first.workOrder.customer.reference, 'CUST-99812');
    assert.equal(first.workOrder.serviceLocation?.reference, 'SITE-4471');

    const again = await h.client.createWorkOrder({ ...request, description: 'changed text is ignored' });
    assert.equal(again.replayed, true);
    assert.equal(again.workOrder.id, first.workOrder.id);
    assert.equal(again.workOrder.description, request.description);
  });

  it('always needs both keys, the claim number and a description', async () => {
    const error = await apiError(h.client.createWorkOrder({} as never));
    assert.equal(error.status, 422);
    assert.deepEqual(Object.keys(error.fieldErrors).sort(), [
      'customer.reference',
      'description',
      'externalReference',
      'serviceLocation.reference',
    ]);
  });

  it('needs the name and the address only while a key is still unknown', async () => {
    const error = await apiError(
      h.client.createWorkOrder(keysOnlyRequest({ customer: { reference: 'NEW-C' }, serviceLocation: { reference: 'NEW-S' } })),
    );
    assert.equal(error.status, 422);
    assert.deepEqual(Object.keys(error.fieldErrors).sort(), [
      'customer.name',
      'serviceLocation.addressLine1',
      'serviceLocation.city',
      'serviceLocation.state',
      'serviceLocation.zip',
    ]);
  });

  it('a known key leads to the same rows, whatever else the request says', async () => {
    const first = (await h.client.createWorkOrder(sampleRequest())).workOrder;
    const second = (await h.client.createWorkOrder(
      keysOnlyRequest({ customer: { reference: 'CUST-99812', name: 'A different name' } }),
    )).workOrder;
    assert.equal(second.customer.id, first.customer.id);
    assert.equal(second.customer.name, 'Riverside Dental', 'the stored customer is never overwritten');
    assert.equal(second.serviceLocation?.id, first.serviceLocation?.id);
    assert.equal(second.equipment?.id, first.equipment?.id, 'the serial number found the unit, no model needed');
  });

  it('rejects a known site of a different customer', async () => {
    await h.client.createWorkOrder(sampleRequest());
    const error = await apiError(h.client.createWorkOrder(sampleRequest({
      customer: { reference: 'CUST-OTHER', name: 'Northside Clinic' },
    })));
    assert.equal(error.status, 422);
    assert.deepEqual(Object.keys(error.fieldErrors), ['serviceLocation.reference']);
  });

  it('a new unit needs a model number', async () => {
    const error = await apiError(h.client.createWorkOrder(keysOnlyRequest({ equipment: { serialNumber: 'SN-NEW' } })));
    assert.equal(error.status, 422);
    assert.deepEqual(Object.keys(error.fieldErrors), ['equipment.modelNumber']);
  });

  it('takes a catalogue problem and rejects an unknown one', async () => {
    const [problem] = await h.client.getAllProblems({ search: 'not making ice' });
    assert.ok(problem);
    const { workOrder } = await h.client.createWorkOrder(sampleRequest({ problemId: problem.id }));
    assert.deepEqual(workOrder.problem, { id: problem.id, name: problem.name });

    const error = await apiError(h.client.createWorkOrder(sampleRequest({ problemId: 999_999 })));
    assert.deepEqual(Object.keys(error.fieldErrors), ['problemId']);
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

describe('registering your directory', () => {
  const trenton = { addressLine1: '125 West State Street', city: 'Trenton', state: 'NJ', zip: '08608' };

  it('registers a customer once; a repeat returns the stored row unchanged', async () => {
    const h = await startHarness();
    try {
      const first = await h.client.registerCustomer({ reference: 'C-1', name: 'Riverside Dental' });
      assert.equal(first.replayed, false);
      const again = await h.client.registerCustomer({ reference: 'C-1', name: 'Renamed' });
      assert.equal(again.replayed, true);
      assert.deepEqual(again.resource, first.resource);
      assert.deepEqual(await h.client.getCustomer('C-1'), first.resource);
      assert.equal(await h.client.getCustomer('NOT-MINE'), null);
    } finally {
      await h.close();
    }
  });

  it('finds a customer FixFlow already has by name WITH address, never by name alone', async () => {
    const h = await startHarness({ seedDirectory: true });
    try {
      const matched = await h.client.registerCustomer({ reference: 'C-1', name: 'riverside  dental', address: trenton });
      const seededSite = (await h.client.registerServiceLocation({ reference: 'S-1', customerReference: 'C-1', ...trenton })).resource;
      assert.equal(seededSite.customer.id, matched.resource.id);
      assert.equal(seededSite.name, 'Riverside Dental — Trenton', 'the existing site was found, not created');

      const byNameOnly = await h.client.registerCustomer({ reference: 'C-2', name: 'Riverside Dental' });
      assert.notEqual(byNameOnly.resource.id, matched.resource.id);
    } finally {
      await h.close();
    }
  });

  it('a site needs a registered customer', async () => {
    const h = await startHarness();
    try {
      const error = await apiError(h.client.registerServiceLocation({ reference: 'S-1', customerReference: 'NOPE', ...trenton }));
      assert.equal(error.status, 422);
      assert.deepEqual(Object.keys(error.fieldErrors), ['customerReference']);
    } finally {
      await h.close();
    }
  });

  it('registers a unit by serial number; the same serial at another site is a 409', async () => {
    const h = await startHarness();
    try {
      await h.client.registerCustomer({ reference: 'C-1', name: 'Riverside Dental' });
      await h.client.registerServiceLocation({ reference: 'S-1', customerReference: 'C-1', ...trenton });
      await h.client.registerServiceLocation({
        reference: 'S-2', customerReference: 'C-1', addressLine1: '900 Market Street', city: 'Philadelphia', state: 'PA', zip: '19106',
      });

      const unit = await h.client.registerEquipment({ serviceLocationReference: 'S-1', serialNumber: 'SN-1', modelNumber: 'AC-200' });
      assert.equal(unit.replayed, false);
      assert.equal(unit.resource.serviceLocation.reference, 'S-1');
      const again = await h.client.registerEquipment({ serviceLocationReference: 'S-1', serialNumber: 'sn-1', modelNumber: 'X' });
      assert.equal(again.replayed, true);
      assert.equal(again.resource.id, unit.resource.id);

      const moved = await apiError(h.client.registerEquipment({ serviceLocationReference: 'S-2', serialNumber: 'SN-1', modelNumber: 'AC-200' }));
      assert.equal(moved.status, 409);

      const unknownSite = await apiError(h.client.registerEquipment({ serviceLocationReference: 'NOPE', serialNumber: 'SN-2', modelNumber: 'AC-200' }));
      assert.deepEqual(Object.keys(unknownSite.fieldErrors), ['serviceLocationReference']);

      assert.deepEqual((await h.client.findEquipment('SN-1')).map((u) => u.id), [unit.resource.id]);
      assert.deepEqual(await h.client.findEquipment('NOTHING'), []);
    } finally {
      await h.close();
    }
  });

  it('the recommended flow: register once, then create work orders with the keys only', async () => {
    const h = await startHarness();
    try {
      await h.client.registerCustomer({ reference: 'CUST-99812', name: 'Riverside Dental' });
      const site = (await h.client.registerServiceLocation({ reference: 'SITE-4471', customerReference: 'CUST-99812', ...trenton })).resource;
      const unit = (await h.client.registerEquipment({ serviceLocationReference: 'SITE-4471', serialNumber: 'SN-77421', modelNumber: 'AC-200' })).resource;

      const { workOrder } = await h.client.createWorkOrder(keysOnlyRequest({ problemId: 107 }));
      assert.equal(workOrder.serviceLocation?.id, site.id);
      assert.equal(workOrder.equipment?.id, unit.id);
      assert.equal(workOrder.problem?.name, 'Not cooling');
    } finally {
      await h.close();
    }
  });
});

describe('the problem catalogue', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('pages through the whole catalogue without gaps or repeats', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 10);
      const page = await h.client.getProblems({ limit: 5, cursor });
      seen.push(...page.items.map((p) => p.id));
      if (!page.hasMore) {
        assert.equal(page.nextCursor, null);
        break;
      }
      cursor = page.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen, (await h.client.getAllProblems()).map((p) => p.id));
  });

  it('filters by equipment type and by name or code', async () => {
    const ice = await h.client.getAllProblems({ equipmentType: 'ice machine' });
    assert.ok(ice.length > 0);
    assert.ok(ice.every((p) => p.equipmentType === 'Ice Machine'));
    const ov = await h.client.getAllProblems({ search: 'ov' });
    assert.ok(ov.every((p) => p.name.toLowerCase().includes('ov') || p.code?.toLowerCase().includes('ov')));
  });

  it('rejects a cursor it did not issue', async () => {
    const error = await apiError(h.client.getProblems({ cursor: 'not-a-cursor' }));
    assert.equal(error.status, 422);
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
      const error = await apiError(h.client.verifyKey());
      assert.equal(error.status, 429);
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
