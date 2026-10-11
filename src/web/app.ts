import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { FixFlowApiError, type FixFlowClient } from '../fixflow/client.js';
import type {
  CreateWorkOrderRequest,
  Problem,
  RegisterCustomerRequest,
  RegisterEquipmentRequest,
  RegisterServiceLocationRequest,
} from '../fixflow/types.js';
import type { ChangeFeedPoller } from '../sync/poller.js';
import type { StateStore } from '../sync/state-store.js';

export interface WebAppDeps {
  client: FixFlowClient;
  store: StateStore;
  poller: ChangeFeedPoller;
  mode: 'live' | 'mock';
  /** Shown in the UI. Never the key. */
  baseUrl: string;
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

type LookupKind = 'work-order' | 'claim' | 'customer' | 'site' | 'serial';

/**
 * The demo's own small backend. The browser only ever talks to these `/api/*` routes; this server
 * calls FixFlow with the key. Never send the API key to a browser: anyone could read it there.
 */
export async function createWebApp(deps: WebAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyStatic, { root: publicDir });

  // The key check is cached for a minute: the UI refreshes its status often, and every call to
  // FixFlow counts against the per-key rate limit.
  let keyCheck: { at: number; key: unknown; keyError: string | null } | undefined;
  app.get('/api/status', async () => {
    if (!keyCheck || Date.now() - keyCheck.at > 60_000) {
      try {
        keyCheck = { at: Date.now(), key: await deps.client.verifyKey(), keyError: null };
      } catch (error) {
        keyCheck = { at: Date.now(), key: null, keyError: error instanceof Error ? error.message : String(error) };
      }
    }
    return { mode: deps.mode, baseUrl: deps.baseUrl, key: keyCheck.key, keyError: keyCheck.keyError, poller: deps.poller.getStatus() };
  });

  // ── your directory ───────────────────────────────────────────────────────────────────────
  app.get('/api/directory', async () => deps.store.directory);

  app.post('/api/directory/customers', (request, reply) =>
    relay(reply, async () => {
      const result = await deps.client.registerCustomer(request.body as RegisterCustomerRequest);
      deps.store.rememberCustomer(result.resource);
      await deps.store.save();
      return result;
    }));

  app.post('/api/directory/service-locations', (request, reply) =>
    relay(reply, async () => {
      const result = await deps.client.registerServiceLocation(request.body as RegisterServiceLocationRequest);
      deps.store.rememberServiceLocation(result.resource);
      await deps.store.save();
      return result;
    }));

  app.post('/api/directory/equipment', (request, reply) =>
    relay(reply, async () => {
      const result = await deps.client.registerEquipment(request.body as RegisterEquipmentRequest);
      deps.store.rememberEquipment(result.resource);
      await deps.store.save();
      return result;
    }));

  // The catalogue changes rarely: read it once (all pages) and keep it for five minutes.
  let problems: { at: number; items: Problem[] } | undefined;
  app.get('/api/problems', (_request, reply) =>
    relay(reply, async () => {
      if (!problems || Date.now() - problems.at > 5 * 60_000) {
        problems = { at: Date.now(), items: await deps.client.getAllProblems() };
      }
      return { items: problems.items };
    }, 200));

  // ── work orders ──────────────────────────────────────────────────────────────────────────
  // Work orders this client knows about: created here or seen in the change feed.
  app.get('/api/work-orders', async () => deps.store.list());

  app.post('/api/work-orders', (request, reply) =>
    relay(reply, async () => {
      const result = await deps.client.createWorkOrder(request.body as CreateWorkOrderRequest);
      // Track it right away: creating a work order is not a change-feed event, its later changes are.
      deps.store.upsert(result.workOrder, result.workOrder.createdAt);
      await deps.store.save();
      return { resource: result.workOrder, replayed: result.replayed };
    }));

  app.get('/api/lookup', async (request, reply) => {
    const { kind, value } = request.query as { kind?: LookupKind; value?: string };
    const query = value?.trim();
    if (!query) return reply.code(400).send({ title: 'Nothing to look up', detail: 'Enter a value.' });
    try {
      const found = await lookup(deps.client, kind ?? 'work-order', query);
      return found === null || (Array.isArray(found) && found.length === 0)
        ? reply.code(404).send({ title: 'Not found', detail: 'Nothing of yours matches.' })
        : { found };
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post('/api/poll', async (_request, reply) => {
    try {
      return await deps.poller.pollOnce();
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  return app;
}

function lookup(client: FixFlowClient, kind: LookupKind, value: string): Promise<unknown> {
  switch (kind) {
    case 'claim':
      return client.getWorkOrderByReference(value);
    case 'customer':
      return client.getCustomer(value);
    case 'site':
      return client.getServiceLocation(value);
    case 'serial':
      return client.findEquipment(value);
    default:
      return Number.isInteger(Number(value)) ? client.getWorkOrder(Number(value)) : Promise.resolve(null);
  }
}

/**
 * Runs a FixFlow call and answers with FixFlow's own status: `201` for something new, `200` for an
 * idempotent replay, the problem details of an error (so the UI can show the field errors of a `422`).
 */
async function relay(
  reply: FastifyReply,
  call: () => Promise<object>,
  status?: number,
): Promise<FastifyReply> {
  try {
    const result = await call();
    const replayed = 'replayed' in result && result.replayed === true;
    return reply.code(status ?? (replayed ? 200 : 201)).send(result);
  } catch (error) {
    return sendApiError(reply, error);
  }
}

/** Passes FixFlow's problem details through, so the UI can show field errors of a `422`. */
function sendApiError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FixFlowApiError) return reply.code(error.status).send(error.problem);
  const detail = error instanceof Error ? error.message : String(error);
  return reply.code(502).send({ title: 'FixFlow is not reachable', status: 502, detail });
}
