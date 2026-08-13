/**
 * UC-2 Requirement 2 — Multiple Yard Blocks at Peak RTG Demand.
 *
 * "Create a scenario where multiple yard blocks simultaneously experience peak
 *  RTG demand, based on the configured peak operational capacity. Analyze the
 *  resulting equipment utilization, waiting times, queue formation, and impact
 *  on container handling productivity. Simulate various RTG dispatch strategies
 *  and recommend the top two optimized dispatch plans."
 *
 * Data honesty, stated up front (this repository has NO RTG domain data):
 *
 *  - YARD BLOCKS: the only enumerated blocks in the repo are the 12-per-terminal
 *    grid `<TERMINAL>-Y1..Y12` (surveyed positions in data/positions.json,
 *    rendered by the 3-D scene). JNPA publish yard occupancy per TERMINAL only —
 *    "not per block" (panels/Pendency.tsx states this) — so per-block workload
 *    is a declared uniform split, never a claimed measurement.
 *  - DEMAND: derived from the measured event corpus — yard-crane-implying
 *    events (YARD_MOVE, GATE_IN, GATE_OUT) per terminal per hour; the peak hour
 *    is the demand basis. The event→RTG-move mapping is a declared assumption.
 *  - PEAK OPERATIONAL CAPACITY: no RTG register or productivity rating exists
 *    anywhere in this repo. Capacity = rtgsPerBlock × peakMovesPerHourPerRtg,
 *    both PARAMETERS from config/uc2-whatif.json, overridable per run.
 *  - QUEUEING: the same deterministic arrival-vs-service recursion the repo
 *    already uses for the gate forecast (packages/data/src/forecasts.ts) —
 *    15-minute steps, queue carried forward. Waiting is DERIVED from that
 *    model (queue box-hours ÷ moves served), never fabricated per-container.
 *  - STRATEGIES: no dispatch logic exists to reuse, and no travel-time or
 *    block-adjacency model exists — so a "nearest RTG" strategy CANNOT be
 *    evaluated honestly and is omitted (stated in the notes). The four below
 *    only need quantities the model actually has.
 *
 * Pure and deterministic: same inputs → identical output, inputs never mutated,
 * strategy order fixed, tie-break documented. Non-destructive by construction.
 */

import type { ContainerMovementDTO } from '../interface.js';
import type { Uc2AnswerResult, Uc2Assumption, Uc2Query } from './envelope.js';

export const UC2_RTG_PEAK_ID = 'uc2-rtg-peak';

/** The nominal 12-block grid every terminal renders (scene3d YARD_ROWS×YARD_COLS). */
export const BLOCKS_PER_TERMINAL = 12;

/** Enumerate the repo's nominal yard-block ids for the given terminals. */
export function nominalYardBlocks(
  terminalIds: string[],
): Array<{ blockId: string; terminalId: string }> {
  return terminalIds.flatMap((t) =>
    Array.from({ length: BLOCKS_PER_TERMINAL }, (_, i) => ({
      blockId: `${t}-Y${i + 1}`,
      terminalId: t,
    })),
  );
}

export interface RtgParams {
  /** RTGs at their home block at the start of the scenario. PARAMETER. */
  rtgsPerBlock: number;
  /** Physical RTG limit per block a dispatcher may not exceed. PARAMETER. */
  maxRtgsPerBlock: number;
  /** Configured peak operational capacity per RTG, moves/hour. PARAMETER. */
  peakMovesPerHourPerRtg: number;
  /** Hypothetical demand = observed peak-hour rate × this. PARAMETER. */
  demandMultiplier: number;
  /** Hours the simultaneous peak is held before demand stops. PARAMETER. */
  stressHours: number;
  /** Scoring weights over the three stated objectives. PARAMETER. */
  weights: { idle: number; delay: number; throughput: number };
}

export const DEFAULT_RTG_PARAMS: RtgParams = {
  rtgsPerBlock: 2,
  maxRtgsPerBlock: 4,
  peakMovesPerHourPerRtg: 20,
  demandMultiplier: 1.5,
  stressHours: 4,
  weights: { idle: 0.334, delay: 0.333, throughput: 0.333 },
};

export interface RtgDispatchInput {
  /** Full movement corpus from adapter.getContainerMovements({}). Never mutated. */
  movements: ContainerMovementDTO[];
  /** Selected yard blocks (≥1; the scenario is about several at once). */
  blocks: Array<{ blockId: string; terminalId: string }>;
  params?: Partial<RtgParams>;
}

/** Events at a terminal that imply one RTG (yard-crane) move each. */
const RTG_MOVE_EVENTS = new Set(['YARD_MOVE', 'GATE_IN', 'GATE_OUT']);

const STEP_MIN = 15; // mirrors forecasts.ts
const MAX_HORIZON_HOURS = 24; // drain cut-off so a saturated case still terminates

export type StrategyId =
  | 'STATIC_HOME'
  | 'LONGEST_QUEUE'
  | 'HIGHEST_UTILIZATION'
  | 'BALANCED_SPREAD';

/** Fixed order — doubles as the deterministic tie-break (documented on screen). */
const STRATEGY_ORDER: StrategyId[] = [
  'STATIC_HOME',
  'LONGEST_QUEUE',
  'HIGHEST_UTILIZATION',
  'BALANCED_SPREAD',
];

const STRATEGY_LABELS: Record<StrategyId, string> = {
  STATIC_HOME: 'Static home-block assignment (baseline — the de-facto current arrangement)',
  LONGEST_QUEUE: 'Longest queue first — free RTGs go to the block with the largest backlog',
  HIGHEST_UTILIZATION: 'Highest utilization first — RTGs go to blocks nearest/over peak capacity',
  BALANCED_SPREAD: 'Balanced load — RTGs spread proportionally to demand to minimise imbalance',
};

export interface StrategyMetrics {
  strategy: StrategyId;
  label: string;
  moves_served: number;
  utilization_pct: number;
  idle_rtg_hours: number;
  waiting_box_hours: number;
  avg_wait_min_per_move: number;
  peak_queue: number;
  delayed_moves: number;
  moves_per_rtg_hour: number;
  throughput_moves_per_hour: number;
  score: number;
  per_block: Array<{
    blockId: string;
    demand_per_hour: number;
    capacity_per_hour_static: number;
    peak_queue: number;
    served: number;
  }>;
}

interface BlockState {
  blockId: string;
  terminalId: string;
  demandPerHour: number; // scenario demand rate during the stress window
  queue: number;
  peakQueue: number;
  served: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Allocate `pool` RTGs to blocks for one step under a strategy.
 * Greedy one-at-a-time by the strategy's priority; every strategy respects
 * maxRtgsPerBlock. Deterministic: stable priority with blockId tie-break.
 */
function allocate(
  strategy: StrategyId,
  blocks: BlockState[],
  arrivalsThisStep: number[],
  pool: number,
  p: RtgParams,
): number[] {
  const n = blocks.length;
  const alloc = new Array<number>(n).fill(0);
  const staticShare = Math.min(p.rtgsPerBlock, p.maxRtgsPerBlock);

  if (strategy === 'STATIC_HOME') {
    for (let i = 0; i < n; i++) alloc[i] = staticShare;
    return alloc;
  }

  const need = blocks.map((b, i) => b.queue + arrivalsThisStep[i]!);

  if (strategy === 'BALANCED_SPREAD') {
    // Largest-remainder proportional split of the pool over need, capped.
    const total = need.reduce((a, b) => a + b, 0);
    if (total === 0) {
      for (let i = 0; i < n; i++) alloc[i] = staticShare;
      return alloc;
    }
    const ideal = need.map((d) => (d / total) * pool);
    const floors = ideal.map((x) => Math.min(Math.floor(x), p.maxRtgsPerBlock));
    let used = floors.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) alloc[i] = floors[i]!;
    const remainders = ideal
      .map((x, i) => ({ i, r: x - Math.floor(x) }))
      .sort((a, b) => b.r - a.r || blocks[a.i]!.blockId.localeCompare(blocks[b.i]!.blockId));
    for (const { i } of remainders) {
      if (used >= pool) break;
      if (alloc[i]! < p.maxRtgsPerBlock) {
        alloc[i]!++;
        used++;
      }
    }
    return alloc;
  }

  // LONGEST_QUEUE / HIGHEST_UTILIZATION: assign one RTG at a time.
  const staticCap = staticShare * p.peakMovesPerHourPerRtg;
  for (let k = 0; k < pool; k++) {
    let best = -1;
    let bestPri = -Infinity;
    for (let i = 0; i < n; i++) {
      if (alloc[i]! >= p.maxRtgsPerBlock) continue;
      const remaining = need[i]! - alloc[i]! * p.peakMovesPerHourPerRtg * (STEP_MIN / 60);
      const pri =
        strategy === 'LONGEST_QUEUE'
          ? remaining
          : /* HIGHEST_UTILIZATION */ staticCap > 0
            ? (blocks[i]!.demandPerHour / staticCap) * 1000 + remaining
            : remaining;
      if (
        pri > bestPri ||
        (pri === bestPri && best >= 0 && blocks[i]!.blockId.localeCompare(blocks[best]!.blockId) < 0)
      ) {
        best = i;
        bestPri = pri;
      }
    }
    if (best < 0) break;
    alloc[best]!++;
  }
  return alloc;
}

/** Run the arrival-vs-service recursion for one strategy. */
function simulateStrategy(
  strategy: StrategyId,
  demand: Array<{ blockId: string; terminalId: string; demandPerHour: number }>,
  p: RtgParams,
): StrategyMetrics {
  const blocks: BlockState[] = demand.map((d) => ({
    ...d,
    queue: 0,
    peakQueue: 0,
    served: 0,
  }));
  const pool = blocks.length * p.rtgsPerBlock;
  const dtH = STEP_MIN / 60;
  const stressSteps = Math.round((p.stressHours * 60) / STEP_MIN);
  const maxSteps = Math.round((MAX_HORIZON_HOURS * 60) / STEP_MIN);

  let busyRtgHours = 0;
  let totalRtgHours = 0;
  let waitingBoxHours = 0;
  let delayedMoves = 0;
  let steps = 0;

  for (let s = 0; s < maxSteps; s++) {
    const inStress = s < stressSteps;
    if (!inStress && blocks.every((b) => b.queue === 0)) break;
    steps = s + 1;

    const arrivals = blocks.map((b) => (inStress ? b.demandPerHour * dtH : 0));
    const alloc = allocate(strategy, blocks, arrivals, pool, p);

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!;
      const capacity = alloc[i]! * p.peakMovesPerHourPerRtg * dtH;
      const workload = b.queue + arrivals[i]!;
      const served = Math.min(workload, capacity);
      const carried = workload - served;

      // FIFO: capacity clears the standing queue first, then this step's
      // arrivals. Arrivals that don't fit are the step's delayed moves.
      const servedFromArrivals = Math.max(0, Math.min(arrivals[i]!, capacity - b.queue));
      delayedMoves += arrivals[i]! - servedFromArrivals;
      b.queue = carried;
      b.peakQueue = Math.max(b.peakQueue, Math.ceil(carried));
      b.served += served;

      waitingBoxHours += carried * dtH;
      busyRtgHours += p.peakMovesPerHourPerRtg > 0 ? served / p.peakMovesPerHourPerRtg : 0;
      totalRtgHours += alloc[i]! * dtH;
    }
  }

  const horizonHours = steps * dtH;
  const movesServed = blocks.reduce((a, b) => a + b.served, 0);
  const idle = Math.max(0, totalRtgHours - busyRtgHours);
  const staticCapacityPerHour = Math.min(p.rtgsPerBlock, p.maxRtgsPerBlock) * p.peakMovesPerHourPerRtg;

  return {
    strategy,
    label: STRATEGY_LABELS[strategy],
    moves_served: Math.round(movesServed),
    utilization_pct: totalRtgHours > 0 ? round1((busyRtgHours / totalRtgHours) * 100) : 0,
    idle_rtg_hours: round2(idle),
    waiting_box_hours: round2(waitingBoxHours),
    avg_wait_min_per_move: movesServed > 0 ? round1((waitingBoxHours / movesServed) * 60) : 0,
    peak_queue: Math.max(0, ...blocks.map((b) => b.peakQueue)),
    delayed_moves: Math.round(delayedMoves),
    moves_per_rtg_hour: totalRtgHours > 0 ? round2(movesServed / totalRtgHours) : 0,
    throughput_moves_per_hour: horizonHours > 0 ? round1(movesServed / horizonHours) : 0,
    score: 0, // filled after normalisation across strategies
    per_block: blocks.map((b) => ({
      blockId: b.blockId,
      demand_per_hour: round1(b.demandPerHour),
      capacity_per_hour_static: staticCapacityPerHour,
      peak_queue: b.peakQueue,
      served: Math.round(b.served),
    })),
  };
}

/** Min-max normalise; when all strategies tie on a metric, everyone gets 0.5. */
function normalise(values: number[]): number[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / (hi - lo));
}

/**
 * Run the multi-block peak-RTG-demand scenario and rank the dispatch
 * strategies. Non-destructive by construction — reads the corpus, writes nothing.
 */
export function runRtgPeakScenario(input: RtgDispatchInput): Uc2AnswerResult {
  const p: RtgParams = {
    ...DEFAULT_RTG_PARAMS,
    ...input.params,
    weights: { ...DEFAULT_RTG_PARAMS.weights, ...input.params?.weights },
  };
  const blocks = input.blocks;
  const notes: string[] = [];
  const queries: Uc2Query[] = [];
  const assumptions: Uc2Assumption[] = [];

  // ---- parameter / selection validation -----------------------------------
  const bad: string[] = [];
  if (blocks.length === 0) bad.push('No yard blocks selected.');
  if (!(p.rtgsPerBlock > 0)) bad.push('rtgsPerBlock must be > 0 — the configured RTG fleet parameter is missing or zero, so peak capacity cannot be formed.');
  if (!(p.peakMovesPerHourPerRtg > 0)) bad.push('peakMovesPerHourPerRtg must be > 0 — no peak operational capacity can be formed without it.');
  if (!(p.maxRtgsPerBlock >= p.rtgsPerBlock)) bad.push('maxRtgsPerBlock must be ≥ rtgsPerBlock.');
  if (!(p.stressHours > 0)) bad.push('stressHours must be > 0.');
  if (bad.length > 0) {
    return {
      scenario: UC2_RTG_PEAK_ID,
      method: 'Not run — the selection or the capacity parameters are invalid.',
      result: {},
      figures: {},
      assumptions,
      queries,
      recommendations: [],
      data_available: false,
      notes: bad,
    };
  }

  // ---- 1. Demand derivation (DERIVED from measured events) ----------------
  const terminalIds = [...new Set(blocks.map((b) => b.terminalId))].sort();
  const hourly = new Map<string, Map<number, number>>(); // terminal → hourBucket → moves
  let eventRows = 0;
  for (const m of input.movements) {
    for (const e of m.trail) {
      if (!RTG_MOVE_EVENTS.has(e.eventType)) continue;
      if (!terminalIds.includes(e.facilityId)) continue;
      eventRows++;
      const bucket = Math.floor(new Date(e.ts).getTime() / 3_600_000);
      const t = hourly.get(e.facilityId) ?? new Map<number, number>();
      t.set(bucket, (t.get(bucket) ?? 0) + 1);
      hourly.set(e.facilityId, t);
    }
  }

  const peakByTerminal = new Map<string, number>();
  for (const t of terminalIds) {
    const buckets = hourly.get(t);
    peakByTerminal.set(t, buckets ? Math.max(0, ...buckets.values()) : 0);
  }

  queries.push({
    purpose: `Yard-crane-implying events per hour at ${terminalIds.join(', ')} (peak hour = demand basis)`,
    api: 'adapter.getContainerMovements({})',
    sql: `trail.filter(eventType IN (YARD_MOVE, GATE_IN, GATE_OUT) AND facilityId IN (${terminalIds.join(', ')})) GROUP BY facilityId, hour(ts)`,
    params: { terminals: terminalIds },
    row_count: eventRows,
  });

  const demand = blocks
    .map((b) => ({
      blockId: b.blockId,
      terminalId: b.terminalId,
      demandPerHour:
        ((peakByTerminal.get(b.terminalId) ?? 0) / BLOCKS_PER_TERMINAL) * p.demandMultiplier,
    }))
    .sort((a, b) => a.blockId.localeCompare(b.blockId));

  const staticCapacityPerBlock = p.rtgsPerBlock * p.peakMovesPerHourPerRtg;
  const anyOver = demand.some((d) => d.demandPerHour > staticCapacityPerBlock);
  const allZero = demand.every((d) => d.demandPerHour === 0);

  if (allZero) {
    notes.push(
      'The measured corpus contains no yard-crane-implying events at the selected terminals, so peak demand is zero and no queue can form. Select terminals with activity or raise the demand multiplier against a non-zero peak.',
    );
  }

  // ---- 2. Assumptions & parameters (declared) -----------------------------
  assumptions.push(
    {
      field: 'event_to_rtg_move_mapping',
      value: 'YARD_MOVE, GATE_IN, GATE_OUT → 1 RTG move each',
      reason:
        'No move-level equipment records exist. Each grounding/retrieval-implying event at the terminal is counted as one yard-crane move; rail-side events are excluded because trail rows attribute them to the siding, not the terminal.',
      source: 'ASSUMED',
    },
    {
      field: 'uniform_block_split',
      value: `terminal peak ÷ ${BLOCKS_PER_TERMINAL} blocks`,
      reason:
        'JNPA publish yard utilisation per terminal, not per block (panels/Pendency.tsx). Terminal peak demand is split uniformly across the nominal 12-block grid; the per-block spread is a declared assumption, not a measurement.',
      source: 'ASSUMED',
    },
    {
      field: 'rtgs_per_block',
      value: p.rtgsPerBlock,
      reason: 'No RTG register exists in this repository. Configured planning parameter (config/uc2-whatif.json), overridable per run.',
      source: 'PARAMETER',
    },
    {
      field: 'peak_moves_per_hour_per_rtg',
      value: p.peakMovesPerHourPerRtg,
      reason: 'No rated RTG productivity exists. Configured peak operational capacity parameter, overridable per run.',
      source: 'PARAMETER',
    },
    {
      field: 'max_rtgs_per_block',
      value: p.maxRtgsPerBlock,
      reason: 'Physical dispatch cap so no strategy stacks the whole fleet in one block. Configured parameter.',
      source: 'PARAMETER',
    },
    {
      field: 'demand_multiplier',
      value: p.demandMultiplier,
      reason: 'The stress lever: simultaneous hypothetical demand = observed peak-hour rate × this. Configured parameter.',
      source: 'PARAMETER',
    },
    {
      field: 'stress_hours',
      value: p.stressHours,
      reason: 'Duration the simultaneous peak is held before arrivals stop and queues drain. Configured parameter.',
      source: 'PARAMETER',
    },
    {
      field: 'scoring_weights',
      value: JSON.stringify(p.weights),
      reason:
        'Weights over the three stated objectives (minimise idle, reduce delays, maximise throughput) used to rank strategies. Configured parameter — nothing is hidden in the ranking.',
      source: 'PARAMETER',
    },
    {
      field: 'observed_peak_moves_per_hour',
      value: Object.fromEntries([...peakByTerminal.entries()].map(([k, v]) => [k, v])),
      reason: 'Maximum hourly count of yard-crane-implying events per selected terminal over the measured window.',
      source: 'DERIVED',
    },
  );

  notes.push(
    'Queueing model: the same deterministic arrival-vs-service recursion the gate forecast uses (packages/data/src/forecasts.ts) — 15-minute steps, queue carried forward, then drained after the stress window. Waiting time is DERIVED from this model (queue box-hours ÷ moves served); per-container arrival/service timestamps for yard moves do not exist in this corpus, and no per-container waiting time is claimed.',
    'A nearest-RTG / shortest-travel strategy is omitted: no travel-time or block-adjacency model exists in this repository, so it cannot be evaluated honestly. RTG re-positioning between blocks is treated as free for the same reason — stated here so the comparison is read with that limit in mind.',
    'No configured dispatch strategy exists in this repository; the static home-block assignment stands in as the de-facto current arrangement and is simulated as the baseline.',
    'Non-destructive: this simulation reads the movement corpus and writes nothing. No RTG assignment, yard allocation or operational record is changed, and no operational event is published.',
  );

  // ---- 3. Simulate every strategy -----------------------------------------
  const results = STRATEGY_ORDER.map((s) => simulateStrategy(s, demand, p));

  // ---- 4. Transparent scoring ---------------------------------------------
  // Objectives: minimise idle, minimise delay (waiting), maximise throughput.
  const idleN = normalise(results.map((r) => r.idle_rtg_hours));
  const waitN = normalise(results.map((r) => r.waiting_box_hours));
  const thrN = normalise(results.map((r) => r.moves_served));
  for (let i = 0; i < results.length; i++) {
    results[i]!.score = round2(
      p.weights.idle * (1 - idleN[i]!) +
        p.weights.delay * (1 - waitN[i]!) +
        p.weights.throughput * thrN[i]!,
    );
  }

  // Rank: score desc; ties broken by the documented fixed strategy order.
  const ranked = [...results].sort(
    (a, b) => b.score - a.score || STRATEGY_ORDER.indexOf(a.strategy) - STRATEGY_ORDER.indexOf(b.strategy),
  );
  const top1 = ranked[0]!;
  const top2 = ranked[1]!;
  const tied = top1.score === top2.score;
  if (tied) {
    notes.push(
      `Strategies ${top1.strategy} and ${top2.strategy} scored identically (${top1.score}); the documented fixed strategy order breaks the tie deterministically.`,
    );
  }

  const why = (r: StrategyMetrics): string[] => {
    const reasons: string[] = [];
    const best = (metric: (x: StrategyMetrics) => number, dir: 'min' | 'max') => {
      const vals = results.map(metric);
      const target = dir === 'min' ? Math.min(...vals) : Math.max(...vals);
      return metric(r) === target;
    };
    reasons.push(
      `${best((x) => x.idle_rtg_hours, 'min') ? 'Lowest' : 'Near-lowest'} idle time: ${r.idle_rtg_hours} RTG-hours idle`,
      `${best((x) => x.waiting_box_hours, 'min') ? 'Lowest' : 'Near-lowest'} waiting: ${r.waiting_box_hours} box-hours queued (avg ${r.avg_wait_min_per_move} min/move)`,
      `${best((x) => x.moves_served, 'max') ? 'Highest' : 'Near-highest'} throughput: ${r.moves_served} moves served (${r.throughput_moves_per_hour}/h)`,
    );
    return reasons;
  };

  // ---- 5. Figures ---------------------------------------------------------
  const baseline = results.find((r) => r.strategy === 'STATIC_HOME')!;
  const figures: Uc2AnswerResult['figures'] = {
    blocks_selected: blocks.length,
    terminals: terminalIds.join(', '),
    static_capacity_per_block_per_hour: staticCapacityPerBlock,
    demand_exceeds_capacity: anyOver,
    stress_hours: p.stressHours,
    demand_multiplier: p.demandMultiplier,
    baseline_utilization_pct: baseline.utilization_pct,
    baseline_waiting_box_hours: baseline.waiting_box_hours,
    baseline_peak_queue: baseline.peak_queue,
    rank1_strategy: top1.strategy,
    rank1_score: top1.score,
    rank1_idle_rtg_hours: top1.idle_rtg_hours,
    rank1_waiting_box_hours: top1.waiting_box_hours,
    rank1_moves_served: top1.moves_served,
    rank2_strategy: top2.strategy,
    rank2_score: top2.score,
    rank2_idle_rtg_hours: top2.idle_rtg_hours,
    rank2_waiting_box_hours: top2.waiting_box_hours,
    rank2_moves_served: top2.moves_served,
    scores_tied: tied,
  };

  return {
    scenario: UC2_RTG_PEAK_ID,
    method:
      `Demand: measured yard-crane-implying events per hour at ${terminalIds.join(', ')}; the peak hour, split uniformly over the 12-block grid and scaled ×${p.demandMultiplier}, is held simultaneously on all ${blocks.length} selected blocks for ${p.stressHours} h. ` +
      `Capacity: rtgsPerBlock × peakMovesPerHourPerRtg (${p.rtgsPerBlock} × ${p.peakMovesPerHourPerRtg} = ${staticCapacityPerBlock} moves/h per block), all parameters declared. ` +
      'Each dispatch strategy re-allocates the shared RTG pool every 15-minute step of the same arrival-vs-service recursion the gate forecast uses; utilization, idle time, waiting, queues, productivity and throughput fall out of the recursion. ' +
      `Ranking: score = ${p.weights.idle}·(1−idle) + ${p.weights.delay}·(1−waiting) + ${p.weights.throughput}·throughput over min-max-normalised metrics; ties break by the documented fixed order.`,
    result: {
      blocks: demand.map((d) => ({
        ...d,
        demand_per_hour: round1(d.demandPerHour),
        capacity_per_hour: staticCapacityPerBlock,
        over_capacity: d.demandPerHour > staticCapacityPerBlock,
      })),
      strategies: results,
      ranking: ranked.map((r, i) => ({ rank: i + 1, strategy: r.strategy, score: r.score })),
      recommendation: {
        rank1: { strategy: top1.strategy, label: top1.label, score: top1.score, why: why(top1) },
        rank2: { strategy: top2.strategy, label: top2.label, score: top2.score, why: why(top2) },
      },
      weights: p.weights,
      unavailable: [
        'RTG register (count, ids, status)',
        'rated RTG productivity / configured peak capacity feed',
        'per-block occupancy or workload (terminal-level only)',
        'per-container yard waiting timestamps',
        'RTG travel-time / block-adjacency model',
      ],
    },
    figures,
    assumptions,
    queries,
    recommendations: [
      {
        action: `adopt_${top1.strategy.toLowerCase()}`,
        reason: `Rank #1 — ${why(top1).join('; ')}.`,
      },
      {
        action: `fallback_${top2.strategy.toLowerCase()}`,
        reason: `Rank #2 — ${why(top2).join('; ')}.`,
      },
    ],
    data_available: true,
    notes,
  };
}
