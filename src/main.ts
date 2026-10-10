import { loadConfig } from './config.js';
import { FixFlowClient } from './fixflow/client.js';
import { createMockApi } from './mock/mock-api.js';
import { ChangeFeedPoller } from './sync/poller.js';
import { StateStore } from './sync/state-store.js';
import { createWebApp } from './web/app.js';

const config = loadConfig();
const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`);

const mock =
  config.mode === 'mock'
    ? createMockApi({ apiKey: config.apiKey, stepSeconds: config.mockStepSeconds })
    : undefined;
if (mock) {
  await mock.app.listen({ port: config.mockPort, host: '127.0.0.1' });
  log(`Mock FixFlow API on ${config.baseUrl} (no FIXFLOW_BASE_URL / FIXFLOW_API_KEY set).`);
} else {
  log(`Live mode against ${config.baseUrl}.`);
}

const client = new FixFlowClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
const store = new StateStore(config.dataDir);
await store.load();

const poller = new ChangeFeedPoller(client, store, { intervalMs: config.pollIntervalMs, log });
const web = await createWebApp({ client, store, poller, mode: config.mode, baseUrl: config.baseUrl });
await web.listen({ port: config.port, host: config.host });
log(`Demo UI on http://${config.host}:${config.port} — polling the change feed every ${config.pollIntervalMs / 1000}s.`);
poller.start();

const shutdown = async () => {
  await poller.stop();
  await web.close();
  await mock?.app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
