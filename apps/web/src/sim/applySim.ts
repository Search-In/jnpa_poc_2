/**
 * applySim — pure merge helpers that overlay the sim overrides on top of the
 * adapter's base data. The dashboard calls these so every tab and the map show
 * the live (simulated) values without touching the adapter. All helpers are
 * non-mutating and return new arrays/objects, so React change-detection works.
 */
import type { GateOpsDTO, PendencyDTO, RailSideDTO, EmptyPoolDTO } from '@jnpa/data';
import type { KpiResult, ScanEvent } from '@jnpa/schemas';
import type { SimState } from './simStore.js';

/** Overlay per-gate queue / txn overrides. */
export function applyGateOps(base: GateOpsDTO[], sim: SimState): GateOpsDTO[] {
  if (Object.keys(sim.gates).length === 0) return base;
  return base.map((g) => {
    const o = sim.gates[g.gateId];
    if (!o) return g;
    return {
      ...g,
      queueLength: o.queueLength ?? g.queueLength,
      avgTxnTimeMin: o.avgTxnTimeMin ?? g.avgTxnTimeMin,
      ...(o.openLanes != null ? { openLanes: o.openLanes } : {}),
    } as GateOpsDTO;
  });
}

/** Overlay per-facility pendency overrides. */
export function applyPendency(base: PendencyDTO[], sim: SimState): PendencyDTO[] {
  if (Object.keys(sim.pendency).length === 0) return base;
  return base.map((p) => {
    const o = sim.pendency[p.facilityId];
    return o?.pendency != null ? { ...p, pendency: o.pendency } : p;
  });
}

/**
 * Overlay rail siding state. We can't fabricate full Rake records, so the sim's
 * inboundQueue/placed counts are surfaced as a synthetic banner via the DTO's
 * forecast field where present; the rake table stays adapter-driven. The
 * Simulator page is the authoritative readout for the injected counts.
 */
export function applyRail(base: RailSideDTO, sim: SimState, siding: string): RailSideDTO {
  const o = sim.rail[siding];
  if (!o) return base;
  // Annotate the DTO non-destructively; consumers that know about the field
  // (the Dashboard rail banner) can read it.
  return { ...base, simInbound: o.inboundQueue ?? 0, simPlaced: o.placed ?? 0 } as RailSideDTO & {
    simInbound: number;
    simPlaced: number;
  };
}

/** Scale derived cargo-flow counts by the global movement rate. */
export function applyFlows<T extends { count: number }>(flows: T[], sim: SimState): T[] {
  if (sim.movementRate === 1) return flows;
  return flows.map((f) => ({ ...f, count: Math.max(0, Math.round(f.count * sim.movementRate)) }));
}

// ---- Scan -----------------------------------------------------------------

/**
 * Overlay the simulated customs-scan backlog. The slider sets the number of
 * PENDING (uncleared) scans in the queue: the first N events are forced PENDING
 * (cleared result/endTs) and, if N exceeds the base list, synthetic PENDING rows
 * are appended so the depth is honoured even when the base queue is empty.
 * Already-cleared events past N are kept so history still shows.
 */
export function applyScanQueue(base: ScanEvent[], sim: SimState): ScanEvent[] {
  const target = sim.scanQueue;
  if (target == null) return base;

  // A template for synthetic rows — clone a base row or fabricate a minimal one.
  const template: ScanEvent =
    base[0] ??
    ({
      scanId: 'SIM',
      containerNo: 'SIMU0000000' as ScanEvent['containerNo'],
      scannerId: 'SIM-SCANNER',
      flaggedBy: 'CUSTOMS',
      startTs: new Date(sim.clockMs).toISOString(),
    } satisfies ScanEvent);

  const out: ScanEvent[] = [];
  for (let i = 0; i < target; i++) {
    const src = base[i] ?? template;
    out.push({
      ...src,
      scanId: base[i] ? src.scanId : `${template.scanId}-sim${i}`,
      containerNo: base[i] ? src.containerNo : (`SIMU${String(1000000 + i).slice(-7)}` as ScanEvent['containerNo']),
      // PENDING = no result yet, not cleared
      result: undefined,
      endTs: undefined,
    });
  }
  // Append any base events beyond the target as cleared history.
  if (base.length > target) out.push(...base.slice(target));
  return out;
}

// ---- Empty pool -----------------------------------------------------------

/**
 * Overlay the empty-pool availability delta. The delta is spread across all
 * pools (weighted by current availability) so every depot's balance shifts,
 * making the Empty tab visibly respond rather than nudging a single row.
 */
export function applyEmptyPool(base: EmptyPoolDTO, sim: SimState): EmptyPoolDTO {
  const delta = sim.emptyDelta;
  if (delta === 0 || !base.pools?.length) return base;

  const total = base.pools.reduce((n, p) => n + Math.max(1, p.availableQty), 0);
  let applied = 0;
  const pools = base.pools.map((p, i) => {
    // Last pool absorbs the rounding remainder so the totals stay exact.
    const share =
      i === base.pools.length - 1
        ? delta - applied
        : Math.round((delta * Math.max(1, p.availableQty)) / total);
    applied += share;
    return { ...p, availableQty: Math.max(0, p.availableQty + share) };
  });
  return { ...base, pools };
}

// ---- KPIs -----------------------------------------------------------------

const round1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Re-derive `improvementPct` after a value override, using the same convention
 * as the KPI engine (positive = better; lower-is-better inverts the sign).
 */
function improvement(value: number, baseline: number, higherIsBetter: boolean): number {
  if (baseline === 0) return 0;
  const raw = higherIsBetter ? (value - baseline) / baseline : (baseline - value) / baseline;
  return round1(raw * 100);
}

/**
 * Compute, per KPI key, the multiplicative factor the current sim state applies
 * to that KPI's value. 1 = unchanged. The factors model how each lever pushes a
 * metric: congestion/backlog worsen TATs and pendency; higher movement rate
 * improves throughput and trailer TATs. Factors are intentionally gentle so the
 * board moves believably rather than swinging wildly.
 */
function kpiFactors(sim: SimState): Partial<Record<string, number>> {
  const gateQs = Object.values(sim.gates).map((g) => g.queueLength ?? 0);
  const avgGateQ = mean(gateQs); // 0..~30
  const gateLoad = clamp01(avgGateQ / 20); // 0 (clear) .. 1 (jammed)

  const pendVals = Object.values(sim.pendency).map((p) => p.pendency ?? 0);
  const avgPend = mean(pendVals); // 0..300
  const pendLoad = clamp01(avgPend / 200);

  const railBacklog = Object.values(sim.rail).reduce((n, r) => n + (r.inboundQueue ?? 0), 0); // 0..24
  const railLoad = clamp01(railBacklog / 16);

  const scanLoad = sim.scanQueue == null ? 0 : clamp01(sim.scanQueue / 60);

  const rate = sim.movementRate; // 0..3, 1 = baseline
  const flow = rate - 1; // -1..+2

  return {
    // higher-is-better: throughput rises with flow, falls under gate congestion
    gateThroughput: 1 + flow * 0.5 - gateLoad * 0.3,
    // lower-is-better: txn time rises with gate congestion
    gateTransactionTime: 1 + gateLoad * 0.6,
    // lower-is-better: pendency tracks the override backlog
    containerPendency: 1 + pendLoad * 0.8 - clamp01(flow) * 0.2,
    bufferPendency: 1 + pendLoad * 0.6,
    // lower-is-better: scanner TAT rises with scan-queue depth
    scannerTurnaroundTime: 1 + scanLoad * 0.7,
    // lower-is-better: rail TATs rise with inbound rake backlog
    rakeTurnaroundTime: 1 + railLoad * 0.5,
    interTerminalTransferTat: 1 + railLoad * 0.4 + gateLoad * 0.2,
    mixedTrainOptimization: 1 - railLoad * 0.3, // higher-is-better → backlog hurts it
    // lower-is-better: trailer TATs ease as movement flows faster
    trailerTurnaroundTime: 1 - clamp01(flow) * 0.3 + gateLoad * 0.2,
    transshipmentTrailerTat: 1 - clamp01(flow) * 0.25 + gateLoad * 0.15,
  };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** True when any sim lever is engaged (so we skip work when idle). */
function simEngaged(sim: SimState): boolean {
  return (
    Object.keys(sim.gates).length > 0 ||
    Object.keys(sim.pendency).length > 0 ||
    Object.keys(sim.rail).length > 0 ||
    sim.movementRate !== 1 ||
    sim.scanQueue != null
  );
}

/**
 * Overlay the simulator's effect on the computed KPIs so the headline metrics
 * (KPI strip) move in lock-step with the tabs and map. Each KPI value is scaled
 * by its lever factor and its improvement-% recomputed against the unchanged
 * baseline; the trend's last point is nudged to the new value so sparklines
 * track too. Baselines are never touched.
 */
export function applyKpis(base: KpiResult[], sim: SimState): KpiResult[] {
  if (!simEngaged(sim)) return base;
  const factors = kpiFactors(sim);
  return base.map((k) => {
    const f = factors[k.key];
    if (f == null || f === 1) return k;
    const value = round1(Math.max(0, k.value * f));
    const trend =
      k.trend.length > 0
        ? [...k.trend.slice(0, -1), { ...k.trend[k.trend.length - 1]!, value }]
        : k.trend;
    return {
      ...k,
      value,
      improvementPct: improvement(value, k.baseline, k.higherIsBetter),
      trend,
    };
  });
}
