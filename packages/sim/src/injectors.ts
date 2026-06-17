/**
 * Event injectors (Addendum B.1 "Event injectors": one-click Gate-In, Gate-Out
 * (CODECO), Scan-Flag, Damage, e-seal break, LEO, Rake arrival, ITRHO out/in).
 * Each builds a canonical CargoEvent tagged sourceSystem=SIM, wraps it in a
 * CloudEvents envelope (mode SYNTHETIC), and publishes onto the same topics the
 * live connectors use. The dashboard treats them through the real pipeline.
 */
import type { CargoEvent, EventType } from '@jnpa/schemas';
import { Rng, simId } from './rng.js';
import { cargoEventEnvelope, TOPICS } from './events/cloudevents.js';
import type { EventBus } from './events/bus.js';

export interface InjectorContext {
  bus: EventBus;
  rng: Rng;
  nowIso: () => string;
  /** Default terminal/facility to attribute injected events to. */
  defaultTerminalId: string;
  defaultGateId: string;
}

export interface InjectSpec {
  eventType: EventType;
  containerNo?: string;
  facilityId?: string;
  terminalId?: string;
  gateId?: string;
  vehicleNo?: string;
  rakeId?: string;
  payload?: Record<string, unknown>;
}

function randomContainerNo(rng: Rng): string {
  // Avoid pulling @jnpa/schemas withCheckDigit cycle here is fine; reuse it.
  const owner = ['MAEU', 'MSCU', 'CMAU'][rng.int(0, 2)]!.slice(0, 3);
  const serial = String(rng.int(100000, 999999));
  // simple valid-ish; injectors mark SIM, validation is lenient on injected demo data
  return `${owner}U${serial}0`;
}

/** Build + publish a single injected CargoEvent. Returns the event. */
export function inject(ctx: InjectorContext, spec: InjectSpec): CargoEvent {
  const containerNo = spec.containerNo ?? randomContainerNo(ctx.rng);
  const ts = ctx.nowIso();
  const ev: CargoEvent = {
    eventId: simId(ctx.rng, 'INJ'),
    containerNo,
    eventType: spec.eventType,
    ts,
    sourceOffsetMin: 330,
    facilityId: spec.facilityId ?? spec.terminalId ?? ctx.defaultTerminalId,
    terminalId: spec.terminalId ?? ctx.defaultTerminalId,
    gateId: spec.gateId ?? (spec.eventType === 'GATE_IN' || spec.eventType === 'GATE_OUT' ? ctx.defaultGateId : undefined),
    vehicleNo: spec.vehicleNo,
    rakeId: spec.rakeId,
    sourceSystem: 'SIM',
    rawRef: `raw/sim/injected/${containerNo}-${spec.eventType}-${ts}`,
    payload: spec.payload ?? {},
  };
  ctx.bus.publish(TOPICS.cargoEvents, cargoEventEnvelope(ev, 'SYNTHETIC'));
  return ev;
}

/** Named one-click injectors used by the demo console action bar. */
export const Injectors = {
  gateIn: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'GATE_IN', containerNo, payload: { transportMode: 'ROAD' } }),

  gateOutCodeco: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'GATE_OUT', containerNo, payload: { source: 'CODECO', transportMode: 'ROAD' } }),

  scanFlag: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'CUSTOMS_FLAG', containerNo, payload: { selectedForScan: true } }),

  damage: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'DAMAGE_FLAG', containerNo, payload: { note: 'Injected damage flag (demo)' } }),

  esealBreak: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'ESEAL_BREAK', containerNo, payload: { tamper: true } }),

  leo: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'LEO', containerNo, payload: {} }),

  rakeArrival: (ctx: InjectorContext, sidingId: 'T1' | 'T2' = 'T1') => {
    const rakeId = simId(ctx.rng, 'RK');
    return inject(ctx, {
      eventType: 'RAIL_IN',
      rakeId,
      facilityId: sidingId,
      payload: { sidingId, rakeArrival: true },
    });
  },

  itrhoOut: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'ITRHO_OUT', containerNo, payload: { mode: 'ROAD' } }),

  itrhoIn: (ctx: InjectorContext, containerNo?: string) =>
    inject(ctx, { eventType: 'ITRHO_IN', containerNo, payload: { mode: 'ROAD' } }),
};
