import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { StateStore } from '../src/sync/state-store.js';

describe('StateStore', () => {
  it('keeps what was registered across restarts', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fixflow-client-'));
    try {
      const store = new StateStore(dataDir);
      store.rememberCustomer({ id: 1, reference: 'C-1', name: 'Riverside Dental' });
      store.rememberEquipment({ id: 3, serialNumber: 'SN-1', modelNumber: 'AC-200', name: 'AC-200', serviceLocation: { id: 2, reference: 'S-1' } });
      await store.save();

      const reloaded = new StateStore(dataDir);
      await reloaded.load();
      assert.equal(reloaded.directory.customers['C-1']?.name, 'Riverside Dental');
      assert.equal(reloaded.directory.equipment['SN-1']?.id, 3);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('loads a state file written before the directory existed', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fixflow-client-'));
    try {
      await writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ cursor: 'djE6MQ', workOrders: {} }), 'utf8');
      const store = new StateStore(dataDir);
      await store.load();
      assert.equal(store.cursor, 'djE6MQ');
      assert.deepEqual(store.directory, { customers: {}, serviceLocations: {}, equipment: {} });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
