import { existsSync } from 'node:fs';
import path from 'node:path';

/** The key the built-in mock accepts. It only works against the mock. */
export const MOCK_API_KEY = 'ffmfr_mock_demo_key';

export interface Config {
  /** `mock` when no FixFlow host/key is configured. */
  mode: 'live' | 'mock';
  /** API base including `/fixflow`. In mock mode it points at the in-process mock. */
  baseUrl: string;
  apiKey: string;
  port: number;
  host: string;
  pollIntervalMs: number;
  dataDir: string;
  mockPort: number;
  mockStepSeconds: number;
}

/** Reads `.env` (if present) and the environment. Live mode needs BOTH the base URL and the key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const baseUrl = env.FIXFLOW_BASE_URL?.trim() ?? '';
  const apiKey = env.FIXFLOW_API_KEY?.trim() ?? '';
  const live = baseUrl !== '' && apiKey !== '';
  const mockPort = toInt(env.MOCK_PORT, 4010);

  return {
    mode: live ? 'live' : 'mock',
    baseUrl: live ? baseUrl : `http://127.0.0.1:${mockPort}/fixflow`,
    apiKey: live ? apiKey : MOCK_API_KEY,
    port: toInt(env.PORT, 3000),
    host: env.HOST?.trim() || '127.0.0.1',
    pollIntervalMs: toInt(env.POLL_INTERVAL_SECONDS, 30) * 1000,
    dataDir: path.resolve(env.DATA_DIR?.trim() || './data', live ? 'live' : 'mock'),
    mockPort,
    mockStepSeconds: toInt(env.MOCK_STEP_SECONDS, 15),
  };
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
