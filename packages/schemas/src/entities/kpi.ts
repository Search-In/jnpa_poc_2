/**
 * KPI result contract (prompt §8). Each KPI returns its current value AND the
 * % improvement vs the current-state baseline (Appendix C requires baseline
 * improvement). Kept in @jnpa/schemas so both the KPI engine and the data
 * adapter reference the same shape without a circular dependency.
 */

/** Stable keys for the seven KPIs + dashboard rollups (§8). */
export const KPI_KEYS = [
  'rakeTurnaroundTime',
  'interTerminalTransferTat',
  'trailerTurnaroundTime',
  'scannerTurnaroundTime',
  'transshipmentTrailerTat',
  'bufferPendency',
  'mixedTrainOptimization',
  // dashboard rollups (bid §8.4.4)
  'gateThroughput',
  'gateTransactionTime',
  'containerPendency',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

/** A single point in a KPI trend series. */
export interface TrendPoint {
  ts: string;
  value: number;
}

/**
 * KPI result. `improvementPct` is positive when the twin improves on baseline,
 * regardless of whether "better" means lower (TAT) or higher (utilisation) — the
 * engine normalises direction so the dashboard can always render "+x% better".
 */
export interface KpiResult {
  key: KpiKey;
  label: string;
  value: number;
  unit: string;
  baseline: number;
  /** Signed % improvement vs baseline (positive = better). */
  improvementPct: number;
  /** True if higher raw values are better (utilisation), false for TATs/pendency. */
  higherIsBetter: boolean;
  trend: TrendPoint[];
  /** Optional per-facility breakdown for rollups. */
  byFacility?: Array<{ facilityId: string; value: number }>;
}
