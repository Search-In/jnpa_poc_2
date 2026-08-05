/**
 * The seven KPIs + dashboard rollups (prompt §8), exact formulas. Each is a pure
 * function of its slice of KpiInputs + the baseline. Worked examples in
 * docs/KPI_DEFINITIONS.md.
 */
import type { DwellBranchStats, KpiResult } from '@jnpa/schemas';
import type { KpiInputs } from './types.js';
import {
  buildTrend,
  hoursBetween,
  makeResult,
  mean,
  median,
  minutesBetween,
  percentile,
  round,
} from './helpers.js';

const baselineOf = (inp: KpiInputs, key: string): number =>
  inp.baselines.baselines[key]?.value ?? 0;

const TREND = (inp: KpiInputs) => inp.trendBuckets ?? 12;

/**
 * 1. Rake Turnaround Time — `departureTs − arrivalTs` (siding cycle), rolling
 *    mean per CTO/siding. Unit: hours. Lower is better.
 */
export function rakeTurnaroundTime(inp: KpiInputs): KpiResult {
  const completed = inp.rakes.filter((r) => r.departureTs);
  const series = completed.map((r) => ({
    ts: r.arrivalTs,
    value: hoursBetween(r.arrivalTs, r.departureTs!),
  }));
  const value = mean(series.map((s) => s.value));
  // per-siding breakdown
  const bySiding = ['T1', 'T2'].map((sid) => ({
    facilityId: sid,
    value: round(
      mean(completed.filter((r) => r.sidingId === sid).map((r) => hoursBetween(r.arrivalTs, r.departureTs!))),
    ),
  }));
  return makeResult({
    key: 'rakeTurnaroundTime',
    label: 'Rake Turnaround Time',
    value,
    unit: 'hr',
    baseline: baselineOf(inp, 'rakeTurnaroundTime'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
    byFacility: bySiding,
  });
}

/**
 * 2. Inter-Terminal Transfer TAT — `inTs − outTs`, mean over ITRHO movements.
 *    Unit: hours. Lower is better.
 */
export function interTerminalTransferTat(inp: KpiInputs): KpiResult {
  const completed = inp.itrho.filter((m) => m.outTs && m.inTs);
  const series = completed.map((m) => ({ ts: m.outTs!, value: hoursBetween(m.outTs!, m.inTs!) }));
  return makeResult({
    key: 'interTerminalTransferTat',
    label: 'Inter-Terminal Transfer TAT',
    value: mean(series.map((s) => s.value)),
    unit: 'hr',
    baseline: baselineOf(inp, 'interTerminalTransferTat'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
  });
}

/**
 * 3. Trailer Turn Around Time — `gateOut.ts − gateIn.ts` for a trailer's port
 *    visit. We pair GATE_IN→GATE_OUT per (containerNo, vehicleNo) from the
 *    GateTransaction stream. Unit: hours. Lower is better.
 */
export function trailerTurnaroundTime(inp: KpiInputs): KpiResult {
  const ins = inp.gateTransactions.filter((g) => g.direction === 'IN' && g.containerNo);
  const outs = inp.gateTransactions.filter((g) => g.direction === 'OUT' && g.containerNo && g.endTs);
  const series: Array<{ ts: string; value: number }> = [];
  for (const i of ins) {
    const o = outs.find((x) => x.containerNo === i.containerNo && new Date(x.startTs) >= new Date(i.startTs));
    if (o) series.push({ ts: i.startTs, value: hoursBetween(i.startTs, o.startTs) });
  }
  return makeResult({
    key: 'trailerTurnaroundTime',
    label: 'Trailer Turn Around Time',
    value: mean(series.map((s) => s.value)),
    unit: 'hr',
    baseline: baselineOf(inp, 'trailerTurnaroundTime'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
  });
}

/**
 * 4. Scanner Turn Around Time — `scan.endTs − scan.startTs` (queue-in to clear),
 *    mean. Unit: hours. Lower is better.
 */
export function scannerTurnaroundTime(inp: KpiInputs): KpiResult {
  const completed = inp.scans.filter((s) => s.endTs);
  const series = completed.map((s) => ({ ts: s.startTs, value: hoursBetween(s.startTs, s.endTs!) }));
  return makeResult({
    key: 'scannerTurnaroundTime',
    label: 'Scanner Turn Around Time',
    value: mean(series.map((s) => s.value)),
    unit: 'hr',
    baseline: baselineOf(inp, 'scannerTurnaroundTime'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
  });
}

/**
 * 5. Transshipment Trailer TAT — Trailer TAT filtered to originStream=TRANSSHIP
 *    / ITRHO road moves. Unit: hours. Lower is better.
 */
export function transshipmentTrailerTat(inp: KpiInputs): KpiResult {
  const transshipContainers = new Set(
    inp.containers.filter((c) => c.originStream === 'TRANSSHIP').map((c) => c.containerNo),
  );
  // ITRHO road moves for trans-shipment containers.
  const roadMoves = inp.itrho.filter(
    (m) => m.mode === 'ROAD' && m.outTs && m.inTs && transshipContainers.has(m.containerNo),
  );
  const series = roadMoves.map((m) => ({ ts: m.outTs!, value: hoursBetween(m.outTs!, m.inTs!) }));
  return makeResult({
    key: 'transshipmentTrailerTat',
    label: 'Transshipment Trailer TAT',
    value: mean(series.map((s) => s.value)),
    unit: 'hr',
    baseline: baselineOf(inp, 'transshipmentTrailerTat'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
  });
}

/**
 * 6. Buffer Pendency — count of containers in CFS/buffer awaiting next move
 *    beyond the dwell threshold, per facility. Unit: Nos. Lower is better.
 *
 * Implementation: a container is "pending" if its latest event is a
 * yard/destination event (no subsequent GATE_OUT/RAIL_OUT/DEPARTED) and the
 * time since that event exceeds the dwell threshold as of `asOf`.
 */
export function bufferPendency(inp: KpiInputs): KpiResult {
  const threshold = inp.bufferDwellThresholdHours ?? 48;
  const asOf = inp.asOf;
  const latestByContainer = new Map<string, { ts: string; facilityId: string; eventType: string }>();
  for (const e of inp.events) {
    const prev = latestByContainer.get(e.containerNo);
    if (!prev || e.ts > prev.ts) {
      latestByContainer.set(e.containerNo, { ts: e.ts, facilityId: e.facilityId, eventType: e.eventType });
    }
  }
  const terminalEvents = new Set(['GATE_OUT', 'RAIL_OUT', 'ITRHO_IN']);
  const byFacilityCount = new Map<string, number>();
  let total = 0;
  for (const [, last] of latestByContainer) {
    if (terminalEvents.has(last.eventType)) continue; // already moved on
    const dwellH = hoursBetween(last.ts, asOf);
    if (dwellH >= threshold) {
      total++;
      byFacilityCount.set(last.facilityId, (byFacilityCount.get(last.facilityId) ?? 0) + 1);
    }
  }
  const byFacility = [...byFacilityCount.entries()].map(([facilityId, value]) => ({ facilityId, value }));
  return makeResult({
    key: 'bufferPendency',
    label: 'Buffer Pendency',
    value: total,
    unit: 'Nos',
    baseline: baselineOf(inp, 'bufferPendency'),
    higherIsBetter: false,
    trend: [],
    byFacility,
  });
}

/**
 * 7. Mixed Train Optimization/Planning — improvement in mixed-rake utilisation:
 *    `(containersPerRake − baselineContainersPerRake) / baseline`. We measure
 *    containers actually moved per rake from RAIL_IN/RAIL_OUT events and report
 *    it as a higher-is-better utilisation figure. The improvement-% IS the KPI.
 */
export function mixedTrainOptimization(inp: KpiInputs): KpiResult {
  const railEvents = inp.events.filter((e) => e.eventType === 'RAIL_IN' || e.eventType === 'RAIL_OUT');
  const perRake = new Map<string, Set<string>>();
  for (const e of railEvents) {
    if (!e.rakeId) continue;
    let set = perRake.get(e.rakeId);
    if (!set) {
      set = new Set();
      perRake.set(e.rakeId, set);
    }
    set.add(e.containerNo);
  }
  const counts = [...perRake.values()].map((s) => s.size);
  const containersPerRake = mean(counts);
  const baseline = baselineOf(inp, 'mixedTrainOptimization');
  return makeResult({
    key: 'mixedTrainOptimization',
    label: 'Mixed Train Optimization',
    value: containersPerRake,
    unit: 'containers/rake',
    baseline,
    higherIsBetter: true,
    trend: [],
  });
}

// ---------------------------------------------------------------------------
// Dashboard rollups (bid §8.4.4)
// ---------------------------------------------------------------------------

/** Gate-wise throughput — gate transactions cleared per gate (Nos). */
export function gateThroughput(inp: KpiInputs): KpiResult {
  const cleared = inp.gateTransactions.filter((g) => g.outcome === 'CLEARED');
  const byGate = new Map<string, number>();
  for (const g of cleared) byGate.set(g.gateId, (byGate.get(g.gateId) ?? 0) + 1);
  return makeResult({
    key: 'gateThroughput',
    label: 'Gate Throughput',
    value: cleared.length,
    unit: 'Nos',
    baseline: cleared.length, // throughput baseline = self (no improvement concept)
    higherIsBetter: true,
    trend: [],
    byFacility: [...byGate.entries()].map(([facilityId, value]) => ({ facilityId, value })),
  });
}

/** Average gate transaction time — `endTs − startTs`, mean (minutes). */
export function gateTransactionTime(inp: KpiInputs): KpiResult {
  const done = inp.gateTransactions.filter((g) => g.endTs);
  const series = done.map((g) => ({ ts: g.startTs, value: minutesBetween(g.startTs, g.endTs!) }));
  return makeResult({
    key: 'gateTransactionTime',
    label: 'Avg Gate Transaction Time',
    value: mean(series.map((s) => s.value)),
    unit: 'min',
    baseline: baselineOf(inp, 'gateTransactionTime'),
    higherIsBetter: false,
    trend: buildTrend(series, TREND(inp)),
  });
}

/**
 * Container Dwell (WS4 KPI #9, supporting) — **median + P90 per branch, never a
 * bare mean.**
 *
 * The spec is explicit about the form because a mean hides the population that
 * actually costs money: the long-tail boxes (usually customs-held or DO-less).
 * P90 is what surfaces them, so this KPI deliberately never computes a mean —
 * `value` carries the overall median so a generic tile stays truthful.
 *
 * Dwell per container = first event → the event that ends its stay
 * (GATE_OUT / RAIL_OUT / ITRHO_IN), or → `asOf` for a box still in port. Branch
 * comes from `Container.originStream`, which is already exactly the
 * import/export/transship × CFS/ICD/DPD split the spec names.
 *
 * Containers with a single event contribute a 0 h dwell rather than being
 * dropped — a box that has only just arrived is genuinely at zero dwell, and
 * silently excluding it would bias both percentiles upward.
 */
export function containerDwell(inp: KpiInputs): KpiResult {
  const TERMINAL = new Set(['GATE_OUT', 'RAIL_OUT', 'ITRHO_IN']);
  const span = new Map<string, { first: string; last: string; ended: boolean }>();
  for (const e of inp.events) {
    const cur = span.get(e.containerNo);
    if (!cur) {
      span.set(e.containerNo, { first: e.ts, last: e.ts, ended: TERMINAL.has(e.eventType) });
      continue;
    }
    if (e.ts < cur.first) cur.first = e.ts;
    if (e.ts > cur.last) {
      cur.last = e.ts;
      cur.ended = TERMINAL.has(e.eventType);
    }
  }

  const streamOf = new Map(inp.containers.map((c) => [c.containerNo, c.originStream as string]));
  const all: number[] = [];
  const byBranchHours = new Map<string, number[]>();

  for (const [containerNo, s] of span) {
    const hours = Math.max(0, hoursBetween(s.first, s.ended ? s.last : inp.asOf));
    all.push(hours);
    const branch = streamOf.get(containerNo) ?? 'UNKNOWN';
    const bucket = byBranchHours.get(branch);
    if (bucket) bucket.push(hours);
    else byBranchHours.set(branch, [hours]);
  }

  const byBranch: DwellBranchStats[] = [...byBranchHours.entries()]
    .map(([branch, xs]) => ({
      branch,
      median: round(median(xs)),
      p90: round(percentile(xs, 0.9)),
      count: xs.length,
    }))
    .sort((a, b) => b.p90 - a.p90); // worst tail first — that is the actionable end

  const result = makeResult({
    key: 'containerDwell',
    label: 'Container Dwell (median · P90)',
    value: median(all),
    unit: 'h',
    baseline: baselineOf(inp, 'containerDwell'),
    higherIsBetter: false,
    trend: [],
  });
  result.distribution = {
    median: round(median(all)),
    p90: round(percentile(all, 0.9)),
    count: all.length,
    byBranch,
  };
  return result;
}

/** Container pendency CFS/ICD-wise — current count awaiting move, per facility. */
export function containerPendency(inp: KpiInputs): KpiResult {
  // Reuse buffer pendency but with a short threshold (current pendency snapshot).
  const snapshot = bufferPendency({ ...inp, bufferDwellThresholdHours: 0 });
  return makeResult({
    key: 'containerPendency',
    label: 'Container Pendency (CFS/ICD-wise)',
    value: snapshot.value,
    unit: 'Nos',
    baseline: snapshot.value,
    higherIsBetter: false,
    trend: [],
    byFacility: snapshot.byFacility,
  });
}
