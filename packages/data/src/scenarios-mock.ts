/**
 * Deterministic what-if scenarios for mock mode (prompt §12 + Appendix C req 6).
 * Each scenario:
 *   - recomputes KPIs before/after (visible delta panel),
 *   - fires an automated action (notification / recommendation / cross-twin push),
 *   - returns a spatial mapOverlay payload for the ArcGIS what-if rendering (A.2).
 * Seeded for repeatability. The services/scenarios microservice (Phase 7) hosts
 * the same logic over the live event backbone; this is the offline implementation.
 */
import type { KpiResult } from '@jnpa/schemas';
import type { CargoDataset, World } from '@jnpa/sim';
import type { BaselinesConfig } from '@jnpa/kpi';
import { computeAllKpis } from '@jnpa/kpi';
import type { ScenarioParams, ScenarioResultDTO } from './interface.js';

export interface ScenarioContext {
  dataset: CargoDataset;
  world: World;
  baselines: BaselinesConfig;
  asOf: string;
  seed: number;
}

function baseKpis(ctx: ScenarioContext): KpiResult[] {
  return computeAllKpis({
    asOf: ctx.asOf,
    containers: ctx.dataset.containers,
    events: ctx.dataset.events,
    gateTransactions: ctx.dataset.gateTransactions,
    rakes: ctx.dataset.rakes,
    itrho: ctx.dataset.itrho,
    scans: ctx.dataset.scans,
    baselines: ctx.baselines,
    bufferDwellThresholdHours: 24,
  });
}

/**
 * Twin-vs-shadow A/B (§8.2): every scenario runs TWO deterministic KPI
 * computations from the SAME base snapshot —
 *   A ("shadow", do-nothing): the perturbation continues unmanaged,
 *   B ("twin", intervention): the same perturbation + the twin's interventions.
 * The delta panel then shows B-vs-A honestly: before = A, after = B. There is
 * no live SimPy engine in mock mode, so A and B are expressed as two NAMED
 * parameter sets — documented multiplicative assumptions per KPI — not one
 * magic factor. All deltas are modelled outcomes under these stated
 * assumptions, not claimed JNPA baselines.
 */

/** One documented KPI adjustment inside a parameter set. */
interface KpiAdjustment {
  key: string;
  /** Multiplicative factor on the base-snapshot KPI value. */
  factor: number;
  /** The stated assumption this factor encodes (shown in tooltips/docs). */
  assumption: string;
}

/** A named, documented deterministic parameter set (one arm of the A/B). */
interface ParamSet {
  name: string;
  description: string;
  adjustments: KpiAdjustment[];
}

interface AbDesign {
  /** A — do-nothing baseline continuation (perturbation only). */
  shadow: ParamSet;
  /** B — perturbation + twin interventions (partial recovery). */
  twin: ParamSet;
}

/** Apply a parameter set to the base KPIs + recompute improvementPct. */
function applyParamSet(base: KpiResult[], set: ParamSet): KpiResult[] {
  const factors = new Map(set.adjustments.map((a) => [a.key, a.factor]));
  return base.map((k) => {
    const factor = factors.get(k.key);
    if (factor === undefined) return k;
    const value = Math.round(k.value * factor * 100) / 100;
    const raw = k.higherIsBetter
      ? (value - k.baseline) / k.baseline
      : (k.baseline - value) / k.baseline;
    return { ...k, value, improvementPct: Math.round(raw * 1000) / 10 };
  });
}

/**
 * Old §12 ids kept as aliases so existing adapter callers/tests keep working.
 * Intentional duplicate of LEGACY_SCRIPT_IDS in apps/web scenarioPlayer.ts
 * (this package cannot import from apps/web); keep the two in sync.
 */
const LEGACY_SCENARIO_IDS: Record<string, string> = {
  'CGO-1': 'S5', // CFS pendency spike folds into the driver-shortage storyline
  'CGO-2': 'S2',
  'CGO-3': 'S3',
  'LANE-ASSIGN': 'S4',
};

/** The six §8.2 A/B designs. Factors are fixed + documented (deterministic). */
const AB_DESIGNS: Record<string, AbDesign> = {
  S1: {
    shadow: {
      name: 'S1-A do-nothing',
      description: 'Inbound rake +6 h; siding slot conflicts cascade unmanaged.',
      adjustments: [
        { key: 'rakeTurnaroundTime', factor: 1.3, assumption: '6 h delay propagates through 2 conflicting T1 slots' },
        { key: 'interTerminalTransferTat', factor: 1.1, assumption: 'shuttle loops idle while rakes queue' },
        { key: 'mixedTrainOptimization', factor: 0.9, assumption: 'broken connections strand mixed-rake blocks' },
      ],
    },
    twin: {
      name: 'S1-B ITRHO re-route + priority placement',
      description: 'At-risk exports shuttled to GTI by road; delayed rake placed at T2.',
      adjustments: [
        { key: 'rakeTurnaroundTime', factor: 1.08, assumption: 'delay largely absorbed by T2 priority placement' },
        { key: 'interTerminalTransferTat', factor: 1.02, assumption: 'extra ITRHO legs, but no idle loops' },
        { key: 'mixedTrainOptimization', factor: 0.98, assumption: 'most connections preserved' },
      ],
    },
  },
  S2: {
    shadow: {
      name: 'S2-A do-nothing',
      description: 'Customs-flag surge; trucks keep arriving on original schedule.',
      adjustments: [
        { key: 'scannerTurnaroundTime', factor: 1.25, assumption: 'scan queue depth 8 → ~48 boxes' },
        { key: 'gateTransactionTime', factor: 1.18, assumption: 'flagged boxes block NSICT-G1 lanes' },
        { key: 'gateThroughput', factor: 0.88, assumption: 'lanes stall on held trucks' },
      ],
    },
    twin: {
      name: 'S2-B deferred-arrival push to UC-3',
      description: 'Forecaster re-run + 90-min deferred-arrival window via UC-3 app.',
      adjustments: [
        { key: 'scannerTurnaroundTime', factor: 1.12, assumption: 'surge unchanged; queue drains without gate pile-up' },
        { key: 'gateTransactionTime', factor: 1.05, assumption: 'deferral flattens the arrival peak' },
        { key: 'gateThroughput', factor: 0.97, assumption: 'throughput deferred, not lost' },
      ],
    },
  },
  S3: {
    shadow: {
      name: 'S3-A naive sequential split',
      description: '90-wagon mixed rake (GTI 40 / NSICT 30 / BMCT 20) worked one terminal at a time.',
      adjustments: [
        { key: 'interTerminalTransferTat', factor: 1.15, assumption: 'three sequential shunt cycles block the siding' },
        { key: 'rakeTurnaroundTime', factor: 1.1, assumption: 'rake occupies T1 through all three cycles' },
      ],
    },
    twin: {
      name: 'S3-B batched ITRHO split plan',
      description: 'GTI block at siding; NSICT + BMCT blocks via parallel ITRHO shuttle loops.',
      adjustments: [
        { key: 'interTerminalTransferTat', factor: 0.87, assumption: 'parallel shuttle loops reuse trailer cycles' },
        { key: 'rakeTurnaroundTime', factor: 0.94, assumption: 'rake released after single working window' },
        { key: 'mixedTrainOptimization', factor: 1.11, assumption: 'outbound rakes consolidated across terminals' },
      ],
    },
  },
  S4: {
    shadow: {
      name: 'S4-A do-nothing',
      description: '3 of 6 lanes at NSICT-G1 closed 4 h; arrivals unmanaged.',
      adjustments: [
        { key: 'gateTransactionTime', factor: 1.45, assumption: 'same flow through half the lanes' },
        { key: 'gateThroughput', factor: 0.65, assumption: 'queue spills to approach road' },
        { key: 'trailerTurnaroundTime', factor: 1.25, assumption: 'trailers stuck in gate queue' },
      ],
    },
    twin: {
      name: 'S4-B dynamic lanes + CPP throttling',
      description: '2 exit lanes re-assigned to entry; CPP releases throttled for 4 h.',
      adjustments: [
        { key: 'gateTransactionTime', factor: 1.08, assumption: 'entry capacity partially restored' },
        { key: 'gateThroughput', factor: 0.92, assumption: 'throttled releases shift, not cancel, demand' },
        { key: 'trailerTurnaroundTime', factor: 1.06, assumption: 'shorter queues, minor residual delay' },
      ],
    },
  },
  S5: {
    shadow: {
      name: 'S5-A do-nothing',
      description: 'Trailer-driver availability −30% for 10 sim days; no interventions (reconstruction of a recent industry-wide event class).',
      adjustments: [
        { key: 'bufferPendency', factor: 2.6, assumption: '>15-day bucket compounds to ~2,500 boxes by day 7' },
        { key: 'containerPendency', factor: 1.8, assumption: 'evacuation rate 30% below arrival rate' },
        { key: 'rakeTurnaroundTime', factor: 1.22, assumption: 'rakes wait on loads trailers cannot position' },
        { key: 'trailerTurnaroundTime', factor: 1.35, assumption: 'remaining drivers over-cycled' },
      ],
    },
    twin: {
      name: 'S5-B intervention bundle',
      description: 'CFS→DPD conversion + 3 extra evacuation rakes/day + ITRHO waiver + green-channel for >15-day boxes.',
      adjustments: [
        { key: 'bufferPendency', factor: 1.18, assumption: '>15-day bucket bends to ~450 boxes by day 10' },
        { key: 'containerPendency', factor: 1.15, assumption: 'DPD conversion removes the CFS leg for eligible boxes' },
        { key: 'rakeTurnaroundTime', factor: 1.06, assumption: 'extra rakes absorb the road-side shortfall' },
        { key: 'trailerTurnaroundTime', factor: 1.12, assumption: 'ITRHO waiver spreads driver load' },
      ],
    },
  },
  S6: {
    shadow: {
      name: 'S6-A do-nothing',
      description: 'Reefer discharge ×3.5 while 18 of 96 CPP plugs are failed; first-come plug allocation.',
      adjustments: [
        { key: 'containerPendency', factor: 1.35, assumption: '34 reefers queue unpowered, ~46 cargo-risk hours accrue' },
        { key: 'transshipmentTrailerTat', factor: 1.2, assumption: 'ad-hoc reefer repositioning trips' },
        { key: 'bufferPendency', factor: 1.3, assumption: 'reefer overflow occupies buffer slots' },
      ],
    },
    twin: {
      name: 'S6-B pooled plug allocation + priority evacuation',
      description: 'Plugs pooled across BMCT/NSIGT/CFS by transit tolerance; DPD reefers evacuated first. Target: zero simulated cargo-risk hours.',
      adjustments: [
        { key: 'containerPendency', factor: 1.05, assumption: 'queue cleared within shift; zero cargo-risk hours (modelled target)' },
        { key: 'transshipmentTrailerTat', factor: 1.04, assumption: 'planned repositioning replaces ad-hoc trips' },
        { key: 'bufferPendency', factor: 1.05, assumption: 'buffer occupancy near normal' },
      ],
    },
  },
};

export function runMockScenario(
  id: string,
  params: ScenarioParams,
  ctx: ScenarioContext,
): ScenarioResultDTO {
  const canonicalId = LEGACY_SCENARIO_IDS[id] ?? id;
  const base = baseKpis(ctx);
  const design = AB_DESIGNS[canonicalId];

  if (!design) {
    return {
      scenarioId: id,
      seed: ctx.seed,
      before: base,
      after: base,
      actions: [{ kind: 'NOOP', detail: `Unknown scenario "${id}"` }],
    };
  }

  // Honest A/B: before = A (do-nothing continuation), after = B (intervention).
  // Both derive from the same base snapshot; every delta is B-vs-A.
  const before = applyParamSet(base, design.shadow);
  const after = applyParamSet(base, design.twin);

  // The A/B provenance action every scenario carries (honesty framing).
  const abAction = {
    kind: 'AB_ASSUMPTIONS',
    detail:
      `Twin-vs-shadow: A "${design.shadow.name}" (${design.shadow.description}) vs ` +
      `B "${design.twin.name}" (${design.twin.description}). All deltas are B-vs-A, ` +
      `modelled under these stated assumptions — not a claimed JNPA baseline.`,
  };

  switch (canonicalId) {
    case 'S1': {
      const siding = (params.sidingId as string) ?? 'T1';
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'OPTIMISATION', detail: `ITRHO re-route of cut-off-risk exports to GTI + priority placement of the delayed rake at T2 (was ${siding})` },
          { kind: 'RECOMMENDATION', detail: 'Simulated: cut-off exposure ~180 → ~25 boxes within simulation under stated assumptions' },
          abAction,
        ],
        mapOverlay: { type: 'rake-delay-cascade', siding, rerouteTerminal: 'GTI', delayHours: 6 },
      };
    }

    case 'S2': {
      const surge = (params.surgeCount as number) ?? 40;
      const gateId = (params.gateId as string) ?? 'NSICT-G1';
      const deferFrom = ctx.asOf;
      const deferTo = new Date(new Date(ctx.asOf).getTime() + 90 * 60_000).toISOString();
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'FORECAST_RERUN', detail: `Gate-queue forecaster re-run for ${gateId} after surge of ${surge}` },
          {
            kind: 'CROSS_TWIN_PUSH',
            detail: `Deferred-arrival window ${deferFrom}–${deferTo} pushed to UC3 Trucking App`,
            target: 'UC3',
          },
          abAction,
        ],
        mapOverlay: { type: 'customs-surge', gateId, deferralWindow: { from: deferFrom, to: deferTo } },
      };
    }

    case 'S3': {
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'OPTIMISATION', detail: 'Batched split plan for the 90-wagon mixed rake (GTI 40 / NSICT 30 / BMCT 20): siding works GTI block; NSICT + BMCT via parallel ITRHO loops' },
          { kind: 'RECOMMENDATION', detail: 'Adopt batched mixed-rake split plans as the default for 3-terminal rakes' },
          abAction,
        ],
        mapOverlay: { type: 'mixed-train-split', wagonSplit: { GTI: 40, NSICT: 30, BMCT: 20 }, itrhoBatched: true },
      };
    }

    case 'S4': {
      const congestedGate = (params.gateId as string) ?? 'NSICT-G1';
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'LANE_ASSIGNMENT', detail: `Re-assign 2 exit lanes to entry at ${congestedGate}; throttle CPP releases feeding the gate for 4 h` },
          { kind: 'RECOMMENDATION', detail: 'Simulated: gate txn time recovers 5.8 → 4.3 min within simulation under stated assumptions' },
          abAction,
        ],
        mapOverlay: { type: 'gate-lane-closure', congestedGate, lanesClosed: 3, lanesTotal: 6, rerouteLines: true },
      };
    }

    case 'S5': {
      const shortagePct = (params.shortagePct as number) ?? 30;
      const days = (params.days as number) ?? 10;
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'NOTIFICATION', detail: `Trailer-driver availability −${shortagePct}% for ${days} sim days — >15-day pendency bucket compounding (reconstruction of a recent industry-wide event class within the twin)`, target: 'TERMINAL_OPS' },
          { kind: 'RECOMMENDATION', detail: 'Intervention bundle: CFS→DPD conversion + 3 extra evacuation rakes/day + ITRHO waiver + green-channel evacuation of >15-day boxes' },
          { kind: 'OPTIMISATION', detail: 'Simulated: >15-day bucket ~2,500 → ~450 boxes by day 10 within simulation under stated assumptions' },
          abAction,
        ],
        mapOverlay: { type: 'driver-shortage', facilities: ['CFS-DRONAGIRI-1', 'CFS-URAN-1', 'CFS-PANVEL-1'], severity: 'high', over15dBucket: { shadow: 2500, twin: 450 } },
      };
    }

    case 'S6': {
      const failedPlugs = (params.failedPlugs as number) ?? 18;
      return {
        scenarioId: canonicalId,
        seed: ctx.seed,
        before,
        after,
        actions: [
          { kind: 'NOTIFICATION', detail: `${failedPlugs} of 96 CPP reefer plugs failed during reefer discharge surge`, target: 'TERMINAL_OPS' },
          { kind: 'OPTIMISATION', detail: 'Cross-terminal plug pool re-allocation by transit tolerance + priority evacuation of DPD-eligible reefers' },
          { kind: 'RECOMMENDATION', detail: 'Simulated: cargo-risk hours ~46 → 0 within simulation — a modelled target under stated assumptions' },
          abAction,
        ],
        mapOverlay: { type: 'reefer-surge', terminalId: 'BMCT', failedPlugs, totalPlugs: 96, priorityEvacuation: true },
      };
    }

    default:
      // Unreachable (AB_DESIGNS lookup already guarded); satisfies TS return-path analysis.
      return { scenarioId: id, seed: ctx.seed, before, after, actions: [abAction] };
  }
}
