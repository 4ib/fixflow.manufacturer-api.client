import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { FixFlowApiError, type FixFlowClient } from '../fixflow/client.js';
import type { CreateWorkOrderRequest } from '../fixflow/types.js';
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

  // Work orders this client knows about: created here or seen in the change feed.
  app.get('/api/work-orders', async () => deps.store.list());

  app.post('/api/work-orders', async (request, reply) => {
    try {
      const result = await deps.client.createWorkOrder(request.body as CreateWorkOrderRequest);
      // Track it right away: creating a work order is not a change-feed event, its later changes are.
      deps.store.upsert(result.workOrder, result.workOrder.createdAt);
      await deps.store.save();
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.get('/api/lookup', async (request, reply) => {
    const { id, reference } = request.query as { id?: string; reference?: string };
    try {
      const workOrder = id
        ? await deps.client.getWorkOrder(Number(id))
        : reference
          ? await deps.client.getWorkOrderByReference(reference)
          : null;
      return workOrder ? { workOrder } : reply.code(404).send({ title: 'Not found', detail: 'No visible work order matches.' });
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

/** Passes FixFlow's problem details through, so the UI can show field errors of a `422`. */
function sendApiError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FixFlowApiError) return reply.code(error.status).send(error.problem);
  const detail = error instanceof Error ? error.message : String(error);
  return reply.code(502).send({ title: 'FixFlow is not reachable', status: 502, detail });
}
