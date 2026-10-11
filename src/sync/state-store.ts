import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Customer, Equipment, ServiceLocation, WorkOrder } from '../fixflow/types.js';

/** A work order this client knows about, as last seen. */
export interface TrackedWorkOrder {
  workOrder: WorkOrder;
  /** When FixFlow says it last changed (`changedAt` of the feed), or when we created it. */
  changedAt: string;
  /** When this client last received it. */
  receivedAt: string;
}

/**
 * What this client registered in FixFlow, keyed by its OWN keys. A real integration does not need
 * this list: its own database already holds those keys. The demo keeps it only to offer the keys in
 * its forms.
 */
export interface Directory {
  customers: Record<string, Customer>;
  serviceLocations: Record<string, ServiceLocation>;
  /** By serial number. */
  equipment: Record<string, Equipment>;
}

interface PersistedState {
  /** The last `nextCursor` of the change feed. `null` = not subscribed yet. */
  cursor: string | null;
  workOrders: Record<string, TrackedWorkOrder>;
  directory: Directory;
}

const emptyState = (): PersistedState => ({
  cursor: null,
  workOrders: {},
  directory: { customers: {}, serviceLocations: {}, equipment: {} },
});

/**
 * The client's local state in one small JSON file: the feed cursor, the work orders seen and what
 * was registered.
 *
 * In a real integration this is your database. What matters is the order of operations: apply the
 * items of a page, THEN store its `nextCursor`. If the process dies in between, the next run gets
 * the same page again — harmless, because applying a snapshot by `id` is idempotent.
 */
export class StateStore {
  private state: PersistedState = emptyState();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
  }

  async load(): Promise<void> {
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PersistedState>;
      // A state file of an earlier version has no directory yet.
      this.state = { ...emptyState(), ...loaded, directory: { ...emptyState().directory, ...loaded.directory } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get cursor(): string | null {
    return this.state.cursor;
  }

  /** Stores the work order snapshot unless we already hold a newer one (feeds are at-least-once). */
  upsert(workOrder: WorkOrder, changedAt: string): void {
    const key = String(workOrder.id);
    const known = this.state.workOrders[key];
    if (known && known.changedAt > changedAt) return;
    this.state.workOrders[key] = { workOrder, changedAt, receivedAt: new Date().toISOString() };
  }

  list(): TrackedWorkOrder[] {
    return Object.values(this.state.workOrders).sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  }

  rememberCustomer(customer: Customer): void {
    this.state.directory.customers[customer.reference] = customer;
  }

  rememberServiceLocation(location: ServiceLocation): void {
    this.state.directory.serviceLocations[location.reference] = location;
  }

  rememberEquipment(unit: Equipment): void {
    if (unit.serialNumber) this.state.directory.equipment[unit.serialNumber] = unit;
  }

  get directory(): Directory {
    return this.state.directory;
  }

  /** Persists the cursor together with everything applied so far (write-then-rename). */
  async commit(cursor: string): Promise<void> {
    this.state.cursor = cursor;
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await rename(temp, this.file);
  }
}
