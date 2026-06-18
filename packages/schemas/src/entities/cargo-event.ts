import type {
  ContainerNo,
  IsoUtc,
  RawRef,
  SourceSystem,
  UtcOffsetMinutes,
} from './common.js';

/**
 * Every event type the canonical spine recognises (prompt §3 CargoEvent.eventType).
 * This list is closed — a mapper that cannot map to one of these MUST raise
 * rather than invent a new type.
 */
export const EVENT_TYPES = [
  'GATE_IN',
  'GATE_OUT',
  'RAIL_IN',
  'RAIL_OUT',
  'YARD_MOVE',
  'SCAN_START',
  'SCAN_END',
  'LEO', // Let Export Order (customs)
  'STUFFING',
  'DESTUFFING',
  'ITRHO_OUT', // inter-terminal handover out
  'ITRHO_IN', // inter-terminal handover in
  'DAMAGE_FLAG',
  'CUSTOMS_FLAG',
  'ESEAL_AFFIX',
  'ESEAL_BREAK',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * CargoEvent — the event-sourced spine of the whole platform (prompt §3).
 * All entity projections (Container.status, GateTransaction, Rake TAT, ...) are
 * derived by folding the ordered stream of CargoEvents. Raw native payloads are
 * preserved in the object store and referenced by `rawRef` for audit (IPR clause).
 */
export interface CargoEvent {
  /** Globally unique event id (ULID/UUID). */
  eventId: string;
  /** ISO 6346 container the event concerns. */
  containerNo: ContainerNo;
  /** What happened. */
  eventType: EventType;
  /** When it happened, UTC. */
  ts: IsoUtc;
  /** Source-system local offset preserved at ingest (minutes east of UTC). */
  sourceOffsetMin: UtcOffsetMinutes;
  /** Facility where the event occurred (FK -> Facility.facilityId). */
  facilityId: string;
  /** Terminal, when the facility is/maps to a terminal. */
  terminalId?: string;
  /** Gate, for gate events. */
  gateId?: string;
  /** Road vehicle (truck/trailer) registration, for gate/road moves. */
  vehicleNo?: string;
  /** Rake id, for rail events. */
  rakeId?: string;
  /** Which integration originated this event. */
  sourceSystem: SourceSystem;
  /** Object-store key of the raw native payload (EDI/X12/ICES/JSON). */
  rawRef: RawRef;
  /** Decoded/normalised native payload (kept in jsonb in Postgres). */
  payload: Record<string, unknown>;
}

/** Event types that change Container.status, with the status each implies. */
export const EVENT_STATUS_TRANSITIONS: Partial<Record<EventType, string>> = {
  GATE_IN: 'GATE_IN',
  GATE_OUT: 'GATE_OUT',
  RAIL_IN: 'RAIL_IN',
  RAIL_OUT: 'RAIL_OUT',
  YARD_MOVE: 'IN_YARD',
  SCAN_START: 'UNDER_SCAN',
  CUSTOMS_FLAG: 'HELD_CUSTOMS',
  STUFFING: 'STUFFING',
  DESTUFFING: 'DESTUFFING',
  ITRHO_OUT: 'ITRHO_IN_TRANSIT',
  ITRHO_IN: 'IN_YARD',
};
