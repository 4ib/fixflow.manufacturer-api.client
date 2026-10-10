import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type {
  ChangePage,
  CreateWorkOrderRequest,
  KeyInfo,
  ProblemDetails,
  Urgency,
  WorkOrder,
  WorkOrderStatus,
} from '../fixflow/types.js';
import { URGENCIES } from '../fixflow/types.js';

/**
 * An in-memory mock of the FixFlow Manufacturer API v1, so the demo runs without a key.
 *
 * It follows the published contract (`contract/openapi.v1.json`, checked by `test/contract.test.ts`)
 * and its documented behaviour:
 * - `X-Api-Key` auth (`401`), a per-key rate limit (`429` + `Retry-After`);
 * - create with `externalReference` idempotency (`201`, then `200` + `Idempotent-Replayed: true`),
 *   `422` with field errors;
 * - single, by-reference and batch reads (`notFound`);
 * - the change feed: opaque cursor, current snapshots coalesced per work order, a 5 s lag,
 *   `since`. Creating a work order is not a feed event — its later changes are.
 *
 * A simulator moves every open work order one status forward every `stepSeconds`, so the
 * change feed has something to show.
 */
export interface MockApiOptions {
  apiKey: string;
  stepSeconds?: number;
  lagSeconds?: number;
  rateLimitPerMinute?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Start the status simulator (default true). Tests drive it with `advanceAll()`. */
  simulate?: boolean;
}

export interface MockApi {
  app: FastifyInstance;
  /** Moves every open work order one status forward (what the simulator does on each step). */
  advanceAll(): void;
}

const ROUTE = '/fixflow/manufacturer-api/v1';
const LIFECYCLE: WorkOrderStatus[] = ['New', 'Dispatched', 'Assigned', 'EnRoute', 'OnSite', 'Working', 'Done'];
const MANUFACTURER = { id: 7, name: 'Demo Manufacturer' };

interface JournalEntry {
  id: number;
  workOrderId: number;
  changedAt: number;
}

export function createMockApi(options: MockApiOptions): MockApi {
  const now = options.now ?? Date.now;
  const lagMs = (options.lagSeconds ?? 5) * 1000;
  const rateLimit = options.rateLimitPerMinute ?? 120;
  const keyCreatedAt = new Date(now()).toISOString();

  const workOrders = new Map<number, WorkOrder>();
  const byReference = new Map<string, number>();
  const customerByReference = new Map<string, number>();
  const journal: JournalEntry[] = [];
  const hits: number[] = [];
  let nextWorkOrderId = 10_001;
  let nextEntityId = 501;
  let nextJournalId = 1;
  let lastUsedAt: string | null = null;

  const app = Fastify({ logger: false });

  // ── realm: key + rate limit ──────────────────────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(ROUTE)) return;
    if (request.headers['x-api-key'] !== options.apiKey) {
      return problem(reply, 401, 'Unauthorized', 'A valid API key is required.');
    }
    const t = now();
    while (hits.length > 0 && hits[0]! <= t - 60_000) hits.shift();
    if (hits.length >= rateLimit) {
      const retryAfter = Math.max(1, Math.ceil((hits[0]! + 60_000 - t) / 1000));
      reply.header('Retry-After', String(retryAfter));
      return problem(reply, 429, 'Too many requests', `Rate limit of ${rateLimit} requests per minute exceeded.`);
    }
    hits.push(t);
    lastUsedAt = new Date(t).toISOString();
  });

  app.get(`${ROUTE}/key`, async (): Promise<KeyInfo> => ({
    manufacturer: MANUFACTURER,
    key: { name: 'Mock key', prefix: options.apiKey.slice(0, 12), createdAt: keyCreatedAt, lastUsedAt },
  }));

  // ── create ───────────────────────────────────────────────────────────────────────────────
  app.post(`${ROUTE}/work-orders`, async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    const errors = validate(request.body);
    if (Object.keys(errors).length > 0) {
      return reply
        .code(422)
        .type('application/problem+json')
        .send({
          type: 'https://tools.ietf.org/html/rfc4918#section-11.2',
          title: 'One or more validation errors occurred.',
          status: 422,
          errors,
        } satisfies ProblemDetails);
    }

    const body = request.body as CreateWorkOrderRequest;
    const reference = body.externalReference.trim();
    const existing = byReference.get(reference);
    if (existing !== undefined) {
      return reply.code(200).header('Idempotent-Replayed', 'true').send(workOrders.get(existing));
    }

    const id = nextWorkOrderId++;
    const customerRef = body.customer.reference?.trim() || null;
    let customerId = customerRef ? customerByReference.get(customerRef) : undefined;
    if (customerId === undefined) {
      customerId = nextEntityId++;
      if (customerRef) customerByReference.set(customerRef, customerId);
    }
    const location = body.serviceLocation;
    const workOrder: WorkOrder = {
      id,
      number: `WO-${id}`,
      externalReference: reference,
      status: 'New',
      urgency: (body.urgency as Urgency | null | undefined) ?? 'Normal',
      customer: { id: customerId, name: body.customer.name.trim(), reference: customerRef },
      serviceLocation: {
        id: nextEntityId++,
        name: location.name?.trim() || location.addressLine1.trim(),
        addressLine1: location.addressLine1.trim(),
        addressLine2: location.addressLine2?.trim() || null,
        city: location.city.trim(),
        state: location.state.trim(),
        zip: location.zip.trim(),
      },
      equipment: {
        id: nextEntityId++,
        serialNumber: body.equipment.serialNumber?.trim() || null,
        modelNumber: body.equipment.modelNumber.trim(),
      },
      description: body.description.trim(),
      isWarranty: body.isWarranty ?? false,
      warrantyNumber: body.warrantyReference?.trim() || null,
      createdAt: new Date(now()).toISOString(),
      deadline: body.deadline ?? null,
      scheduledServiceAt: null,
      dispatchedAt: null,
      vendorAcceptedAt: null,
      assignedAt: null,
      enRouteAt: null,
      onSiteAt: null,
      workingAt: null,
      completedAt: null,
      archivedAt: null,
    };
    workOrders.set(id, workOrder);
    byReference.set(reference, id);
    return reply.code(201).header('Location', `${ROUTE}/work-orders/${id}`).send(workOrder);
  });

  // ── reads ────────────────────────────────────────────────────────────────────────────────
  app.get(`${ROUTE}/work-orders/changes`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const { cursor, limit: rawLimit, since } = request.query;
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return validationProblem(reply, { limit: ['The limit must be between 1 and 500.'] });
    }

    const servable = servableEntries();
    const head = servable.at(-1)?.id ?? 0;

    let after: number;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded === null) return validationProblem(reply, { cursor: ['The cursor is not valid.'] });
      after = decoded;
    } else if (since !== undefined) {
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) return validationProblem(reply, { since: ['The since value is not a valid ISO 8601 time.'] });
      const first = servable.find((e) => e.changedAt >= sinceMs);
      after = first ? first.id - 1 : head;
    } else {
      return { items: [], nextCursor: encodeCursor(head), hasMore: false } satisfies ChangePage;
    }

    const selected: number[] = [];
    const changedAt = new Map<number, number>();
    let position = after;
    let reachedLimit = false;
    for (const entry of servable) {
      if (entry.id <= after) continue;
      const known = changedAt.has(entry.workOrderId);
      if (!known && selected.length >= limit) {
        reachedLimit = true;
        break;
      }
      position = entry.id;
      if (!known) selected.push(entry.workOrderId);
      changedAt.set(entry.workOrderId, Math.max(entry.changedAt, changedAt.get(entry.workOrderId) ?? 0));
    }

    return {
      items: selected.map((id) => ({ ...workOrders.get(id)!, changedAt: new Date(changedAt.get(id)!).toISOString() })),
      nextCursor: encodeCursor(position),
      hasMore: reachedLimit || servable.some((e) => e.id > position),
    } satisfies ChangePage;
  });

  app.get(`${ROUTE}/work-orders/by-reference/:reference`, async (request: FastifyRequest<{ Params: { reference: string } }>, reply) => {
    const id = byReference.get(request.params.reference);
    return id === undefined ? notFound(reply) : workOrders.get(id);
  });

  app.get(`${ROUTE}/work-orders/:id`, async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const workOrder = workOrders.get(Number(request.params.id));
    return workOrder ?? notFound(reply);
  });

  app.get(`${ROUTE}/work-orders`, async (request: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const ids = splitList(request.query.ids).map(Number);
    const references = splitList(request.query.references);
    if (ids.some((id) => !Number.isInteger(id))) return validationProblem(reply, { ids: ['Every id must be an integer.'] });
    if (ids.length + references.length > 100) {
      return validationProblem(reply, { ids: ['At most 100 ids and references in total.'] });
    }
    const items: WorkOrder[] = [];
    const notFound = { ids: [] as number[], references: [] as string[] };
    for (const id of new Set(ids)) {
      const workOrder = workOrders.get(id);
      if (workOrder) items.push(workOrder);
      else notFound.ids.push(id);
    }
    for (const reference of new Set(references)) {
      const id = byReference.get(reference);
      if (id === undefined) notFound.references.push(reference);
      else if (!items.some((w) => w.id === id)) items.push(workOrders.get(id)!);
    }
    return { items, notFound };
  });

  // ── simulator ────────────────────────────────────────────────────────────────────────────
  function advanceAll(): void {
    const t = now();
    const iso = new Date(t).toISOString();
    for (const workOrder of workOrders.values()) {
      const index = LIFECYCLE.indexOf(workOrder.status);
      if (index < 0 || index === LIFECYCLE.length - 1) continue;
      const next = LIFECYCLE[index + 1]!;
      workOrder.status = next;
      if (next === 'Dispatched') workOrder.dispatchedAt = iso;
      if (next === 'Assigned') {
        workOrder.vendorAcceptedAt = iso;
        workOrder.assignedAt = iso;
        workOrder.scheduledServiceAt = new Date(t + 24 * 3600 * 1000).toISOString();
      }
      if (next === 'EnRoute') workOrder.enRouteAt = iso;
      if (next === 'OnSite') workOrder.onSiteAt = iso;
      if (next === 'Working') workOrder.workingAt = iso;
      if (next === 'Done') workOrder.completedAt = iso;
      journal.push({ id: nextJournalId++, workOrderId: workOrder.id, changedAt: t });
    }
  }

  if (options.simulate ?? true) {
    const timer = setInterval(advanceAll, (options.stepSeconds ?? 15) * 1000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  /** Entries old enough to serve: older than the lag AND below the first entry still inside it. */
  function servableEntries(): JournalEntry[] {
    const ceiling = now() - lagMs;
    const firstYoung = journal.find((e) => e.changedAt > ceiling);
    return journal.filter((e) => e.changedAt <= ceiling && (firstYoung === undefined || e.id < firstYoung.id));
  }

  return { app, advanceAll };
}

function validate(body: unknown): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  const b = (body ?? {}) as Partial<CreateWorkOrderRequest>;
  const required = (path: string, value: unknown, message: string) => {
    if (typeof value !== 'string' || value.trim() === '') errors[path] = [message];
  };
  required('externalReference', b.externalReference, 'External reference is required.');
  required('customer.name', b.customer?.name, 'Customer name is required.');
  required('serviceLocation.addressLine1', b.serviceLocation?.addressLine1, 'Address line 1 is required.');
  required('serviceLocation.city', b.serviceLocation?.city, 'City is required.');
  required('serviceLocation.state', b.serviceLocation?.state, 'State is required.');
  required('serviceLocation.zip', b.serviceLocation?.zip, 'ZIP is required.');
  required('equipment.modelNumber', b.equipment?.modelNumber, 'Model number is required.');
  required('description', b.description, 'Description is required.');
  if (b.urgency != null && !(URGENCIES as readonly string[]).includes(b.urgency)) {
    errors.urgency = [`Urgency must be one of ${URGENCIES.join(', ')}.`];
  }
  if (b.deadline != null && !/^\d{4}-\d{2}-\d{2}$/.test(b.deadline)) {
    errors.deadline = ['Deadline must be a date in the yyyy-MM-dd format.'];
  }
  return errors;
}

function encodeCursor(auditEntryId: number): string {
  return Buffer.from(`v1:${auditEntryId}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  const match = /^v1:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function problem(reply: FastifyReply, status: number, title: string, detail: string): FastifyReply {
  return reply.code(status).type('application/problem+json').send({ title, status, detail } satisfies ProblemDetails);
}

function notFound(reply: FastifyReply): FastifyReply {
  return problem(reply, 404, 'Not Found', 'The work order was not found.');
}

function validationProblem(reply: FastifyReply, errors: Record<string, string[]>): FastifyReply {
  return reply
    .code(422)
    .type('application/problem+json')
    .send({ title: 'One or more validation errors occurred.', status: 422, errors } satisfies ProblemDetails);
}
