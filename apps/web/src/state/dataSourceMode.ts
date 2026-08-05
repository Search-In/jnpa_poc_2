/**
 * Data-SOURCE mode — the provenance axis for POC-3-served cargo data. SEPARATE
 * from the app's DATA_MODE (mock|live) and from the SIMULATED/LIVE provenance
 * chip: this switch chooses which backend rows the shared Cargo API returns,
 * via an `X-Data-Mode` request header:
 *   LIVE — rows sourced from the live JNPA integration APIs
 *   DEMO — the manually-imported, reliable pre-loaded rows (the default)
 *
 * A tiny framework-free store (get / set / subscribe) persisted in localStorage.
 * The value is threaded into {@link Poc3CargoAdapter} via its `getDataMode` dep
 * (see AppContext), so every cargo request carries the header. React components
 * bind via `useSyncExternalStore(subscribeDataSourceMode, getDataSourceMode)`.
 */

export type DataSourceMode = 'LIVE' | 'DEMO';

/** localStorage key — namespaced so it never collides with app state. */
export const DATA_SOURCE_MODE_KEY = 'jnpa.dataSourceMode';

/** Default DEMO: the reliable pre-loaded data, never the unproven live feed. */
const DEFAULT_MODE: DataSourceMode = 'DEMO';

function read(): DataSourceMode {
  try {
    const v = localStorage.getItem(DATA_SOURCE_MODE_KEY);
    return v === 'LIVE' || v === 'DEMO' ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

let current: DataSourceMode = read();
const listeners = new Set<() => void>();

/** The active mode. Read synchronously by the cargo adapter on every request. */
export function getDataSourceMode(): DataSourceMode {
  return current;
}

/** Persist + broadcast a new mode. No-op when unchanged or invalid. */
export function setDataSourceMode(mode: DataSourceMode): void {
  if (mode !== 'LIVE' && mode !== 'DEMO') return;
  if (mode === current) return;
  current = mode;
  try {
    localStorage.setItem(DATA_SOURCE_MODE_KEY, mode);
  } catch {
    /* private-mode / disabled storage — keep the in-memory value */
  }
  for (const l of listeners) l();
}

/** Subscribe to changes (for React's useSyncExternalStore). Returns unsubscribe. */
export function subscribeDataSourceMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
