/**
 * Scenario engine (prompt §12). Wraps the deterministic scenario computation
 * (shared with the MockAdapter) and, for CGO-2, builds the real cross-twin
 * DeferredArrivalWindow event that gets pushed to the UC3 Trucking App. Each run
 * is seeded → repeatable for the JNPA demo.
 */
import type { DeferredArrivalWindow } from '@jnpa/schemas';
import { CROSS_TWIN_EVENT_TYPES, CROSS_TWIN_TOPIC } from '@jnpa/schemas';
import { SimWorld, envelope, type EventBus } from '@jnpa/sim';
import { runMockScenario, type ScenarioParams, type ScenarioResultDTO } from '@jnpa/data';
import type { BaselinesConfig } from '@jnpa/kpi';

export interface ScenarioEngineDeps {
  terminalsConfig: ConstructorParameters<typeof SimWorld>[0];
  baselines: BaselinesConfig;
  bus?: EventBus;
  seed?: number;
}

export interface ScenarioRunResult extends ScenarioResultDTO {
  /** The cross-twin event emitted (CGO-2 only). */
  crossTwinEvent?: DeferredArrivalWindow;
}

export class ScenarioEngine {
  private sim: SimWorld;
  private baselines: BaselinesConfig;
  private bus?: EventBus;
  private asOf: string;
  private seed: number;

  constructor(deps: ScenarioEngineDeps) {
    this.seed = deps.seed ?? 20260615;
    this.sim = new SimWorld(deps.terminalsConfig, { seed: this.seed });
    this.baselines = deps.baselines;
    this.bus = deps.bus;
    this.asOf = new Date(this.sim.startMs + this.sim.windowHours * 3_600_000).toISOString();
  }

  run(id: string, params: ScenarioParams = {}): ScenarioRunResult {
    const result = runMockScenario(id, params, {
      dataset: this.sim.dataset,
      world: this.sim.world,
      baselines: this.baselines,
      asOf: this.asOf,
      seed: this.seed,
    });

    let crossTwinEvent: DeferredArrivalWindow | undefined;

    if (id === 'CGO-2') {
      const gateId = (params.gateId as string) ?? 'NSICT-G1';
      const terminalId = gateId.split('-')[0] ?? 'NSICT';
      const from = this.asOf;
      const to = new Date(new Date(this.asOf).getTime() + 90 * 60_000).toISOString();
      crossTwinEvent = {
        source: 'UC2',
        target: 'UC3',
        gateId,
        terminalId,
        window: { from, to },
        reason: `Customs-flag surge → predicted gate-queue spike at ${gateId}`,
        recommendedSlotCap: 4,
        correlationId: `CGO-2-${this.seed}`,
        issuedTs: from,
      };
      // Emit onto the shared cross-twin topic (UC3 subscribes).
      this.bus?.publish(
        CROSS_TWIN_TOPIC,
        envelope({
          type: CROSS_TWIN_EVENT_TYPES.deferredArrival,
          id: crossTwinEvent.correlationId,
          time: crossTwinEvent.issuedTs,
          subject: gateId,
          data: crossTwinEvent,
          sourceSuffix: 'scenario',
        }),
      );
    }

    return { ...result, crossTwinEvent };
  }
}
