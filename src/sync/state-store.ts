import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkOrder } from '../fixflow/types.js';

/** A work order this client knows about, as last seen. */
export interface TrackedWorkOrder {
  workOrder: WorkOrder;
  /** When FixFlow says it last changed (`changedAt` of the feed), or when we created it. */
  changedAt: string;
  /** When this client last received it. */
  receivedAt: string;
}

interface PersistedState {
  /** The last `nextCursor` of the change feed. `null` = not subscribed yet. */
  cursor: string | null;
  workOrders: Record<string, TrackedWorkOrder>;
}

/**
 * The client's local state in one small JSON file: the feed cursor and the work orders seen.
 *
 * In a real integration this is your database. What matters is the order of operations: apply the
 * items of a page, THEN store its `nextCursor`. If the process dies in between, the next run gets
 * the same page again — harmless, because applying a snapshot by `id` is idempotent.
 */
export class StateStore {
  private state: PersistedState = { cursor: null, workOrders: {} };
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'state.json');
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as PersistedState;
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
