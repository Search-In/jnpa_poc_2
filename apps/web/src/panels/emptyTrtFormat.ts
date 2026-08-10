/**
 * Formatting for the empty-container TRT chains (UC2-010).
 *
 * Split out of the panel so it can be tested without importing Calcite, the way
 * customsEvidence.ts and scanSelection.ts are.
 *
 * ⚠ The one trap worth naming: POC-3 returns `trt_min`, `dwell_min` and
 * `cycle_min` as Postgres numerics, which arrive over the wire as decimal
 * STRINGS ("240.00"). Anything that assumes number produces NaN, and NaN renders
 * as an em dash — a measured chain displayed as "no data". Coerce first, always.
 */

/** Decimal string or number → number; null for absent or unparseable. */
export function num(v?: number | string | null): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Minutes → "3 h 24 m", the unit the KPI is defined in.
 *
 * Absent stays absent: an ECY gate-out that never reached a CFS has no TRT, and
 * showing 0 would report an instantaneous transit and drag the average down.
 */
export function fmtMin(v?: number | string | null): string {
  const n = num(v);
  if (n === null) return '—';
  if (n < 60) return `${Math.round(n)} m`;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return m === 0 ? `${h.toLocaleString()} h` : `${h.toLocaleString()} h ${m} m`;
}

export const fmtInt = (v?: number | null) =>
  (v === null || v === undefined ? '—' : v.toLocaleString());

export const fmtTs = (v?: string | null) =>
  (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
