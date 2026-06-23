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

export type Faction = 'gates' | 'rail' | 'pendency' | 'movements' | 'scan' | 'empty';

/** Per-gate live override. */
export interface GateOverride {
  queueLength?: number;
  avgTxnTimeMin?: number;
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
}

const STORAGE_KEY = 'jnpa.sim.state.v1';
const CHANNEL = 'jnpa-sim';
const TICK_MS = 1000;

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
  };
}

type Listener = () => void;

class SimStore {
  private state: SimState = baseState();
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Set when an update arrives from another tab, to avoid echo loops. */
  private applyingRemote = false;

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
