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
  // Supporting, spec-mandated form (WS4 KPI #9): reported as median + P90 per
  // branch, never a bare mean. See `KpiResult.distribution`.
  'containerDwell',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

/** Median/P90 pair for a dwell-type measure over one population. */
export interface DwellStats {
  /** 50th percentile — the headline figure for a dwell KPI. */
  median: number;
  /** 90th percentile — the long tail the median hides. */
  p90: number;
  /** Containers contributing to this pair. */
  count: number;
}

/**
 * A dwell distribution split by cargo branch. `branch` is an `OriginStream`
 * (IMPORT_CFS / IMPORT_ICD / IMPORT_DPD / EXPORT_CFS / EXPORT_ICD / EXPORT_DPE /
 * TRANSSHIP) — exactly the import/export/transship × CFS/ICD/DPD split WS4 asks for.
 */
export interface DwellBranchStats extends DwellStats {
  branch: string;
}

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
  /**
   * Present on dwell-type KPIs only. WS4 mandates dwell be reported as
   * **median + P90 per branch, never a bare mean** — so a consumer that renders
   * `value` alone is not showing the required form. `value` carries the overall
   * median (never the mean) so a generic tile stays truthful, but the strip
   * should read `distribution` and show both figures per branch.
   */
  distribution?: DwellStats & { byBranch: DwellBranchStats[] };
}
