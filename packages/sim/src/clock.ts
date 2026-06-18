/**
 * Virtual demo clock (Addendum B.1 "Demo clock": play/pause/reset, speed 1×–60×,
 * jump-to-time). The simulator advances against THIS clock, never wall-clock, so
 * a recorded runbook replays identically and a presenter can compress time.
 *
 * The clock is pure state + an explicit `tick(realDeltaMs)` the host loop calls;
 * it does not read the system clock itself, keeping the whole sim deterministic.
 */
export interface SimClockState {
  /** Current virtual time, epoch millis. */
  virtualMs: number;
  running: boolean;
  /** Time-compression multiplier (1 = real time, 60 = 1 min/sec). */
  speed: number;
}

export class SimClock {
  private virtualMs: number;
  private running = false;
  private speed = 1;
  private readonly originMs: number;

  /** @param originMs virtual epoch the demo starts from (fixed for determinism). */
  constructor(originMs: number) {
    this.originMs = originMs;
    this.virtualMs = originMs;
  }

  state(): SimClockState {
    return { virtualMs: this.virtualMs, running: this.running, speed: this.speed };
  }

  /** Current virtual time as UTC ISO string. */
  nowIso(): string {
    return new Date(this.virtualMs).toISOString();
  }

  nowMs(): number {
    return this.virtualMs;
  }

  play(): void {
    this.running = true;
  }

  pause(): void {
    this.running = false;
  }

  reset(): void {
    this.virtualMs = this.originMs;
    this.running = false;
    this.speed = 1;
  }

  setSpeed(multiplier: number): void {
    this.speed = Math.max(1, Math.min(60, multiplier));
  }

  /** Jump virtual time to an absolute instant (epoch millis). */
  jumpTo(absMs: number): void {
    this.virtualMs = absMs;
  }

  /**
   * Advance the virtual clock by `realDeltaMs` of real elapsed time, scaled by
   * the speed multiplier. Returns the number of virtual ms advanced (0 if
   * paused). The host loop owns the cadence; the clock owns the math.
   */
  tick(realDeltaMs: number): number {
    if (!this.running) return 0;
    const advanced = realDeltaMs * this.speed;
    this.virtualMs += advanced;
    return advanced;
  }

  /** Deterministic advance for tests/replay — bypasses running/speed. */
  advanceVirtual(ms: number): void {
    this.virtualMs += ms;
  }
}
