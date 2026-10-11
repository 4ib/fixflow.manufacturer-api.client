import type { AddressInfo } from 'node:net';
import { loadConfig, MOCK_API_KEY } from './config.js';
import { FixFlowApiError, FixFlowClient } from './fixflow/client.js';
import { createMockApi } from './mock/mock-api.js';

/**
 * The recommended integration flow, step by step, printing every call:
 *
 *   npm run walkthrough            against a fresh in-process mock
 *   npm run walkthrough -- --live  against FIXFLOW_BASE_URL with FIXFLOW_API_KEY
 *
 * `--live` creates REAL records in that FixFlow (a customer, a site, a unit and a work order a
 * dispatcher will see), so point it at a test environment. The keys below are fixed on purpose:
 * run it twice and the second run shows every registration answering `200` — idempotency at work.
 */
const keys = {
  customer: 'WALKTHROUGH-CUSTOMER-1',
  site: 'WALKTHROUGH-SITE-1',
  serial: 'WALKTHROUGH-SN-0001',
};

const config = loadConfig();
const live = process.argv.includes('--live');
if (config.mode === 'live' && !live) {
  console.error('FIXFLOW_BASE_URL and FIXFLOW_API_KEY are set. Add --live to run against that FixFlow (it creates real records).');
  process.exit(1);
}
if (live && config.mode !== 'live') {
  console.error('--live needs FIXFLOW_BASE_URL and FIXFLOW_API_KEY.');
  process.exit(1);
}

let baseUrl = config.baseUrl;
let apiKey = config.apiKey;
let stopMock = async () => {};
if (!live) {
  const mock = createMockApi({ apiKey: MOCK_API_KEY, simulate: false, lagSeconds: 0 });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(mock.app.server.address() as AddressInfo).port}/fixflow`;
  apiKey = MOCK_API_KEY;
  stopMock = () => mock.app.close();
}

const client = new FixFlowClient({ baseUrl, apiKey });
const step = (call: string, outcome: string) => console.log(`✔ ${call.padEnd(44)} ${outcome}`);
const registered = (replayed: boolean) => (replayed ? '200 already registered' : '201 registered');

try {
  console.log(`FixFlow Manufacturer API walkthrough — ${live ? `LIVE ${baseUrl}` : 'built-in mock'}\n`);

  // 1. The key: which manufacturer is it bound to?
  const info = await client.verifyKey();
  step('GET /key', `${info.manufacturer.name} (key ${info.key.prefix}…)`);

  // 2. Register the directory under your own keys — once. Repeats are harmless.
  const address = { addressLine1: '125 West State Street', city: 'Trenton', state: 'NJ', zip: '08608' };
  const customer = await client.registerCustomer({ reference: keys.customer, name: 'Walkthrough Dental', address });
  step('POST /customers', `${registered(customer.replayed)} → FixFlow #${customer.resource.id}`);
  const site = await client.registerServiceLocation({ reference: keys.site, customerReference: keys.customer, name: 'Walkthrough office', ...address });
  step('POST /service-locations', `${registered(site.replayed)} → FixFlow #${site.resource.id}`);
  const unit = await client.registerEquipment({ serviceLocationReference: keys.site, serialNumber: keys.serial, modelNumber: 'AC-200' });
  step('POST /equipment', `${registered(unit.replayed)} → FixFlow #${unit.resource.id}`);
  const again = await client.registerCustomer({ reference: keys.customer, name: 'A changed name is ignored' });
  step('POST /customers (repeat)', `${again.replayed ? 200 : 201}, stored name "${again.resource.name}"`);

  // 3. Optionally classify the fault with the problem catalogue.
  const problems = await client.getProblems({ limit: 5 });
  const problem = problems.items[0];
  step('GET /problems?limit=5', `${problems.items.length} item(s)${problem ? `, using "${problem.name}"` : ''}`);

  // 4. Create work orders with your keys only. The claim number is the idempotency key.
  const externalReference = `WALK-${Date.now().toString(36).toUpperCase()}`;
  const request = {
    externalReference,
    customer: { reference: keys.customer },
    serviceLocation: { reference: keys.site },
    equipment: { serialNumber: keys.serial },
    description: 'Walkthrough: unit reports error E-14.',
    problemId: problem?.id,
  };
  const created = await client.createWorkOrder(request);
  step('POST /work-orders', `${created.replayed ? 200 : 201} → ${created.workOrder.number}, status ${created.workOrder.status}`);
  const repeat = await client.createWorkOrder(request);
  step('POST /work-orders (repeat)', `${repeat.replayed ? '200 replayed' : '201 ?!'} → ${repeat.workOrder.number}`);

  // 5. Read it back by YOUR claim number, and subscribe to the change feed.
  const read = await client.getWorkOrderByReference(externalReference);
  step(`GET /work-orders/by-reference/${externalReference}`.slice(0, 44), `${read?.number} at site ${read?.serviceLocation?.reference}`);
  const head = await client.getChanges();
  step('GET /work-orders/changes', `subscribed; store nextCursor ${head.nextCursor}`);

  console.log('\nDone. Poll /work-orders/changes?cursor=<stored> every 30–60 s from here on.');
} catch (error) {
  if (error instanceof FixFlowApiError) {
    console.error(`\n✖ ${error.message}`);
    if (Object.keys(error.fieldErrors).length > 0) console.error(error.fieldErrors);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await stopMock();
}
