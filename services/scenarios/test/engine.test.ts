import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, type CloudEvent } from '@jnpa/sim';
import { CROSS_TWIN_TOPIC, CROSS_TWIN_EVENT_TYPES, type DeferredArrivalWindow } from '@jnpa/schemas';
import type { BaselinesConfig } from '@jnpa/kpi';
import { ScenarioEngine } from '../src/engine.js';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof ScenarioEngine>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

function engine(bus?: InMemoryEventBus) {
  return new ScenarioEngine({ terminalsConfig: terminals, baselines, bus });
}

describe('ScenarioEngine', () => {
  it('runs S1–S6 with before/after (A/B) deltas + actions', () => {
    const e = engine();
    for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
      const r = e.run(id);
      expect(r.before.length).toBe(10);
      expect(r.after.length).toBe(10);
      expect(r.actions.length).toBeGreaterThan(0);
      expect(r.after.some((k, i) => k.value !== r.before[i]!.value)).toBe(true);
    }
  });

  it('legacy CGO/LANE ids still run through the alias', () => {
    const e = engine();
    for (const id of ['CGO-1', 'CGO-2', 'CGO-3', 'LANE-ASSIGN']) {
      const r = e.run(id);
      expect(r.before.length).toBe(10);
      expect(r.actions.length).toBeGreaterThan(0);
    }
  });

  it('S2 emits a real cross-twin DeferredArrivalWindow onto the shared topic', () => {
    const bus = new InMemoryEventBus();
    const received: CloudEvent[] = [];
    bus.subscribe(CROSS_TWIN_TOPIC, (ev) => received.push(ev));

    const r = engine(bus).run('S2', { gateId: 'GTI-G2' });

    expect(r.crossTwinEvent).toBeDefined();
    const ev = r.crossTwinEvent as DeferredArrivalWindow;
    expect(ev.source).toBe('UC2');
    expect(ev.target).toBe('UC3');
    expect(ev.gateId).toBe('GTI-G2');
    expect(ev.terminalId).toBe('GTI');
    expect(ev.window.from).toBeTruthy();

    // and it was published on the shared cross-twin topic with the right type
    expect(received.length).toBe(1);
    expect(received[0]!.type).toBe(CROSS_TWIN_EVENT_TYPES.deferredArrival);
    expect((received[0]!.data as DeferredArrivalWindow).target).toBe('UC3');
  });

  it('legacy CGO-2 alias also emits the cross-twin event', () => {
    const r = engine().run('CGO-2', { gateId: 'NSICT-G1' });
    expect(r.crossTwinEvent?.target).toBe('UC3');
  });

  it('is deterministic: same scenario+seed → identical cross-twin correlationId', () => {
    const a = engine().run('S2');
    const b = engine().run('S2');
    expect(a.crossTwinEvent!.correlationId).toBe(b.crossTwinEvent!.correlationId);
    expect(a.after.map((k) => k.value)).toEqual(b.after.map((k) => k.value));
  });
});
