import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ChangeFeedPoller } from '../src/sync/poller.js';
import { StateStore } from '../src/sync/state-store.js';
import { sampleRequest, startHarness } from './helpers.js';

describe('ChangeFeedPoller', () => {
  it('subscribes, applies changes across pages, and keeps its cursor across restarts', async () => {
    const h = await startHarness();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fixflow-client-'));
    try {
      const store = new StateStore(dataDir);
      await store.load();
      const poller = new ChangeFeedPoller(h.client, store, { intervalMs: 60_000, limit: 1 });

      // First run only subscribes.
      const subscribe = await poller.pollOnce();
      assert.equal(subscribe.subscribed, true);
      assert.ok(store.cursor);

      const a = (await h.client.createWorkOrder(sampleRequest())).workOrder;
      const b = (await h.client.createWorkOrder(sampleRequest())).workOrder;
      h.mock.advanceAll();
      h.advanceClock(6_000);

      // limit 1 → two pages, both read in ONE run because hasMore is followed straight away.
      const run = await poller.pollOnce();
      assert.equal(run.applied, 2);
      assert.equal(run.pages, 2);
      assert.deepEqual(
        store.list().map((t) => [t.workOrder.id, t.workOrder.status]).sort(),
        [
          [a.id, 'Dispatched'],
          [b.id, 'Dispatched'],
        ],
      );

      // A restarted process resumes from the stored cursor: nothing is applied twice by surprise.
      const reloaded = new StateStore(dataDir);
      await reloaded.load();
      assert.equal(reloaded.cursor, store.cursor);
      const again = await new ChangeFeedPoller(h.client, reloaded, { intervalMs: 60_000 }).pollOnce();
      assert.equal(again.applied, 0);
    } finally {
      await h.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('never replaces a newer snapshot with an older one', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fixflow-client-'));
    try {
      const store = new StateStore(dataDir);
      const h = await startHarness();
      const { workOrder } = await h.client.createWorkOrder(sampleRequest());
      await h.close();

      store.upsert({ ...workOrder, status: 'Working' }, '2026-10-10T09:00:00.000Z');
      store.upsert({ ...workOrder, status: 'Assigned' }, '2026-10-10T08:30:00.000Z');
      assert.equal(store.list()[0]?.workOrder.status, 'Working');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
