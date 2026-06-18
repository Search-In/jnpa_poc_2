/**
 * Shared KPI helpers (prompt §8). The improvement-% convention is the subtle
 * part: for time/pendency KPIs lower is better, for utilisation higher is
 * better. `improvementPct` is normalised so positive always means "the twin is
 * better than baseline".
 */
import type { KpiResult, KpiKey, TrendPoint } from '@jnpa/schemas';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

export const hoursBetween = (aIso: string, bIso: string): number =>
  (new Date(bIso).getTime() - new Date(aIso).getTime()) / HOUR_MS;

export const minutesBetween = (aIso: string, bIso: string): number =>
  (new Date(bIso).getTime() - new Date(aIso).getTime()) / MIN_MS;

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function round(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Compute signed improvement-% vs baseline.
 *  - lower-is-better: improvement = (baseline − value) / baseline × 100
 *  - higher-is-better: improvement = (value − baseline) / baseline × 100
 */
export function improvement(value: number, baseline: number, higherIsBetter: boolean): number {
  if (baseline === 0) return 0;
  const raw = higherIsBetter ? (value - baseline) / baseline : (baseline - value) / baseline;
  return round(raw * 100, 1);
}

/**
 * Build evenly-spaced rolling-mean trend buckets over a time-keyed series.
 * `items` carries a timestamp + value; we bucket by time and emit bucket means.
 */
export function buildTrend(
  items: Array<{ ts: string; value: number }>,
  buckets: number,
): TrendPoint[] {
  if (items.length === 0 || buckets <= 0) return [];
  const sorted = [...items].sort((a, b) => a.ts.localeCompare(b.ts));
  const startMs = new Date(sorted[0]!.ts).getTime();
  const endMs = new Date(sorted[sorted.length - 1]!.ts).getTime();
  const span = Math.max(1, endMs - startMs);
  const width = span / buckets;
  const out: TrendPoint[] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = startMs + b * width;
    const hi = b === buckets - 1 ? endMs + 1 : startMs + (b + 1) * width;
    const inBucket = sorted.filter((x) => {
      const t = new Date(x.ts).getTime();
      return t >= lo && t < hi;
    });
    out.push({
      ts: new Date(lo + width / 2).toISOString(),
      value: round(mean(inBucket.map((x) => x.value))),
    });
  }
  return out;
}

export function makeResult(args: {
  key: KpiKey;
  label: string;
  value: number;
  unit: string;
  baseline: number;
  higherIsBetter: boolean;
  trend: TrendPoint[];
  byFacility?: Array<{ facilityId: string; value: number }>;
}): KpiResult {
  return {
    key: args.key,
    label: args.label,
    value: round(args.value),
    unit: args.unit,
    baseline: args.baseline,
    improvementPct: improvement(args.value, args.baseline, args.higherIsBetter),
    higherIsBetter: args.higherIsBetter,
    trend: args.trend,
    byFacility: args.byFacility,
  };
}
