/**
 * @jnpa/data — the single typed data adapter (prompt §5). The UI imports
 * `createAdapter()` and binds to the DataAdapter interface; the concrete impl
 * (MockAdapter | LiveAdapter) is chosen by DATA_MODE. `npm run dev` runs the
 * dashboard in mock with zero credentials.
 */
import type { BaselinesConfig } from '@jnpa/kpi';
import type { DataAdapter } from './interface.js';
import { MockAdapter } from './mock-adapter.js';
import { LiveAdapter } from './live-adapter.js';

export * from './interface.js';
export { MockAdapter } from './mock-adapter.js';
export { LiveAdapter } from './live-adapter.js';
// The deterministic scenario engine is reused by services/scenarios over the bus.
export { runMockScenario } from './scenarios-mock.js';
export type { ScenarioContext } from './scenarios-mock.js';
export { roleVisibleFacilityIds } from './rbac-scope.js';
export { buildNotifications } from './notifications-derive.js';

export interface AdapterConfig {
  mode?: 'mock' | 'live';
  terminalsConfig: ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
  baselines: BaselinesConfig;
  seed?: number;
  /** Gateway base URL for live mode. */
  gatewayBaseUrl?: string;
}

/** Select the adapter from DATA_MODE (env) or explicit config. */
export function createAdapter(cfg: AdapterConfig): DataAdapter {
  const mode = cfg.mode ?? (process?.env?.DATA_MODE === 'live' ? 'live' : 'mock');
  if (mode === 'live') {
    return new LiveAdapter({ gatewayBaseUrl: cfg.gatewayBaseUrl ?? '' });
  }
  return new MockAdapter({ terminalsConfig: cfg.terminalsConfig, baselines: cfg.baselines, seed: cfg.seed });
}
