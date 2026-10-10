import type { FixFlowClient } from '../fixflow/client.js';
import type { StateStore } from './state-store.js';

export interface PollResult {
  /** Work-order snapshots applied in this run. */
  applied: number;
  /** Feed pages read in this run. */
  pages: number;
  /** True when this run only subscribed (first start, no stored cursor). */
  subscribed: boolean;
}

export interface PollerStatus {
  running: boolean;
  cursor: string | null;
  lastPollAt: string | null;
  lastResult: PollResult | null;
  lastError: string | null;
}

export interface ChangeFeedPollerOptions {
  intervalMs: number;
  /** Page size, 1..500. FixFlow's default is 100. */
  limit?: number;
  /** Safety cap for one run; the rest is read on the next tick. */
  maxPagesPerRun?: number;
  log?: (message: string) => void;
}

/**
 * The polling loop FixFlow recommends:
 *
 * 1. First start: call `changes` without a cursor — that subscribes from now — and store `nextCursor`.
 * 2. Every 30–60 s: call `changes?cursor=<stored>`, apply the items, store the new `nextCursor`.
 * 3. While `hasMore` is true, call again straight away instead of waiting for the next tick.
 *
 * Delivery is at-least-once, so the same snapshot may arrive twice: apply it by work-order `id`.
 */
export class ChangeFeedPoller {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<PollResult> | undefined;
  private readonly status: PollerStatus;

  constructor(
    private readonly client: FixFlowClient,
    private readonly store: StateStore,
    private readonly options: ChangeFeedPollerOptions,
  ) {
    this.status = { running: false, cursor: store.cursor, lastPollAt: null, lastResult: null, lastError: null };
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    const tick = async () => {
      await this.pollOnce().catch(() => undefined);
      if (this.status.running) this.timer = setTimeout(tick, this.options.intervalMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.status.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
  }

  getStatus(): PollerStatus {
    return { ...this.status, cursor: this.store.cursor };
  }

  /** One run of the loop. Concurrent calls share the run in flight. */
  pollOnce(): Promise<PollResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<PollResult> {
    const log = this.options.log ?? (() => undefined);
    const limit = this.options.limit ?? 100;
    const maxPages = this.options.maxPagesPerRun ?? 20;
    this.status.lastPollAt = new Date().toISOString();

    try {
      let cursor = this.store.cursor;
      if (cursor === null) {
        const head = await this.client.getChanges();
        await this.store.commit(head.nextCursor);
        log('Subscribed to the change feed from now on.');
        return this.done({ applied: 0, pages: 1, subscribed: true });
      }

      let applied = 0;
      let pages = 0;
      for (; pages < maxPages; ) {
        const page = await this.client.getChanges({ cursor, limit });
        pages++;
        for (const item of page.items) {
          const { changedAt, ...workOrder } = item;
          this.store.upsert(workOrder, changedAt);
          applied++;
        }
        // Apply first, then move the cursor: a crash in between only replays this page.
        await this.store.commit(page.nextCursor);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }

      if (applied > 0) log(`Applied ${applied} work-order change(s) from ${pages} page(s).`);
      return this.done({ applied, pages, subscribed: false });
    } catch (error) {
      this.status.lastError = error instanceof Error ? error.message : String(error);
      log(`Polling failed: ${this.status.lastError}`);
      throw error;
    }
  }

  private done(result: PollResult): PollResult {
    this.status.lastResult = result;
    this.status.lastError = null;
    return result;
  }
}
