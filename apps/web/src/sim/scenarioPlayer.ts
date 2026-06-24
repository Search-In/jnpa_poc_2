/**
 * scenarioPlayer — turns each What-If scenario (§12: CGO-1/2/3 + lane-assign)
 * into a *guided, timed playback* that drives the live board instead of a
 * static before/after card. Running a scenario:
 *   1. seeds simStore levers to a clean baseline for the scenario,
 *   2. steps through a short storyline; each step pushes real sim overrides
 *      (gate queues, pendency, scan depth, movement rate, rail) so every panel,
 *      the KPI strip and the map halos animate in real time,
 *   3. carries, per step, plain-language coach-mark copy + an anchor (which
 *      dashboard tab + which map asset to spotlight) so a non-port-ops viewer
 *      can follow *what* is changing and *why*.
 *
 * The whole thing is deterministic (no Date.now / Math.random) and reversible —
 * `simStore.stopScenario()` clears every override back to baseline.
 */

/** Which dashboard tab a step is about (matches Dashboard TABS ids). */
export type TabId =
  | 'movements' | 'rail' | 'gate' | 'pendency'
  | 'scan' | 'empty' | 'scenarios' | 'health' | 'notifications';

/** A single human-readable metric change surfaced in the coach-mark. */
export interface MetricChange {
  /** Short label, e.g. "Gate NSICT-G1 queue". */
  label: string;
  /** Value before this step. */
  from: number | string;
  /** Value after this step. */
  to: number | string;
  /** Unit suffix, e.g. "trucks", "min", "containers". */
  unit?: string;
  /** Direction the operator should read this as. */
  tone: 'worse' | 'better' | 'neutral';
}

/** A patch applied to simStore when a step fires (all optional, additive). */
export interface StepPatch {
  gates?: Record<string, { queueLength?: number; avgTxnTimeMin?: number }>;
  pendency?: Record<string, number>;
  rail?: Record<string, { inboundQueue?: number; placed?: number }>;
  movementRate?: number;
  scanQueue?: number | null;
  emptyDelta?: number;
}

/**
 * A precise, value-level highlight target. Resolves to a single DOM node on the
 * dashboard (a KPI card, a gate/facility table row) that the coach-mark rings
 * and tags with the live value — so the viewer sees the *exact* number moving,
 * not just the panel it lives in.
 */
export type ValueTarget =
  /** A KPI strip card, by KPI key (matches KpiResult.key / data-kpi). */
  | { kind: 'kpi'; key: string }
  /** A gate/facility table row, by asset id (matches data-asset). */
  | { kind: 'asset'; id: string };

export interface ScenarioStep {
  /** Coach-mark title — what's happening, in plain words. */
  title: string;
  /** One or two sentences a non-expert can follow. */
  explain: string;
  /** Which dashboard tab to switch to + spotlight for this step. */
  tab: TabId;
  /** Map asset ids to spotlight (gates/facilities/terminals). [] = none. */
  spotlight: string[];
  /**
   * Exact dashboard values to ring (KPI cards / table rows). The coach-mark
   * pulses a tight ring around each and pins the live number to it.
   */
  valueTargets?: ValueTarget[];
  /** Metric deltas shown as little chips in the coach-mark. */
  metrics: MetricChange[];
  /** Sim overrides this step writes (drives the live board + map). */
  patch: StepPatch;
  /** Optional automated-action tag shown as a badge (the "so the system did X"). */
  action?: { kind: string; detail: string };
}

export interface ScenarioScript {
  id: string;
  /** Title shown on the launcher card + tour header. */
  title: string;
  /** One-line "what this explores" for the launcher card. */
  blurb: string;
  /** Calcite icon for the launcher card. */
  icon: string;
  /** Ordered storyline. */
  steps: ScenarioStep[];
}

// Real asset ids from config/terminals.json + the mock facilities, so the map
// spotlights land exactly on drawn markers.
const G_NSICT = 'NSICT-G1';
const G_GTI = 'GTI-G2';
const CFS = 'CFS-PUNE';

/**
 * The four §8.4.5 scenarios as guided storylines. Numbers are illustrative but
 * directionally faithful to scenarios-mock.ts (the same KPI levers move).
 */
export const SCENARIO_SCRIPTS: ScenarioScript[] = [
  {
    id: 'CGO-1',
    title: 'CFS Pendency Spike',
    blurb: 'A container yard fills up faster than it clears — watch the backlog ripple to the rail side.',
    icon: 'exclamation-mark-triangle',
    steps: [
      {
        title: 'A backlog starts building at the CFS',
        explain:
          'Containers are arriving at the Pune CFS faster than they are being cleared. The pile of waiting containers ("pendency") begins to climb.',
        tab: 'pendency',
        spotlight: [CFS],
        valueTargets: [{ kind: 'asset', id: CFS }],
        metrics: [{ label: 'CFS Pune backlog', from: 60, to: 150, unit: 'containers', tone: 'worse' }],
        patch: { pendency: { [CFS]: 150 } },
      },
      {
        title: 'The system raises an alert',
        explain:
          'The backlog crosses the safe threshold (50). The twin automatically alerts the Terminal Operations team — no one had to be watching the screen.',
        tab: 'notifications',
        spotlight: [CFS],
        metrics: [{ label: 'Backlog vs. threshold', from: '150 / 50', to: 'ALERT', tone: 'worse' }],
        patch: { pendency: { [CFS]: 168 } },
        action: { kind: 'NOTIFICATION', detail: 'Alert raised to TERMINAL_OPS — CFS Pune pendency over threshold' },
      },
      {
        title: 'Rail departures feel the strain',
        explain:
          'Because the yard is congested, rakes take longer to load and turn around. You can see rake turnaround time tick up in the KPI strip.',
        tab: 'rail',
        spotlight: [CFS],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [{ label: 'Rake turnaround time', from: 18, to: 20, unit: 'hrs', tone: 'worse' }],
        patch: { pendency: { [CFS]: 168 }, rail: { T1: { inboundQueue: 4 } } },
      },
      {
        title: 'Recommendation: re-sequence loading',
        explain:
          'The twin recommends re-sequencing rake loading to drain the CFS buffer before the next departure. Apply it and the backlog starts to ease.',
        tab: 'pendency',
        spotlight: [CFS],
        valueTargets: [{ kind: 'asset', id: CFS }],
        metrics: [{ label: 'CFS Pune backlog', from: 168, to: 95, unit: 'containers', tone: 'better' }],
        patch: { pendency: { [CFS]: 95 }, rail: { T1: { inboundQueue: 1 } } },
        action: { kind: 'RECOMMENDATION', detail: 'Re-sequence rake loading to drain the CFS buffer first' },
      },
    ],
  },
  {
    id: 'CGO-2',
    title: 'Customs Flag Surge → UC-3',
    blurb: 'A spike in customs-flagged boxes jams the scanner and gate — the twin defers trucks via the UC-3 app.',
    icon: 'security',
    steps: [
      {
        title: 'Customs flags a surge of containers',
        explain:
          'A wave of containers gets flagged for customs scanning. The scan queue depth jumps, so boxes start waiting for the scanner.',
        tab: 'scan',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'kpi', key: 'scannerTurnaroundTime' }],
        metrics: [{ label: 'Pending scans', from: 8, to: 45, unit: 'boxes', tone: 'worse' }],
        patch: { scanQueue: 45 },
      },
      {
        title: 'The gate backs up',
        explain:
          'Trucks carrying flagged boxes can\'t clear until they\'re scanned, so the queue at gate NSICT-G1 grows and transaction time rises.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [
          { label: 'Gate NSICT-G1 queue', from: 6, to: 22, unit: 'trucks', tone: 'worse' },
          { label: 'Gate txn time', from: 4.0, to: 4.8, unit: 'min', tone: 'worse' },
        ],
        patch: { scanQueue: 45, gates: { [G_NSICT]: { queueLength: 22, avgTxnTimeMin: 4.8 } } },
      },
      {
        title: 'Gate-Queue Forecaster re-runs',
        explain:
          'The twin re-runs its gate-queue forecast and predicts the jam will last ~90 minutes if nothing changes.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }],
        metrics: [{ label: 'Predicted jam', from: '—', to: '~90 min', tone: 'neutral' }],
        patch: { scanQueue: 48, gates: { [G_NSICT]: { queueLength: 24, avgTxnTimeMin: 5.0 } } },
        action: { kind: 'FORECAST_RERUN', detail: 'Gate-queue forecaster re-run for NSICT-G1 after the surge' },
      },
      {
        title: 'Cross-twin: defer trucks via UC-3',
        explain:
          'The twin pushes a "deferred-arrival window" to the UC-3 Trucking App, telling drivers to arrive later. Fewer trucks show up early, so the gate queue eases.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [{ label: 'Gate NSICT-G1 queue', from: 24, to: 11, unit: 'trucks', tone: 'better' }],
        patch: { scanQueue: 30, gates: { [G_NSICT]: { queueLength: 11, avgTxnTimeMin: 4.2 } } },
        action: { kind: 'CROSS_TWIN_PUSH', detail: 'Deferred-arrival window pushed to the UC-3 Trucking App' },
      },
    ],
  },
  {
    id: 'CGO-3',
    title: 'Inter-Terminal Optimisation',
    blurb: 'Smart routing of empties between T1 and T2 cuts empty-rake time and improves mixed-train loading.',
    icon: 'route-from',
    steps: [
      {
        title: 'Empties are scattered across terminals',
        explain:
          'Empty containers needed at T2 are sitting at T1 (and vice-versa). Moving them inefficiently wastes rake time.',
        tab: 'rail',
        spotlight: ['GTI', 'BMCT'],
        valueTargets: [{ kind: 'kpi', key: 'interTerminalTransferTat' }],
        metrics: [{ label: 'Inter-terminal transfer TAT', from: 6.0, to: 6.0, unit: 'hrs', tone: 'neutral' }],
        patch: { rail: { T1: { inboundQueue: 5 }, T2: { inboundQueue: 4 } } },
      },
      {
        title: 'The twin re-routes the empties',
        explain:
          'The optimiser consolidates empty moves between T1 and T2. This trims empty-rake turnaround by 8–12%.',
        tab: 'rail',
        spotlight: ['GTI', 'BMCT'],
        valueTargets: [{ kind: 'kpi', key: 'interTerminalTransferTat' }, { kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [{ label: 'Empty-rake TAT', from: 6.0, to: 5.4, unit: 'hrs', tone: 'better' }],
        patch: { rail: { T1: { inboundQueue: 2 }, T2: { inboundQueue: 2 } }, movementRate: 1.3 },
        action: { kind: 'OPTIMISATION', detail: 'ITRHO re-routing yields ~10% empty-rake-TAT reduction' },
      },
      {
        title: 'Mixed-train loading improves',
        explain:
          'With empties where they\'re needed, more containers share each outbound rake — the Mixed-Train Optimization KPI climbs.',
        tab: 'movements',
        spotlight: ['GTI', 'BMCT'],
        valueTargets: [{ kind: 'kpi', key: 'mixedTrainOptimization' }],
        metrics: [{ label: 'Mixed-train optimisation', from: 72, to: 79, unit: '%', tone: 'better' }],
        patch: { rail: { T1: { inboundQueue: 1 }, T2: { inboundQueue: 1 } }, movementRate: 1.5 },
        action: { kind: 'RECOMMENDATION', detail: 'Consolidate mixed-terminal containers onto shared outbound rakes' },
      },
    ],
  },
  {
    id: 'LANE-ASSIGN',
    title: 'Dynamic Lane Assignment',
    blurb: 'Road congestion at a gate triggers a live lane re-assignment that cuts transaction time.',
    icon: 'car',
    steps: [
      {
        title: 'A gate gets congested',
        explain:
          'Traffic builds up at gate GTI-G2. The queue grows and each truck takes longer to process.',
        tab: 'gate',
        spotlight: [G_GTI],
        valueTargets: [{ kind: 'asset', id: G_GTI }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [
          { label: 'Gate GTI-G2 queue', from: 7, to: 20, unit: 'trucks', tone: 'worse' },
          { label: 'Gate txn time', from: 4.2, to: 5.1, unit: 'min', tone: 'worse' },
        ],
        patch: { gates: { [G_GTI]: { queueLength: 20, avgTxnTimeMin: 5.1 } } },
      },
      {
        title: 'The twin reassigns lanes',
        explain:
          'Two lanes are diverted from the busy gate to the adjacent one and trucks are rerouted — balancing the load in real time.',
        tab: 'gate',
        spotlight: [G_GTI],
        valueTargets: [{ kind: 'asset', id: G_GTI }],
        metrics: [{ label: 'Gate GTI-G2 queue', from: 20, to: 12, unit: 'trucks', tone: 'better' }],
        patch: { gates: { [G_GTI]: { queueLength: 12, avgTxnTimeMin: 4.4 } } },
        action: { kind: 'LANE_ASSIGNMENT', detail: 'Divert 2 lanes from GTI-G2 to the adjacent gate; reroute trailers' },
      },
      {
        title: 'Transaction time drops ~18%',
        explain:
          'With the load spread out, the average gate transaction time falls by about 18%. Watch the gate KPI recover.',
        tab: 'gate',
        spotlight: [G_GTI],
        valueTargets: [{ kind: 'asset', id: G_GTI }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [{ label: 'Gate txn time', from: 5.1, to: 4.2, unit: 'min', tone: 'better' }],
        patch: { gates: { [G_GTI]: { queueLength: 9, avgTxnTimeMin: 4.2 } } },
        action: { kind: 'RECOMMENDATION', detail: 'Dynamic lane reassignment cuts avg gate transaction time ~18%' },
      },
    ],
  },
];

export function getScript(id: string): ScenarioScript | undefined {
  return SCENARIO_SCRIPTS.find((s) => s.id === id);
}
