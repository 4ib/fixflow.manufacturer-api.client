import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { keysOnlyRequest, sampleRequest, startHarness, TEST_KEY, type Harness } from './helpers.js';

/**
 * Keeps the mock honest: every response it gives must match the published contract
 * (`contract/openapi.v1.json`, copied from FixFlow's public docs page), and a work-order resource
 * must carry exactly the properties the contract defines — no more, no fewer.
 */
const contract = JSON.parse(readFileSync(new URL('../contract/openapi.v1.json', import.meta.url), 'utf8'));
const schemas = contract.components.schemas as Record<string, { properties?: Record<string, unknown> }>;

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === '$ref' && typeof value === 'string' ? value.replace('#/components/schemas/', '#/$defs/') : rewriteRefs(value),
      ]),
    );
  }
  return node;
}

const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema({ $id: 'contract', $defs: rewriteRefs(schemas) });

function assertMatches(schemaName: string, value: unknown): void {
  const validate = ajv.getSchema(`contract#/$defs/${schemaName}`);
  assert.ok(validate, `schema ${schemaName} exists in the contract`);
  assert.ok(validate(value), `${schemaName}: ${JSON.stringify(validate.errors, null, 2)}`);
}

/** Matches the schema AND carries exactly the properties the contract defines — no more, no fewer. */
function assertResource(schemaName: string, value: object): void {
  assertMatches(schemaName, value);
  assert.deepEqual(
    Object.keys(value).sort(),
    Object.keys(schemas[schemaName]!.properties!).sort(),
    `${schemaName} has exactly the contract fields`,
  );
}

const trenton = { addressLine1: '125 West State Street', city: 'Trenton', state: 'NJ', zip: '08608' };

async function call(h: Harness, path: string, init: RequestInit = {}) {
  const response = await fetch(`${h.baseUrl}/manufacturer-api/v1${path}`, {
    ...init,
    headers: { 'X-Api-Key': TEST_KEY, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  // `any` on purpose: the point of these tests is to check the raw JSON against the contract.
  return { status: response.status, body: (await response.json()) as any };
}

describe('the mock follows the published contract', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('GET /key', async () => {
    const { status, body } = await call(h, '/key');
    assert.equal(status, 200);
    assertMatches('ManufacturerApiKeyInfo', body);
  });

  it('POST /work-orders — 201, 200 replay and 422', async () => {
    const request = sampleRequest({ problemId: 101 });
    const created = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(created.status, 201);
    assertResource('ManufacturerApiWorkOrder', created.body);
    assertResource('ManufacturerApiWorkOrderServiceLocation', created.body.serviceLocation);
    assertResource('ManufacturerApiWorkOrderProblem', created.body.problem);

    const replay = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(replay.status, 200);
    assertMatches('ManufacturerApiWorkOrder', replay.body);

    const keysOnly = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(keysOnlyRequest()) });
    assert.equal(keysOnly.status, 201);
    assertMatches('ManufacturerApiWorkOrder', keysOnly.body);

    const invalid = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify({}) });
    assert.equal(invalid.status, 422);
    assertMatches('ValidationProblemDetails', invalid.body);
  });

  it('POST and GET /customers', async () => {
    const created = await call(h, '/customers', {
      method: 'POST',
      body: JSON.stringify({ reference: 'C-CONTRACT', name: 'Northside Clinic', address: trenton }),
    });
    assert.equal(created.status, 201);
    assertResource('ManufacturerApiCustomer', created.body);
    const replay = await call(h, '/customers', { method: 'POST', body: JSON.stringify({ reference: 'C-CONTRACT', name: 'x' }) });
    assert.equal(replay.status, 200);
    assertResource('ManufacturerApiCustomer', replay.body);
    assertResource('ManufacturerApiCustomer', (await call(h, '/customers/C-CONTRACT')).body);

    const missing = await call(h, '/customers/NOT-MINE');
    assert.equal(missing.status, 404);
    assertMatches('ProblemDetails', missing.body);
    const invalid = await call(h, '/customers', { method: 'POST', body: JSON.stringify({ address: {} }) });
    assert.equal(invalid.status, 422);
    assertMatches('ValidationProblemDetails', invalid.body);
  });

  it('POST and GET /service-locations', async () => {
    await call(h, '/customers', { method: 'POST', body: JSON.stringify({ reference: 'C-SITE', name: 'Eastside Bakery' }) });
    const created = await call(h, '/service-locations', {
      method: 'POST',
      body: JSON.stringify({ reference: 'S-CONTRACT', customerReference: 'C-SITE', ...trenton, name: 'Bakery' }),
    });
    assert.equal(created.status, 201);
    assertResource('ManufacturerApiServiceLocation', created.body);
    assertResource('ManufacturerApiServiceLocationCustomer', created.body.customer);
    assertResource('ManufacturerApiServiceLocation', (await call(h, '/service-locations/S-CONTRACT')).body);
    assertMatches('ProblemDetails', (await call(h, '/service-locations/NOT-MINE')).body);

    const noCustomer = await call(h, '/service-locations', {
      method: 'POST',
      body: JSON.stringify({ reference: 'S-X', customerReference: 'NOPE', ...trenton }),
    });
    assert.equal(noCustomer.status, 422);
    assertMatches('ValidationProblemDetails', noCustomer.body);
  });

  it('POST and GET /equipment', async () => {
    const created = await call(h, '/equipment', {
      method: 'POST',
      body: JSON.stringify({ serviceLocationReference: 'S-CONTRACT', serialNumber: 'SN-CONTRACT', modelNumber: 'AC-200' }),
    });
    assert.equal(created.status, 201);
    assertResource('ManufacturerApiEquipment', created.body);
    assertResource('ManufacturerApiEquipmentServiceLocation', created.body.serviceLocation);

    const list = await call(h, '/equipment?serialNumber=SN-CONTRACT');
    assertResource('ManufacturerApiEquipmentList', list.body);
    assert.equal(list.body.items.length, 1);

    const conflict = await call(h, '/equipment', {
      method: 'POST',
      body: JSON.stringify({ serviceLocationReference: 'SITE-4471', serialNumber: 'SN-CONTRACT', modelNumber: 'AC-200' }),
    });
    assert.equal(conflict.status, 409);
    assertMatches('ProblemDetails', conflict.body);

    const noSerial = await call(h, '/equipment');
    assert.equal(noSerial.status, 422);
    assertMatches('ValidationProblemDetails', noSerial.body);
  });

  it('GET /problems', async () => {
    const page = await call(h, '/problems?limit=2');
    assertResource('ManufacturerApiProblemPage', page.body);
    assertResource('ManufacturerApiProblem', page.body.items[0]);
    assert.equal(page.body.hasMore, true);
    const last = await call(h, '/problems?limit=500');
    assertMatches('ManufacturerApiProblemPage', last.body);
    assert.equal(last.body.nextCursor, null);
    const invalid = await call(h, '/problems?cursor=nope');
    assert.equal(invalid.status, 422);
    assertMatches('ValidationProblemDetails', invalid.body);
  });

  it('reads, batch and the change feed', async () => {
    const created = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(sampleRequest()) });
    const id = created.body.id as number;

    assertMatches('ManufacturerApiWorkOrder', (await call(h, `/work-orders/${id}`)).body);
    assertMatches('ProblemDetails', (await call(h, '/work-orders/999999')).body);
    assertMatches('ManufacturerApiWorkOrderBatch', (await call(h, `/work-orders?ids=${id},999999`)).body);

    const head = await call(h, '/work-orders/changes');
    assertMatches('ManufacturerApiWorkOrderChangePage', head.body);
    h.mock.advanceAll();
    h.advanceClock(6_000);
    const page = await call(h, `/work-orders/changes?cursor=${head.body.nextCursor}`);
    assert.equal(page.body.items.length > 0, true);
    assertMatches('ManufacturerApiWorkOrderChangePage', page.body);
  });

  it('401 without a key', async () => {
    const response = await fetch(`${h.baseUrl}/manufacturer-api/v1/key`);
    assert.equal(response.status, 401);
    assertMatches('ProblemDetails', await response.json());
  });
});
