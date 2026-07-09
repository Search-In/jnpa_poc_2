/**
 * simStore — a tiny framework-agnostic pub/sub store that drives "live" data
 * into the otherwise-static mock dashboard. The Simulator page (a separate
 * route, often a separate browser tab/window on a demo screen) writes to it;
 * the Dashboard tabs and the ArcGIS map subscribe and re-render in real time.
 *
 * Cross-tab sync uses BroadcastChannel (live push between open tabs) backed by
 * localStorage (so a freshly-opened dashboard tab hydrates the current state).
 * The store holds *overrides* — deltas keyed by asset id — that are merged over
 * the adapter's base data by applySim() (see applySim.ts). It never mutates the
 * adapter, so mock determinism is preserved and "reset" returns to baseline.
 *
 * A built-in tick engine auto-advances the overrides while running, scaled by
 * `speed`, so the board feels like a live system. Manual controls on the
 * Simulator page set target values that the tick eases toward.
 */

import { getScript, type StepPatch, type ScenarioStep } from './scenarioPlayer.js';
import { workflowStore } from '../workflow/workflowStore.js';

/**
 * Maps a scenario step's automated-action kind (the "so the system did X" badge)
 * to the §8.3 workflow rule it fires. When the tour reaches a step with an
 * `action`, the matching rule is minted onto the Workflow Runs ledger — so the
 * "reactive nature / automated workflows" scored criterion FIRES VISIBLY as the
 * scenario plays, not just as static copy. Steps whose kind has no rule (pure
 * FORECAST_RERUN etc.) still fire a generic run so the ledger reflects every act.
 */
const ACTION_RULE: Record<string, string> = {
  NOTIFICATION: 'WF-PENDENCY',
  RECOMMENDATION: 'WF-PENDENCY',
  LANE_ASSIGNMENT: 'WF-GATE-QUEUE',
  FORECAST_RERUN: 'WF-GATE-QUEUE',
  CROSS_TWIN_PUSH: 'WF-GATE-QUEUE',
  OPTIMISATION: 'WF-RAKE-ETA',
};

/** First real map asset id in a step's spotlight (for the ledger's location pulse). */
function stepLocation(step: ScenarioStep): string | undefined {
  return step.spotlight[0];
}

export type Faction = 'gates' | 'rail' | 'pendency' | 'movements' | 'scan' | 'empty';

/** Per-gate live override. */
export interface GateOverride {
  queueLength?: number;
  avgTxnTimeMin?: number;
  /** Open gate lanes — the dynamic-lane-assignment state, driven by scenarios. */
  openLanes?: number;
}

/** Per-facility pendency override (absolute container count). */
export interface PendencyOverride {
  pendency?: number;
}

/** Per-siding rail override (extra inbound/outbound rakes + placement state). */
export interface RailOverride {
  /** Extra rakes queued for placement on this siding. */
  inboundQueue?: number;
  /** Rakes currently placed (occupying the siding). */
  placed?: number;
}

/**
 * Guided What-If tour state. When a scenario is playing, `scenarioId` is set and
 * `stepIndex` points at the current storyline step; `autoAdvance` drives the
 * step-by-step playback on a timer. The dashboard reads this to show the
 * coach-mark tour, spotlight the right tab, and badge the running scenario.
 */
export interface TourState {
  /** Active scenario id, or null when no tour is playing. */
  scenarioId: string | null;
  /** Index of the current step in the scenario's storyline. */
  stepIndex: number;
  /** Auto-advance through steps on a timer (pause to read a step). */
  autoAdvance: boolean;
  /** Bumped each time autoAdvance ticks, so the UI can show a progress bar. */
  stepStartedAt: number;
}

export interface SimState {
  /** Whether the tick engine is advancing values. */
  running: boolean;
  /** Playback speed multiplier (0.5×–8×). */
  speed: number;
  /** Sim clock in epoch ms; advances ~ speed × wall time while running. */
  clockMs: number;
  /** Monotonic tick counter (useful for animations / debugging). */
  tick: number;
  /** Per-gate overrides keyed by gateId. */
  gates: Record<string, GateOverride>;
  /** Per-facility pendency overrides keyed by facilityId. */
  pendency: Record<string, PendencyOverride>;
  /** Per-siding rail overrides keyed by 'T1' | 'T2'. */
  rail: Record<string, RailOverride>;
  /** Global movement throughput multiplier (1 = baseline flow counts). */
  movementRate: number;
  /** Customs scan queue depth override (absolute). */
  scanQueue: number | null;
  /** Empty-pool availability delta (signed; added to available count). */
  emptyDelta: number;
  /** Asset ids the operator is actively driving — highlighted on the map. */
  highlights: string[];
  /** Guided What-If scenario tour (null scenarioId = no tour). */
  tour: TourState;
}

const STORAGE_KEY = 'jnpa.sim.state.v1';
const CHANNEL = 'jnpa-sim';
const TICK_MS = 1000;
/** How long each guided scenario step stays on screen before auto-advancing. */
const TOUR_STEP_MS = 6000;

/** Merge a scenario step's patch into the override fields of the sim state. */
function mergePatch(s: SimState, patch: StepPatch): SimState {
  const next: SimState = { ...s };
  if (patch.gates) {
    next.gates = { ...s.gates };
    for (const [id, g] of Object.entries(patch.gates)) {
      next.gates[id] = { ...next.gates[id], ...g };
    }
  }
  if (patch.pendency) {
    next.pendency = { ...s.pendency };
    for (const [id, v] of Object.entries(patch.pendency)) next.pendency[id] = { pendency: v };
  }
  if (patch.rail) {
    next.rail = { ...s.rail };
    for (const [id, r] of Object.entries(patch.rail)) next.rail[id] = { ...next.rail[id], ...r };
  }
  if (patch.movementRate != null) next.movementRate = patch.movementRate;
  if (patch.scanQueue !== undefined) next.scanQueue = patch.scanQueue;
  if (patch.emptyDelta != null) next.emptyDelta = patch.emptyDelta;
  return next;
}

function baseState(): SimState {
  return {
    running: false,
    speed: 1,
    clockMs: Date.UTC(2026, 5, 16, 9, 0, 0),
    tick: 0,
    gates: {},
    pendency: {},
    rail: {},
    movementRate: 1,
    scanQueue: null,
    emptyDelta: 0,
    highlights: [],
    tour: { scenarioId: null, stepIndex: 0, autoAdvance: true, stepStartedAt: 0 },
  };
}

type Listener = () => void;

class SimStore {
  private state: SimState = baseState();
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Auto-advance timer for the guided scenario tour. */
  private tourTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic stamp source for step progress (avoids Date.now in the store). */
  private stamp = 0;
  /** Set when an update arrives from another tab, to avoid echo loops. */
  private applyingRemote = false;
  /** (scenarioId:stepIndex) keys already fired, so revisiting a step never re-spams the ledger. */
  private firedSteps = new Set<string>();

  constructor() {
    // Hydrate from localStorage so a newly-opened tab sees current sim state.
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) this.state = { ...baseState(), ...(JSON.parse(raw) as Partial<SimState>) };
    } catch {
      /* ignore corrupt storage */
    }

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'state') {
          this.applyingRemote = true;
          this.state = e.data.state as SimState;
          this.applyingRemote = false;
          this.emit(/* broadcast */ false);
          this.syncTimer();
          this.armTourTimer();
        }
      };
    }

    // The tab that owns the running flag runs the tick. Any tab can own it;
    // whichever last toggled `running` keeps the clock for everyone via sync.
    this.syncTimer();
  }

  getState = (): SimState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Replace state via a producer, then notify + broadcast + persist. */
  set = (producer: (s: SimState) => SimState): void => {
    this.state = producer(this.state);
    this.emit(true);
    this.syncTimer();
  };

  // ---- high-level actions used by the Simulator page ----

  setRunning = (running: boolean) => this.set((s) => ({ ...s, running }));
  setSpeed = (speed: number) => this.set((s) => ({ ...s, speed }));

  setGate = (gateId: string, patch: GateOverride) =>
    this.set((s) => ({ ...s, gates: { ...s.gates, [gateId]: { ...s.gates[gateId], ...patch } } }));

  setPendency = (facilityId: string, pendency: number) =>
    this.set((s) => ({ ...s, pendency: { ...s.pendency, [facilityId]: { pendency } } }));

  setRail = (siding: string, patch: RailOverride) =>
    this.set((s) => ({ ...s, rail: { ...s.rail, [siding]: { ...s.rail[siding], ...patch } } }));

  setMovementRate = (movementRate: number) => this.set((s) => ({ ...s, movementRate }));
  setScanQueue = (scanQueue: number | null) => this.set((s) => ({ ...s, scanQueue }));
  setEmptyDelta = (emptyDelta: number) => this.set((s) => ({ ...s, emptyDelta }));

  /** Mark assets as actively-driven so the map highlights them. */
  setHighlights = (highlights: string[]) => this.set((s) => ({ ...s, highlights }));

  /** Clear all overrides back to baseline (keeps nothing). */
  reset = () => this.set(() => baseState());

  // ---- guided What-If scenario tour ----

  /**
   * Start a scenario tour: clear prior overrides, apply step 0, spotlight its
   * assets, and (if autoAdvance) arm the step timer. The board animates live as
   * each step's patch lands; the coach-mark overlay reads `tour` to narrate.
   */
  startScenario = (scenarioId: string, autoAdvance = true) => {
    const script = getScript(scenarioId);
    if (!script || script.steps.length === 0) return;
    // Fresh tour → reset the fired-workflow dedup so this run's steps fire again.
    this.firedSteps.clear();
    this.set((s) => {
      const fresh = baseState();
      // Keep the clock/speed the operator already set; reset only the overrides.
      // Canonicalise the id (legacy CGO/LANE deep-links resolve via getScript).
      const seeded: SimState = {
        ...fresh,
        running: s.running,
        speed: s.speed,
        clockMs: s.clockMs,
        tick: s.tick,
        tour: { scenarioId: script.id, stepIndex: 0, autoAdvance, stepStartedAt: ++this.stamp },
      };
      return this.applyStep(seeded, script.id, 0);
    });
    this.fireStepWorkflow(script.id, 0);
    this.armTourTimer();
  };

  /** Jump to a specific step (used by the prev/next buttons & progress dots). */
  gotoStep = (index: number) => {
    this.set((s) => {
      const id = s.tour.scenarioId;
      const script = id ? getScript(id) : undefined;
      if (!script) return s;
      const i = Math.max(0, Math.min(script.steps.length - 1, index));
      const stepped: SimState = {
        ...s,
        tour: { ...s.tour, stepIndex: i, stepStartedAt: ++this.stamp },
      };
      return this.applyStep(stepped, script.id, i);
    });
    const { scenarioId, stepIndex } = this.state.tour;
    if (scenarioId) this.fireStepWorkflow(scenarioId, stepIndex);
    this.armTourTimer();
  };

  nextStep = () => this.gotoStep(this.state.tour.stepIndex + 1);
  prevStep = () => this.gotoStep(this.state.tour.stepIndex - 1);

  /** Toggle auto-advance without changing the current step. */
  setTourAutoAdvance = (autoAdvance: boolean) => {
    this.set((s) =>
      s.tour.scenarioId
        ? { ...s, tour: { ...s.tour, autoAdvance, stepStartedAt: ++this.stamp } }
        : s,
    );
    this.armTourTimer();
  };

  /** End the tour and clear every override the scenario applied. */
  stopScenario = () => {
    this.clearTourTimer();
    this.firedSteps.clear();
    this.set((s) => ({ ...baseState(), running: s.running, speed: s.speed, clockMs: s.clockMs, tick: s.tick }));
  };

  /**
   * Compose the cumulative effect of all steps up to and including `index` so a
   * jump-back leaves the board exactly where that step's narrative says it is
   * (steps are written as a running storyline, later patches superseding earlier
   * ones). Also sets the map spotlight to the current step's assets.
   */
  private applyStep(s: SimState, scenarioId: string, index: number): SimState {
    const script = getScript(scenarioId);
    if (!script) return s;
    // Start from a clean override surface, replay patches 0..index in order.
    let acc: SimState = {
      ...s,
      gates: {},
      pendency: {},
      rail: {},
      movementRate: 1,
      scanQueue: null,
      emptyDelta: 0,
    };
    for (let i = 0; i <= index; i++) {
      const step = script.steps[i];
      if (step) acc = mergePatch(acc, step.patch);
    }
    const step = script.steps[index];
    acc.highlights = step ? [...step.spotlight] : [];
    return acc;
  }

  /**
   * Fire the destination step's automated action onto the Workflow Runs ledger
   * (§8.3 — workflows must fire visibly). Runs once per (scenario, step) per tour
   * so navigating back and forth never double-fires; the set is cleared on
   * start/stop. Firing goes through the same workflowStore the console uses, so
   * the ledger, cross-tab sync and AUTO/ADVISORY gate all apply uniformly.
   */
  private fireStepWorkflow(scenarioId: string, index: number) {
    const script = getScript(scenarioId);
    const step = script?.steps[index];
    if (!step?.action) return;
    const key = `${script!.id}:${index}`;
    if (this.firedSteps.has(key)) return;
    this.firedSteps.add(key);
    const ruleId = ACTION_RULE[step.action.kind] ?? 'WF-PENDENCY';
    workflowStore.fireRule(ruleId, {
      trigger: step.action.detail,
      actions: [step.action.detail],
      scenarioId: script!.id,
      location: stepLocation(step),
    });
  }

  private armTourTimer() {
    this.clearTourTimer();
    const { scenarioId, autoAdvance, stepIndex } = this.state.tour;
    if (!scenarioId || !autoAdvance) return;
    const script = getScript(scenarioId);
    if (!script || stepIndex >= script.steps.length - 1) return; // last step: stop
    this.tourTimer = setTimeout(() => this.nextStep(), TOUR_STEP_MS);
  }

  private clearTourTimer() {
    if (this.tourTimer) {
      clearTimeout(this.tourTimer);
      this.tourTimer = null;
    }
  }

  // ---- tick engine ----

  private syncTimer() {
    const shouldRun = this.state.running;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => this.advance(), TICK_MS);
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One tick: advance the clock and nudge driven metrics by a small,
   * deterministic, speed-scaled amount so the board breathes. Gates drift
   * toward a target band; pendency oscillates slightly; movement rate decays
   * toward 1. Only assets with an existing override are advanced — the sim
   * never invents new driven assets on its own.
   */
  private advance() {
    // Remote tabs receive state via broadcast; only advance locally if we are
    // the most recent owner (timer present means we own it).
    this.set((s) => {
      const dtMin = (TICK_MS / 60000) * s.speed * 10; // 1s real ≈ speed×10 sim-min
      const gates: Record<string, GateOverride> = {};
      for (const [id, g] of Object.entries(s.gates)) {
        const q = g.queueLength ?? 0;
        // gentle sine-ish wobble around the set value, bounded ≥ 0
        const wobble = Math.sin((s.tick + hash(id)) / 6) * 0.6 * s.speed;
        gates[id] = { ...g, queueLength: Math.max(0, Math.round(q + wobble)) };
      }
      const pendency: Record<string, PendencyOverride> = {};
      for (const [id, p] of Object.entries(s.pendency)) {
        const base = p.pendency ?? 0;
        const drift = Math.cos((s.tick + hash(id)) / 8) * 1.2 * s.speed;
        pendency[id] = { pendency: Math.max(0, Math.round(base + drift)) };
      }
      // Scan backlog and empty-pool delta breathe too when a value is engaged.
      const scanQueue =
        s.scanQueue == null
          ? null
          : Math.max(0, Math.round(s.scanQueue + Math.sin(s.tick / 5) * 0.8 * s.speed));
      const emptyDelta =
        s.emptyDelta === 0
          ? 0
          : Math.round(s.emptyDelta + Math.cos(s.tick / 7) * 1.5 * s.speed);
      return {
        ...s,
        tick: s.tick + 1,
        clockMs: s.clockMs + dtMin * 60000,
        gates,
        pendency,
        scanQueue,
        emptyDelta,
        // movement rate eases back toward baseline so manual spikes relax
        movementRate: ease(s.movementRate, 1, 0.04 * s.speed),
      };
    });
  }

  private emit(broadcast: boolean) {
    this.listeners.forEach((l) => l());
    if (broadcast && !this.applyingRemote) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        /* storage may be full / unavailable */
      }
      this.channel?.postMessage({ type: 'state', state: this.state });
    }
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function ease(from: number, to: number, k: number): number {
  return Math.abs(from - to) < 0.01 ? to : from + (to - from) * k;
}

/** Singleton store shared by every component in the tab. */
export const simStore = new SimStore();

/** Exposed for the tour progress bar so the UI matches the auto-advance pace. */
export { TOUR_STEP_MS };
