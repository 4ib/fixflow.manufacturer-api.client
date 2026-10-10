import { MOCK_API_KEY } from '../config.js';
import { createMockApi } from './mock-api.js';

// Runs only the mock, e.g. to point your own client at it:
//   FIXFLOW_BASE_URL=http://127.0.0.1:4010/fixflow  FIXFLOW_API_KEY=ffmfr_mock_demo_key
const port = Number(process.env.MOCK_PORT ?? 4010);
const { app } = createMockApi({ apiKey: MOCK_API_KEY, stepSeconds: Number(process.env.MOCK_STEP_SECONDS ?? 15) });
await app.listen({ port, host: '127.0.0.1' });
console.log(`Mock FixFlow Manufacturer API on http://127.0.0.1:${port}/fixflow (key: ${MOCK_API_KEY})`);
