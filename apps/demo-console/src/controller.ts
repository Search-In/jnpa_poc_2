/**
 * Console controller (Addendum B.2): owns the in-memory bus, the seeded RNG, the
 * demo clock, the injector context, and the per-source fault/health state. All
 * actions publish CloudEvents onto the SAME topics the live connectors use, so a
 * dashboard subscribed to the bus reacts identically (faithful). Deterministic:
 * a runbook + seed replays exactly.
 */
import {
  InMemoryEventBus,
  Rng,
  SimClock,
  DEMO_ORIGIN_MS,
  Injectors,
  type InjectorContext,
  TOPICS,
  envelope,
} from '@jnpa/sim';
import type { Degradation, IntegrationMode } from '@jnpa/schemas';

export interface SourceHealth {
  source: string;
  degradation: Degradation;
  mode: IntegrationMode;
  running: boolean;
}

const SOURCES = ['ULIP', 'ICEGATE', 'TOS', 'FOIS', 'ESEAL', 'SHIPLINE'];

export class ConsoleController {
  readonly bus = new InMemoryEventBus();
  readonly clock = new SimClock(DEMO_ORIGIN_MS);
  private rng: Rng;
  private seed: number;
  health: Record<string, SourceHealth> = {};
  eventCount = 0;
  recorder: Array<{ action: string; atMs: number }> = [];

  constructor(seed = 20260615) {
    this.seed = seed;
    this.rng = new Rng(seed).fork('console');
    for (const s of SOURCES) {
      this.health[s] = { source: s, degradation: 'GREEN', mode: 'SYNTHETIC', running: true };
    }
    this.bus.subscribe(TOPICS.cargoEvents, () => {
      this.eventCount += 1;
    });
  }

  get seedValue(): number {
    return this.seed;
  }

  private ctx(): InjectorContext {
    return {
      bus: this.bus,
      rng: this.rng,
      nowIso: () => this.clock.nowIso(),
      defaultTerminalId: 'NSICT',
      defaultGateId: 'NSICT-G1',
    };
  }

  /** Fire a named injector (Addendum B.1 event injectors). */
  fire(injectorId: string, params: Record<string, unknown> = {}): void {
    const ctx = this.ctx();
    this.recorder.push({ action: injectorId, atMs: this.clock.nowMs() });
    switch (injectorId) {
      case 'gateIn': Injectors.gateIn(ctx); break;
      case 'gateOutCodeco': Injectors.gateOutCodeco(ctx); break;
      case 'scanFlag': Injectors.scanFlag(ctx); break;
      case 'damage': Injectors.damage(ctx); break;
      case 'esealBreak': Injectors.esealBreak(ctx); break;
      case 'leo': Injectors.leo(ctx); break;
      case 'rakeArrival': Injectors.rakeArrival(ctx); break;
      case 'itrhoOut': Injectors.itrhoOut(ctx); break;
      case 'itrhoIn': Injectors.itrhoIn(ctx); break;
      case 'crossTwinPush': this.emitCrossTwin(String(params.gateId ?? 'NSICT-G1')); break;
      default: this.emitScenario(injectorId, params); break;
    }
  }

  /** Scenario triggers publish a scenario-request event the gateway consumes. */
  private emitScenario(id: string, params: Record<string, unknown>): void {
    this.bus.publish(
      TOPICS.cargoEvents,
      envelope({
        type: `jnpa.uc2.scenario.${id}`,
        id: `SCN-${id}-${this.clock.nowMs()}`,
        time: this.clock.nowIso(),
        data: { scenarioId: id, params },
        sourceSuffix: 'demo-console',
        mode: 'SYNTHETIC',
      }),
    );
  }

  private emitCrossTwin(gateId: string): void {
    this.bus.publish(
      TOPICS.crossTwin,
      envelope({
        type: 'jnpa.crosstwin.uc2.deferred-arrival',
        id: `XT-${this.clock.nowMs()}`,
        time: this.clock.nowIso(),
        subject: gateId,
        data: {
          source: 'UC2', target: 'UC3', gateId, terminalId: gateId.split('-')[0],
          window: { from: this.clock.nowIso(), to: this.clock.nowIso() },
          reason: 'Manual cross-twin push from demo console',
          correlationId: `manual-${this.clock.nowMs()}`, issuedTs: this.clock.nowIso(),
        },
        sourceSuffix: 'demo-console',
      }),
    );
  }

  /** Fault injection (Addendum B.1): flip a source to AMBER/RED or clear. */
  injectFault(source: string, level: Degradation): void {
    const h = this.health[source];
    if (!h) return;
    h.degradation = level;
    h.mode = level === 'GREEN' ? 'SYNTHETIC' : level === 'AMBER' ? 'CACHED' : 'SYNTHETIC';
    this.bus.publish(
      TOPICS.integrationHealth,
      envelope({
        type: 'jnpa.uc2.health',
        id: `H-${source}-${this.clock.nowMs()}`,
        time: this.clock.nowIso(),
        data: { sourceSystem: source, degradation: level, mode: h.mode, errorCount: level === 'RED' ? 3 : 1 },
        sourceSuffix: 'demo-console',
      }),
    );
  }

  toggleFeed(source: string, running: boolean): void {
    const h = this.health[source];
    if (h) h.running = running;
  }

  /** Reset to a clean state between demos (Addendum B.2 one-key reset). */
  reset(): void {
    this.bus.reset();
    this.clock.reset();
    this.rng = new Rng(this.seed).fork('console');
    this.eventCount = 0;
    this.recorder = [];
    for (const s of SOURCES) this.health[s] = { source: s, degradation: 'GREEN', mode: 'SYNTHETIC', running: true };
    this.bus.subscribe(TOPICS.cargoEvents, () => {
      this.eventCount += 1;
    });
  }
}
