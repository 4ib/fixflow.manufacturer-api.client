import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { sampleRequest, startHarness, TEST_KEY, type Harness } from './helpers.js';

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
    const request = sampleRequest();
    const created = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(created.status, 201);
    assertMatches('ManufacturerApiWorkOrder', created.body);
    assert.deepEqual(
      Object.keys(created.body).sort(),
      Object.keys(schemas.ManufacturerApiWorkOrder!.properties!).sort(),
      'the resource has exactly the contract fields',
    );

    const replay = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify(request) });
    assert.equal(replay.status, 200);
    assertMatches('ManufacturerApiWorkOrder', replay.body);

    const invalid = await call(h, '/work-orders', { method: 'POST', body: JSON.stringify({}) });
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
