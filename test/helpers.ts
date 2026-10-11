import type { AddressInfo } from 'node:net';
import { FixFlowClient } from '../src/fixflow/client.js';
import type { CreateWorkOrderRequest } from '../src/fixflow/types.js';
import { createMockApi, type MockApi } from '../src/mock/mock-api.js';

export const TEST_KEY = 'ffmfr_test_key_123456';

export interface Harness {
  mock: MockApi;
  client: FixFlowClient;
  baseUrl: string;
  /** Moves the mock's clock forward. */
  advanceClock(ms: number): void;
  close(): Promise<void>;
}

/**
 * A mock FixFlow on a random port with a controllable clock and no background simulator. The
 * directory starts empty unless `seedDirectory` is set (then it has the dispatcher-made
 * "Riverside Dental" customer, its Trenton site and unit SN-77421).
 */
export async function startHarness(
  options: { rateLimitPerMinute?: number; seedDirectory?: boolean } = {},
): Promise<Harness> {
  let clock = Date.parse('2026-10-10T08:00:00Z');
  const mock = createMockApi({
    apiKey: TEST_KEY,
    now: () => clock,
    simulate: false,
    seedDirectory: options.seedDirectory ?? false,
    rateLimitPerMinute: options.rateLimitPerMinute ?? 1000,
  });
  await mock.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = mock.app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/fixflow`;
  return {
    mock,
    baseUrl,
    client: new FixFlowClient({ baseUrl, apiKey: TEST_KEY, maxRetries: 0 }),
    advanceClock: (ms) => {
      clock += ms;
    },
    close: () => mock.app.close(),
  };
}

/** A full create body: both keys plus everything a NEW customer, site and unit need. */
export function sampleRequest(overrides: Partial<CreateWorkOrderRequest> = {}): CreateWorkOrderRequest {
  return {
    externalReference: `CLM-${Math.random().toString(36).slice(2, 9)}`,
    customer: { reference: 'CUST-99812', name: 'Riverside Dental' },
    serviceLocation: {
      reference: 'SITE-4471',
      addressLine1: '125 West State Street',
      city: 'Trenton',
      state: 'NJ',
      zip: '08608',
    },
    equipment: { modelNumber: 'AC-200', serialNumber: 'SN-77421' },
    description: 'Unit shuts down after 10 minutes and reports error E-14.',
    ...overrides,
  };
}

/** A body that sends the keys and nothing else — valid once the keys are registered. */
export function keysOnlyRequest(overrides: Partial<CreateWorkOrderRequest> = {}): CreateWorkOrderRequest {
  return {
    externalReference: `CLM-${Math.random().toString(36).slice(2, 9)}`,
    customer: { reference: 'CUST-99812' },
    serviceLocation: { reference: 'SITE-4471' },
    equipment: { serialNumber: 'SN-77421' },
    description: 'Unit shuts down after 10 minutes and reports error E-14.',
    ...overrides,
  };
}
