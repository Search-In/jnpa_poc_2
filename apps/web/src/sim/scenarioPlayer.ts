/**
 * scenarioPlayer — turns each What-If scenario (§8.2: S1–S6) into a
 * *guided, timed playback* that drives the live board instead of a
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
  | 'import' | 'export'
  | 'gate' | 'pendency' | 'rail' | 'itrho' | 'empty' | 'cfsecy' | 'movements'
  | 'scenarios' | 'workflows' | 'models' | 'health' | 'dataquality'
  | 'notifications' | 'methodology';

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
import type { LifecycleHandoff } from './lifecycleHandoff.js';

export interface StepPatch {
  gates?: Record<string, { queueLength?: number; avgTxnTimeMin?: number; openLanes?: number }>;
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
  /**
   * Optional sub-view within that tab, for the tabs whose lifecycle steps are
   * sub-views (Import: `igm|scan|ooc|edo|smtp`; Export: `list|docs|sb|leo|…`).
   * Without it the tab opens on its own default, which for a step that narrates a
   * specific register would land the viewer one click short of what it describes.
   */
  view?: string;
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
  /**
   * Where this disruption continues once THIS twin has told its part. Absent on a
   * scenario whose consequences stay inside cargo — see ./lifecycleHandoff.
   */
  handoff?: LifecycleHandoff;
}

// Real asset ids from config/terminals.json + the mock facilities, so the map
// spotlights land exactly on drawn markers. (Sidings T1/T2 are RAIL_SIDING
// facilities with Point geoms — highlightGraphics resolves them like any CFS.)
const G_NSICT = 'NSICT-G1';
const CFS_DRONAGIRI = 'CFS-DRONAGIRI-1';
const CFS_URAN = 'CFS-URAN-1';
const CFS_PANVEL = 'CFS-PANVEL-1';

/**
 * The six §8.2 named scenarios (S1–S6) as guided storylines. Numbers are
 * illustrative, deterministic and directionally faithful to the twin-vs-shadow
 * A/B parameter sets in scenarios-mock.ts (the same KPI levers move). Every
 * improvement shown is *within simulation* — a modelled target under stated
 * assumptions, never a claimed JNPA baseline.
 */
export const SCENARIO_SCRIPTS: ScenarioScript[] = [
  // ── S1 · Rake Delay Cascade ────────────────────────────────────────────────
  {
    id: 'S1',
    title: 'Rake Delay Cascade',
    blurb: 'One inbound rake runs 6 hours late — watch the delay cascade through siding slots to an export cut-off, and how the twin re-routes around it.',
    icon: 'clock-forward',
    steps: [
      {
        title: 'An inbound rake slips 6 hours',
        explain:
          'A loaded import rake headed for siding T1 reports a 6-hour delay en route. On its own that sounds small — but the siding slot it was booked into is now dead time, and everything behind it starts to shuffle.',
        tab: 'rail',
        spotlight: ['T1'],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [{ label: 'Inbound rake ETA', from: 'on time', to: '+6 h', tone: 'worse' }],
        patch: { rail: { T1: { inboundQueue: 3 } } },
      },
      {
        title: 'Siding slots start to conflict',
        explain:
          'The late rake now lands in the same window as the next two scheduled placements at T1. Rakes queue outside the siding, and simulated rake turnaround climbs from 18 to 21 hours.',
        tab: 'rail',
        spotlight: ['T1'],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [
          { label: 'T1 inbound rake queue', from: 2, to: 5, unit: 'rakes', tone: 'worse' },
          { label: 'Rake turnaround (simulated)', from: 18, to: 21, unit: 'hrs', tone: 'worse' },
        ],
        patch: { rail: { T1: { inboundQueue: 5, placed: 1 } } },
      },
      {
        title: 'Export boxes risk missing their vessel',
        explain:
          'Among the shuffled rakes is an export load for a GTI vessel with a fixed cut-off. In this simulation about 180 boxes would miss the ship if nothing changes — mixed-train loading efficiency drops too, because connections break.',
        tab: 'rail',
        spotlight: ['GTI', 'T1'],
        valueTargets: [{ kind: 'kpi', key: 'mixedTrainOptimization' }],
        metrics: [
          { label: 'Export boxes at cut-off risk (simulated)', from: 0, to: 180, unit: 'boxes', tone: 'worse' },
          { label: 'Mixed-train optimisation (simulated)', from: 72, to: 66, unit: '%', tone: 'worse' },
        ],
        patch: { rail: { T1: { inboundQueue: 5, placed: 1 } }, movementRate: 0.85 },
      },
      {
        title: 'The twin re-routes: ITRHO + priority placement',
        explain:
          'The twin recommends moving the at-risk export boxes by ITRHO road shuttle to GTI and giving the late rake priority placement at T2 instead of waiting for T1. In this simulation rake turnaround recovers from 21 to 19 hours and cut-off exposure drops to ~25 boxes — a modelled outcome under the stated assumptions, not a claimed JNPA baseline.',
        tab: 'rail',
        spotlight: ['GTI', 'T2'],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }, { kind: 'kpi', key: 'mixedTrainOptimization' }],
        metrics: [
          { label: 'Rake turnaround (simulated)', from: 21, to: 19, unit: 'hrs', tone: 'better' },
          { label: 'Export boxes at cut-off risk (simulated)', from: 180, to: 25, unit: 'boxes', tone: 'better' },
          { label: 'Mixed-train optimisation (simulated)', from: 66, to: 71, unit: '%', tone: 'better' },
        ],
        patch: { rail: { T1: { inboundQueue: 2, placed: 3 }, T2: { inboundQueue: 2, placed: 2 } }, movementRate: 1.15 },
        action: { kind: 'OPTIMISATION', detail: 'Simulated: ITRHO re-route of at-risk exports to GTI + priority placement of the delayed rake at T2' },
      },
    ],
  },

  // ── S2 · Customs Flag Surge → UC-3 (ports CGO-2 verbatim in meaning) ──────
  {
    id: 'S2',
    title: 'Customs Flag Surge → UC-3',
    blurb: 'A spike in customs-flagged boxes jams the scanner and gate — the twin defers trucks via the UC-3 app.',
    icon: 'security',
    steps: [
      {
        title: 'Customs flags a surge of containers',
        explain:
          'A wave of containers gets flagged for customs scanning. The scan queue depth jumps, so boxes start waiting for the scanner.',
        // The scan queue is now Import step 5, so the step opens that view
        // directly rather than the Import tab's overview.
        tab: 'import',
        view: 'scan',
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
          'The twin pushes a "deferred-arrival window" to the UC-3 Trucking App, telling drivers to arrive later. Fewer trucks show up early, so the gate queue eases — a simulated recovery under the stated assumptions.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [{ label: 'Gate NSICT-G1 queue (simulated)', from: 24, to: 11, unit: 'trucks', tone: 'better' }],
        patch: { scanQueue: 30, gates: { [G_NSICT]: { queueLength: 11, avgTxnTimeMin: 4.2 } } },
        action: { kind: 'CROSS_TWIN_PUSH', detail: 'Deferred-arrival window pushed to the UC-3 Trucking App' },
      },
    ],
  },

  // ── S3 · Mixed-Train Optimisation ─────────────────────────────────────────
  {
    id: 'S3',
    title: 'Mixed-Train Optimisation',
    blurb: 'One 90-wagon rake carries boxes for three terminals — compare a naive terminal-by-terminal split with the twin\'s batched ITRHO plan.',
    icon: 'route-from',
    steps: [
      {
        title: 'A 90-wagon mixed rake arrives',
        explain:
          'A single inbound rake carries containers for three different terminals: 40 wagons for GTI, 30 for NSICT and 20 for BMCT. Somehow those boxes have to be split across the port — the question is how.',
        tab: 'rail',
        spotlight: ['GTI', 'NSICT', 'BMCT'],
        valueTargets: [{ kind: 'kpi', key: 'mixedTrainOptimization' }],
        metrics: [{ label: 'Wagons on mixed rake', from: '—', to: '90 (40 / 30 / 20)', tone: 'neutral' }],
        patch: { rail: { T1: { inboundQueue: 3 } } },
      },
      {
        title: 'The naive plan: three separate shunt cycles',
        explain:
          'Handled naively, the rake is shunted and worked once per terminal, in sequence. Each cycle blocks the siding, so in this simulation inter-terminal transfer time stretches from 6.0 to 6.9 hours and the rake sits 10% longer overall.',
        tab: 'rail',
        spotlight: ['T1'],
        valueTargets: [{ kind: 'kpi', key: 'interTerminalTransferTat' }, { kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [
          { label: 'Inter-terminal transfer TAT (naive, simulated)', from: 6.0, to: 6.9, unit: 'hrs', tone: 'worse' },
          { label: 'Rake turnaround (naive, simulated)', from: 18.0, to: 19.8, unit: 'hrs', tone: 'worse' },
        ],
        patch: { rail: { T1: { inboundQueue: 5, placed: 1 } }, movementRate: 0.9 },
      },
      {
        title: 'The twin computes an optimised split plan',
        explain:
          'The optimiser batches the split: the largest block (GTI) is worked at the siding while NSICT and BMCT boxes move in parallel by ITRHO shuttle, sequenced to reuse the same trailer loops. Simulated transfer time comes back to 5.2 hours — a modelled result under the stated assumptions, not a claimed JNPA baseline.',
        tab: 'movements',
        spotlight: ['GTI', 'NSICT', 'BMCT'],
        valueTargets: [{ kind: 'kpi', key: 'interTerminalTransferTat' }],
        metrics: [{ label: 'Inter-terminal transfer TAT (simulated)', from: 6.9, to: 5.2, unit: 'hrs', tone: 'better' }],
        patch: { rail: { T1: { inboundQueue: 2, placed: 3 } }, movementRate: 1.3 },
        action: { kind: 'OPTIMISATION', detail: 'Simulated: batched split plan — GTI block at siding, NSICT + BMCT blocks via parallel ITRHO shuttle loops' },
      },
      {
        title: 'Turnaround and mixed-train KPIs respond',
        explain:
          'With the batched plan, the whole rake clears sooner and more of each outbound rake is usefully filled. Within simulation, rake turnaround moves 19.8 → 17.6 hours and the Mixed-Train Optimization KPI 72% → 80% — modelled targets under stated assumptions.',
        tab: 'movements',
        spotlight: ['GTI', 'NSICT', 'BMCT'],
        valueTargets: [
          { kind: 'kpi', key: 'rakeTurnaroundTime' },
          { kind: 'kpi', key: 'interTerminalTransferTat' },
          { kind: 'kpi', key: 'mixedTrainOptimization' },
        ],
        metrics: [
          { label: 'Rake turnaround (simulated)', from: 19.8, to: 17.6, unit: 'hrs', tone: 'better' },
          { label: 'Mixed-train optimisation (simulated)', from: 72, to: 80, unit: '%', tone: 'better' },
        ],
        patch: { rail: { T1: { inboundQueue: 1, placed: 4 } }, movementRate: 1.4 },
        action: { kind: 'RECOMMENDATION', detail: 'Adopt batched mixed-rake split plans as the default for 3-terminal rakes' },
      },
    ],
  },

  // ── S4 · Gate Closure / Congestion → Dynamic Lane (supersedes LANE-ASSIGN) ─
  {
    id: 'S4',
    title: 'Gate Closure → Dynamic Lane Assignment',
    blurb: 'NSICT\'s gate loses 3 of 6 lanes for 4 hours — the twin re-balances lanes and throttles CPP releases to absorb the hit.',
    icon: 'car',
    steps: [
      {
        title: 'Half the gate goes dark',
        explain:
          'A maintenance fault closes 3 of the 6 lanes at gate NSICT-G1 for the next 4 hours. The same truck flow now has to squeeze through half the capacity.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }],
        metrics: [
          { label: 'Open lanes at NSICT-G1', from: 6, to: 3, tone: 'worse' },
          { label: 'Gate NSICT-G1 queue', from: 6, to: 14, unit: 'trucks', tone: 'worse' },
        ],
        patch: { gates: { [G_NSICT]: { queueLength: 14, avgTxnTimeMin: 4.6, openLanes: 3 } } },
      },
      {
        title: 'The queue peaks',
        explain:
          'Within the hour the queue more than doubles and each truck takes longer to process. Left alone, this backs up onto the approach road.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [
          { label: 'Gate NSICT-G1 queue', from: 14, to: 28, unit: 'trucks', tone: 'worse' },
          { label: 'Gate txn time (simulated)', from: 4.6, to: 5.8, unit: 'min', tone: 'worse' },
        ],
        patch: { gates: { [G_NSICT]: { queueLength: 28, avgTxnTimeMin: 5.8, openLanes: 3 } } },
      },
      {
        title: 'The twin acts: re-assign lanes, throttle releases',
        explain:
          'Two moves at once: exit lanes are dynamically re-assigned to entry duty at NSICT-G1, and CPP container releases feeding this gate are throttled so fewer trucks are dispatched into the jam. The queue starts to drain.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }],
        metrics: [
          { label: 'Gate NSICT-G1 queue (simulated)', from: 28, to: 16, unit: 'trucks', tone: 'better' },
        ],
        patch: { gates: { [G_NSICT]: { queueLength: 16, avgTxnTimeMin: 4.9, openLanes: 5 } } },
        action: { kind: 'LANE_ASSIGNMENT', detail: 'Re-assign 2 exit lanes to entry at NSICT-G1 + throttle CPP releases feeding the gate for 4 h' },
      },
      {
        title: 'Simulated transaction time recovers',
        explain:
          'With lanes re-balanced and arrivals throttled, simulated gate transaction time moves 5.8 → 4.3 min within simulation — a modelled result under the stated assumptions, not a claimed JNPA baseline. The lane outage is still there; the twin just spent the capacity smarter.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }, { kind: 'kpi', key: 'gateTransactionTime' }],
        metrics: [
          { label: 'Gate txn time (simulated)', from: 5.8, to: 4.3, unit: 'min', tone: 'better' },
          { label: 'Gate NSICT-G1 queue (simulated)', from: 16, to: 9, unit: 'trucks', tone: 'better' },
        ],
        patch: { gates: { [G_NSICT]: { queueLength: 9, avgTxnTimeMin: 4.3, openLanes: 5 } } },
        action: { kind: 'RECOMMENDATION', detail: 'Simulated: dynamic lane re-assignment + CPP throttling → gate txn time 5.8 → 4.3 min within simulation' },
      },
    ],
  },

  // ── S5 · Trailer-Driver Shortage — the showpiece (absorbs CGO-1) ──────────
  {
    id: 'S5',
    title: 'Trailer-Driver Shortage',
    blurb: 'A 30% trailer-driver shortage for 10 days — a reconstruction of a recent industry-wide event class within the twin, and the intervention bundle that bends the pendency curve.',
    icon: 'users',
    steps: [
      {
        title: 'Day 1: a third of the trailer fleet stops moving',
        explain:
          'Trailer-driver availability drops 30% across the CFS fleet and stays there for 10 simulated days. This mirrors a recent industry-wide event class, reconstructed inside the twin — every number here is simulated, not a recorded JNPA figure. Evacuation from the CFSs immediately slows.',
        tab: 'pendency',
        spotlight: [CFS_DRONAGIRI, CFS_URAN, CFS_PANVEL],
        valueTargets: [{ kind: 'kpi', key: 'bufferPendency' }],
        metrics: [
          { label: 'Trailer-driver availability (simulated)', from: 100, to: 70, unit: '%', tone: 'worse' },
          { label: 'CFS Dronagiri-1 backlog (simulated)', from: 60, to: 120, unit: 'containers', tone: 'worse' },
        ],
        patch: {
          pendency: { [CFS_DRONAGIRI]: 120, [CFS_URAN]: 95, [CFS_PANVEL]: 88 },
          movementRate: 0.7,
        },
      },
      {
        title: 'Day 4: the backlog starts to age',
        explain:
          'Boxes that would normally clear in days now sit still. The dangerous number isn\'t total pendency — it\'s the ageing bucket: containers stuck more than 15 days, which attract detention and clog every yard slot behind them. In this simulation that bucket goes from essentially zero to ~800 boxes.',
        tab: 'pendency',
        spotlight: [CFS_DRONAGIRI, CFS_URAN],
        valueTargets: [{ kind: 'asset', id: CFS_DRONAGIRI }, { kind: 'kpi', key: 'bufferPendency' }],
        metrics: [
          { label: '>15-day pendency bucket (simulated)', from: '~0', to: '~800', unit: 'boxes', tone: 'worse' },
          { label: 'CFS Dronagiri-1 backlog (simulated)', from: 120, to: 170, unit: 'containers', tone: 'worse' },
        ],
        patch: {
          pendency: { [CFS_DRONAGIRI]: 170, [CFS_URAN]: 140, [CFS_PANVEL]: 120 },
          movementRate: 0.65,
        },
      },
      {
        title: 'Day 7: peak — the shortage reaches the rail side',
        explain:
          'At the peak, the simulated >15-day bucket hits ~2,500 boxes across the CFS network. And the pain spreads: with trailers scarce, rakes wait for loads that can\'t be positioned, so rake turnaround stretches from 18 to 22 hours within simulation.',
        tab: 'rail',
        spotlight: ['T1', 'T2'],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }, { kind: 'kpi', key: 'bufferPendency' }],
        metrics: [
          { label: '>15-day bucket (simulated)', from: '~800', to: '~2,500', unit: 'boxes', tone: 'worse' },
          { label: 'Rake turnaround (simulated)', from: 18, to: 22, unit: 'hrs', tone: 'worse' },
        ],
        patch: {
          pendency: { [CFS_DRONAGIRI]: 195, [CFS_URAN]: 160, [CFS_PANVEL]: 140 },
          rail: { T1: { inboundQueue: 6, placed: 1 }, T2: { inboundQueue: 5, placed: 1 } },
          movementRate: 0.6,
        },
      },
      {
        title: 'The twin proposes an intervention bundle',
        explain:
          'No single lever fixes a fleet-wide shortage, so the twin stacks four: convert eligible CFS boxes to Direct Port Delivery (skipping the CFS leg entirely), add extra rail evacuation rakes, waive ITRHO restrictions so any available trailer can serve any terminal, and green-channel the oldest boxes for priority evacuation.',
        tab: 'rail',
        spotlight: ['T1', 'T2', CFS_DRONAGIRI],
        valueTargets: [{ kind: 'kpi', key: 'rakeTurnaroundTime' }],
        metrics: [
          { label: 'Extra evacuation rakes/day (simulated)', from: 0, to: 3, tone: 'better' },
          { label: 'Rake turnaround (simulated)', from: 22, to: 19.5, unit: 'hrs', tone: 'better' },
        ],
        patch: {
          pendency: { [CFS_DRONAGIRI]: 150, [CFS_URAN]: 120, [CFS_PANVEL]: 100 },
          rail: { T1: { inboundQueue: 3, placed: 3 }, T2: { inboundQueue: 3, placed: 2 } },
          movementRate: 0.95,
        },
        action: { kind: 'RECOMMENDATION', detail: 'Intervention bundle: CFS→DPD conversion + 3 extra evacuation rakes/day + ITRHO waiver + green-channel for >15-day boxes' },
      },
      {
        title: 'Day 10: the ageing curve bends',
        explain:
          'With the bundle applied, the simulated >15-day bucket falls from ~2,500 to ~450 boxes by day 10 — the curve bends instead of compounding. All of this is a modelled reconstruction under stated assumptions (30% driver shortage, 10 days, four interventions) — not a claimed JNPA baseline. The point is that the twin lets you rehearse this playbook before the next real shortage.',
        tab: 'pendency',
        spotlight: [CFS_DRONAGIRI, CFS_URAN, CFS_PANVEL],
        valueTargets: [{ kind: 'kpi', key: 'bufferPendency' }, { kind: 'asset', id: CFS_DRONAGIRI }],
        metrics: [
          { label: '>15-day bucket (simulated)', from: '~2,500', to: '~450', unit: 'boxes', tone: 'better' },
          { label: 'CFS Dronagiri-1 backlog (simulated)', from: 150, to: 85, unit: 'containers', tone: 'better' },
        ],
        patch: {
          pendency: { [CFS_DRONAGIRI]: 85, [CFS_URAN]: 70, [CFS_PANVEL]: 62 },
          rail: { T1: { inboundQueue: 2, placed: 3 }, T2: { inboundQueue: 2, placed: 2 } },
          movementRate: 1.05,
        },
      },
    ],
  },

  // ── S6 · Reefer Surge ──────────────────────────────────────────────────────
  {
    id: 'S6',
    title: 'Reefer Surge',
    blurb: 'A reefer discharge spike lands just as part of the plug bank fails — the twin re-allocates plugs and prioritises evacuation, targeting zero simulated cargo-risk hours.',
    icon: 'snow',
    steps: [
      {
        title: 'A reefer-heavy vessel discharges',
        explain:
          'A vessel at BMCT discharges an unusually reefer-heavy exchange: about 140 refrigerated boxes this shift, more than triple the norm. Every one of them needs a powered plug point within hours of landing.',
        tab: 'movements',
        spotlight: ['BMCT', 'NSIGT'],
        metrics: [{ label: 'Reefers landed this shift (simulated)', from: 40, to: 140, unit: 'boxes', tone: 'worse' }],
        patch: { pendency: { [CFS_URAN]: 110 }, movementRate: 1.15 },
      },
      {
        title: 'Part of the plug bank is down',
        explain:
          'Bad timing: 18 of the 96 CPP reefer plugs are out of service. Reefers start queuing unpowered — in this simulation 34 boxes are waiting for a plug, accruing ~46 cargo-risk hours (hours a temperature-controlled box sits unpowered).',
        tab: 'pendency',
        spotlight: ['BMCT', CFS_URAN],
        valueTargets: [{ kind: 'kpi', key: 'containerPendency' }],
        metrics: [
          { label: 'Working reefer plugs', from: 96, to: 78, tone: 'worse' },
          { label: 'Reefers awaiting plug (simulated)', from: 0, to: 34, unit: 'boxes', tone: 'worse' },
          { label: 'Cargo-risk hours (simulated)', from: 0, to: '~46', unit: 'hrs', tone: 'worse' },
        ],
        patch: { pendency: { [CFS_URAN]: 140 }, movementRate: 1.0 },
      },
      {
        title: 'The twin re-allocates plugs and fast-tracks evacuation',
        explain:
          'The optimiser treats every plug across BMCT, NSIGT and the reefer-capable CFS as one pool: boxes are re-assigned to free plugs by remaining transit tolerance, and DPD-eligible reefers jump the evacuation queue so they free plugs fastest.',
        tab: 'movements',
        spotlight: ['BMCT', 'NSIGT', CFS_URAN],
        valueTargets: [{ kind: 'kpi', key: 'transshipmentTrailerTat' }],
        metrics: [
          { label: 'Reefers awaiting plug (simulated)', from: 34, to: 6, unit: 'boxes', tone: 'better' },
        ],
        patch: { pendency: { [CFS_URAN]: 90 }, movementRate: 1.3 },
        action: { kind: 'OPTIMISATION', detail: 'Simulated: cross-terminal plug re-allocation + priority evacuation of DPD-eligible reefers' },
      },
      {
        title: 'Target: zero simulated cargo-risk hours',
        explain:
          'By end of shift the simulation shows the queue cleared and cargo-risk hours driven to zero — a modelled target under the stated assumptions (surge size, plug outage, pooled allocation), not a claimed JNPA baseline. The plug bank is still 18 short; the twin covered the gap by allocation, not by magic.',
        tab: 'pendency',
        spotlight: ['BMCT', CFS_URAN],
        valueTargets: [{ kind: 'kpi', key: 'containerPendency' }],
        metrics: [
          { label: 'Cargo-risk hours (simulated)', from: '~46', to: 0, unit: 'hrs', tone: 'better' },
          { label: 'Reefers awaiting plug (simulated)', from: 6, to: 0, unit: 'boxes', tone: 'better' },
        ],
        patch: { pendency: { [CFS_URAN]: 65 }, movementRate: 1.1 },
      },
    ],
  },

  // ── S7 · Monsoon Berthing Delay (UC-1 → UC-2 → UC-3) ──────────────────────
  //
  // The CARGO half of the cross-domain Monsoon chain. UC-1 (Vessel Traffic) holds
  // pilotage when wind and wave cross the transfer limit; vessels queue at the
  // anchorage and berth late. This scenario picks the story up at the quay: what a
  // four-hour arrival hold upstream does to discharge, yard dwell and evacuation —
  // and hands on to UC-3, where the recovered discharge becomes a truck surge on
  // the corridor.
  //
  // It exists because there was no weather-driven scenario here at all. S1..S6 are
  // triggered by a rake delay, a customs surge, a rake split, a lane closure, a
  // driver shortage and a plug failure — none by an upstream vessel event — so the
  // Monsoon chain had no honest landing point in the cargo twin.
  {
    id: 'S7',
    title: 'Monsoon Berthing Delay → UC-3',
    blurb:
      'A pilotage hold upstream in UC-1 lands four vessels late; discharge compresses, yard dwell climbs, and the recovery pushes a truck surge to UC-3.',
    icon: 'rain',
    steps: [
      {
        title: 'Vessels berth late after the pilotage hold',
        explain:
          'Upstream in UC-1 the monsoon crossed the pilot-transfer limit and boarding was suspended for about four hours. Four inbound calls berth late in one block rather than spread across the shift, so their discharge windows overlap instead of queueing neatly.',
        tab: 'import',
        spotlight: [G_NSICT],
        metrics: [
          { label: 'Calls berthing late (from UC-1)', from: 0, to: 4, unit: 'vessels', tone: 'worse' },
          { label: 'Discharge start slip', from: '—', to: '~4 h', tone: 'worse' },
        ],
        patch: { movementRate: 0.82 },
      },
      {
        title: 'Discharge compresses into a shorter window',
        explain:
          'The same volume has to come off in less time. Quay moves bunch up, boxes land in the yard faster than they can be evacuated, and the yard starts holding more than it planned to.',
        tab: 'pendency',
        spotlight: [CFS_DRONAGIRI],
        valueTargets: [{ kind: 'kpi', key: 'containerPendency' }],
        metrics: [
          { label: 'Yard dwell (simulated)', from: '2.4', to: '3.6', unit: 'days', tone: 'worse' },
          { label: 'Boxes awaiting evacuation', from: 40, to: 118, unit: 'boxes', tone: 'worse' },
        ],
        patch: { movementRate: 0.78, pendency: { [CFS_DRONAGIRI]: 118 } },
      },
      {
        title: 'Evacuation demand stacks behind the delay',
        explain:
          'Every late-discharged box still has to leave by road or rail. The backlog does not disappear when the weather clears — it converts into a concentrated evacuation demand that has to be worked off against a gate with finite lanes.',
        tab: 'gate',
        spotlight: [G_NSICT],
        valueTargets: [{ kind: 'asset', id: G_NSICT }],
        metrics: [
          { label: 'Gate NSICT-G1 queue (simulated)', from: 6, to: 19, unit: 'trucks', tone: 'worse' },
        ],
        patch: {
          movementRate: 0.8,
          pendency: { [CFS_DRONAGIRI]: 118 },
          gates: { [G_NSICT]: { queueLength: 19, avgTxnTimeMin: 4.7 } },
        },
      },
      {
        title: 'Recovery plan — and the surge it sends downstream',
        explain:
          'The twin works the backlog off with extra evacuation capacity, so yard dwell recovers. But the recovered discharge is exactly a truck surge on the corridor, arriving into the same monsoon that caused the hold — which is what UC-3 has to absorb. The chain continues there.',
        tab: 'pendency',
        spotlight: [CFS_DRONAGIRI, G_NSICT],
        valueTargets: [{ kind: 'kpi', key: 'containerPendency' }],
        metrics: [
          { label: 'Yard dwell (simulated)', from: '3.6', to: '2.7', unit: 'days', tone: 'better' },
          { label: 'Trucks released to corridor', from: '—', to: '~120', unit: 'trucks', tone: 'neutral' },
        ],
        patch: {
          movementRate: 1.12,
          pendency: { [CFS_DRONAGIRI]: 55 },
          gates: { [G_NSICT]: { queueLength: 12, avgTxnTimeMin: 4.3 } },
        },
        action: {
          kind: 'CROSS_TWIN_PUSH',
          detail: 'Post-monsoon evacuation surge handed to UC-3 (corridor + gate)',
        },
      },
    ],
    handoff: {
      twin: 'UC3',
      scenarioId: 'MONSOON-FRIDAY',
      cta: 'Continue in UC-3 · Traffic & Corridor',
      because:
        'Those ~120 released trucks arrive on a corridor that is still under the same rain. '
        + 'Segment speeds are down and the gate has finite lanes — the last segment of this '
        + 'monsoon plays out there.',
    },
  },
];

/**
 * Old §12 ids → §8.2 ids. Legacy deep-links (`?scenario=CGO-2` → Dashboard.tsx
 * → getScript) and any stored tour state resolve through HERE — the adapter-side
 * alias map in scenarios-mock.ts cannot cover them (different package, different
 * call path). Kept in sync with LEGACY_SCENARIO_IDS in scenarios-mock.ts and the
 * causal-graph remap in whatif/ReactiveGuide.tsx.
 */
export const LEGACY_SCRIPT_IDS: Record<string, string> = {
  'CGO-1': 'S5',
  'CGO-2': 'S2',
  'CGO-3': 'S3',
  'LANE-ASSIGN': 'S4',
};

export function getScript(id: string): ScenarioScript | undefined {
  const canonical = LEGACY_SCRIPT_IDS[id] ?? id;
  return SCENARIO_SCRIPTS.find((s) => s.id === canonical);
}
