import type {
  ChangePage,
  CreateWorkOrderRequest,
  Customer,
  Equipment,
  EquipmentList,
  KeyInfo,
  Problem,
  ProblemDetails,
  ProblemPage,
  RegisterCustomerRequest,
  RegisterEquipmentRequest,
  RegisterServiceLocationRequest,
  ServiceLocation,
  WorkOrder,
  WorkOrderBatch,
} from './types.js';

/** An error response of the FixFlow API, with its problem details. */
export class FixFlowApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(`FixFlow API ${status}: ${problem.detail ?? problem.title ?? 'request failed'}`);
    this.name = 'FixFlowApiError';
  }

  /** Field validation errors of a `422`, keyed by JSON path (e.g. `customer.name`). */
  get fieldErrors(): Record<string, string[]> {
    return this.problem.errors ?? {};
  }
}

export interface FixFlowClientOptions {
  /** API base of your FixFlow deployment, including `/fixflow` — e.g. `https://host/fixflow`. */
  baseUrl: string;
  /** Your Manufacturer API key (`ffmfr_…`). Keep it server-side. */
  apiKey: string;
  /** How many times a `429` is retried after its `Retry-After`. Default 3. */
  maxRetries?: number;
  /** Upper bound for a single `Retry-After` wait, in seconds. Default 60. */
  maxRetryAfterSeconds?: number;
  /** Per-request timeout in milliseconds. Default 15 000. */
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Result of a create call: `replayed` is true when the externalReference was already known (`200`). */
export interface CreateResult {
  workOrder: WorkOrder;
  replayed: boolean;
}

/**
 * Result of a registration: `replayed` is true when the key was already registered (`200`) — then
 * `resource` is what FixFlow has stored, unchanged; the body of the repeat was ignored.
 */
export interface RegisterResult<T> {
  resource: T;
  replayed: boolean;
}

/** Filters of `GET /problems`. */
export interface ProblemQuery {
  /** Exact equipment-type name, case-insensitive. */
  equipmentType?: string;
  /** Substring of the problem name or code, case-insensitive. */
  search?: string;
}

/**
 * A small, dependency-free client for the FixFlow Manufacturer API v1.
 *
 * - Authentication: the `X-Api-Key` header on every call.
 * - Errors: non-2xx responses become {@link FixFlowApiError} with the RFC 9457 problem details.
 * - Rate limiting: a `429` is retried after its `Retry-After`, up to `maxRetries` times.
 */
export class FixFlowClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly maxRetryAfterSeconds: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FixFlowClientOptions) {
    this.baseUrl = `${options.baseUrl.replace(/\/+$/, '')}/manufacturer-api/v1`;
    this.apiKey = options.apiKey;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 60;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** `GET /key` — confirms the key works and shows the manufacturer it is bound to. */
  verifyKey(): Promise<KeyInfo> {
    return this.request<KeyInfo>('GET', '/key').then((r) => r.body);
  }

  // ── Your directory ─────────────────────────────────────────────────────────────────────────
  // Registration is find-or-create and idempotent on YOUR key: the first call answers `201`, a repeat
  // `200` with the stored row unchanged. Nothing here ever updates or deletes a FixFlow row.

  /** `POST /customers` — register an end customer under your own reference. */
  registerCustomer(request: RegisterCustomerRequest): Promise<RegisterResult<Customer>> {
    return this.register<Customer>('/customers', request);
  }

  /** `GET /customers/{reference}`. `null` when you have not registered that reference. */
  getCustomer(reference: string): Promise<Customer | null> {
    return this.orNullOn404(this.request<Customer>('GET', `/customers/${encodeURIComponent(reference)}`));
  }

  /** `POST /service-locations` — register a site of a customer you registered before. */
  registerServiceLocation(request: RegisterServiceLocationRequest): Promise<RegisterResult<ServiceLocation>> {
    return this.register<ServiceLocation>('/service-locations', request);
  }

  /** `GET /service-locations/{reference}`. `null` when you have not registered that reference. */
  getServiceLocation(reference: string): Promise<ServiceLocation | null> {
    return this.orNullOn404(
      this.request<ServiceLocation>('GET', `/service-locations/${encodeURIComponent(reference)}`),
    );
  }

  /**
   * `POST /equipment` — register one of your units at a registered site, keyed by its serial number.
   * If one of your units with that serial is at ANOTHER site, FixFlow answers `409` (thrown as a
   * {@link FixFlowApiError}) and changes nothing: moving a unit is done by FixFlow's dispatchers.
   */
  registerEquipment(request: RegisterEquipmentRequest): Promise<RegisterResult<Equipment>> {
    return this.register<Equipment>('/equipment', request);
  }

  /** `GET /equipment?serialNumber=…` — your units with that serial (normally one). */
  findEquipment(serialNumber: string): Promise<Equipment[]> {
    const params = new URLSearchParams({ serialNumber });
    return this.request<EquipmentList>('GET', `/equipment?${params}`).then((r) => r.body.items);
  }

  // ── Problem catalogue ──────────────────────────────────────────────────────────────────────

  /** `GET /problems` — one page of FixFlow's problem catalogue. */
  getProblems(query: ProblemQuery & { limit?: number; cursor?: string } = {}): Promise<ProblemPage> {
    const params = new URLSearchParams();
    if (query.equipmentType) params.set('equipmentType', query.equipmentType);
    if (query.search) params.set('search', query.search);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.request<ProblemPage>('GET', `/problems${suffix}`).then((r) => r.body);
  }

  /** The whole (filtered) catalogue: follows `nextCursor` until `hasMore` is false. */
  async getAllProblems(query: ProblemQuery = {}): Promise<Problem[]> {
    const all: Problem[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.getProblems({ ...query, limit: 500, cursor });
      all.push(...page.items);
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return all;
  }

  // ── Work orders ────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /work-orders`. The first call with an `externalReference` creates the work order (`201`);
   * any later call with the same value returns that same work order unchanged (`200`), so retrying a
   * timed-out request is always safe.
   */
  async createWorkOrder(request: CreateWorkOrderRequest): Promise<CreateResult> {
    const { resource, replayed } = await this.register<WorkOrder>('/work-orders', request);
    return { workOrder: resource, replayed };
  }

  /** `GET /work-orders/{id}`. Returns `null` for an unknown id or a work order you cannot see. */
  getWorkOrder(id: number): Promise<WorkOrder | null> {
    return this.orNullOn404(this.request<WorkOrder>('GET', `/work-orders/${encodeURIComponent(String(id))}`));
  }

  /** `GET /work-orders/by-reference/{externalReference}` — find one by YOUR claim number. */
  getWorkOrderByReference(externalReference: string): Promise<WorkOrder | null> {
    return this.orNullOn404(
      this.request<WorkOrder>('GET', `/work-orders/by-reference/${encodeURIComponent(externalReference)}`),
    );
  }

  /** `GET /work-orders?ids=…&references=…` — up to 100 ids and references in total. */
  getWorkOrders(query: { ids?: number[]; references?: string[] }): Promise<WorkOrderBatch> {
    const params = new URLSearchParams();
    if (query.ids?.length) params.set('ids', query.ids.join(','));
    if (query.references?.length) params.set('references', query.references.join(','));
    return this.request<WorkOrderBatch>('GET', `/work-orders?${params}`).then((r) => r.body);
  }

  /**
   * `GET /work-orders/changes`.
   * - no `cursor` and no `since`: subscribe from now — no items, just the current `nextCursor`;
   * - `cursor`: the next page after it;
   * - `since` (ISO time): replay history from that moment.
   */
  getChanges(query: { cursor?: string; limit?: number; since?: string } = {}): Promise<ChangePage> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.since) params.set('since', query.since);
    const suffix = params.size > 0 ? `?${params}` : '';
    return this.request<ChangePage>('GET', `/work-orders/changes${suffix}`).then((r) => r.body);
  }

  /** An idempotent create: `201` = new, `200` (+ `Idempotent-Replayed: true`) = the key was known. */
  private async register<T>(path: string, body: unknown): Promise<RegisterResult<T>> {
    const response = await this.request<T>('POST', path, body);
    return {
      resource: response.body,
      replayed: response.status === 200 || response.headers.get('idempotent-replayed') === 'true',
    };
  }

  private async orNullOn404<T>(pending: Promise<{ body: T }>): Promise<T | null> {
    try {
      return (await pending).body;
    } catch (error) {
      if (error instanceof FixFlowApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Headers; body: T }> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 429 && attempt < this.maxRetries) {
        await sleep(this.retryAfterMs(response));
        continue;
      }

      if (!response.ok) {
        throw new FixFlowApiError(response.status, await readProblem(response));
      }

      return { status: response.status, headers: response.headers, body: (await response.json()) as T };
    }
  }

  /** `Retry-After` in seconds (FixFlow sends delta-seconds), capped; 1 s when absent. */
  private retryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get('retry-after'));
    const bounded = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, this.maxRetryAfterSeconds) : 1;
    return bounded * 1000;
  }
}

async function readProblem(response: Response): Promise<ProblemDetails> {
  const text = await response.text();
  try {
    return JSON.parse(text) as ProblemDetails;
  } catch {
    return { status: response.status, title: response.statusText, detail: text || null };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
