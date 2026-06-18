/**
 * ULIP REST JSON mappers (prompt §4). ULIP is the primary gateway: container
 * track/trace, gate events, FOIS rail track/trace, and Vahan vehicle lookup.
 * Contracts here follow the published ULIP envelope shape (a `response` array of
 * milestone records); fields are mapped to canonical CargoEvents / entities.
 *
 * NOTE: ULIP wraps every API in a common envelope:
 *   { "code": 200, "message": "...", "response": [ { ...record } ] }
 * Each connector decrypts/unwraps before calling these mappers with the inner
 * record(s).
 */
import type { CargoEvent, EventType } from '../../entities/cargo-event.js';
import type { Rake } from '../../entities/operations.js';
import { deriveEventId, finalizeEvent, makeRawRef } from '../support.js';
import type { MapResult } from '../support.js';

interface BaseOpts {
  defaultFacilityId?: string;
  defaultOffsetMin?: number;
}

/** Parse an ISO-ish or epoch timestamp into UTC ISO + offset. */
function parseUlipTs(value: unknown, offsetMin = 330): { iso: string; offsetMin: number } {
  if (typeof value === 'number') {
    return { iso: new Date(value).toISOString(), offsetMin: 0 };
  }
  if (typeof value === 'string') {
    // ULIP often returns "YYYY-MM-DD HH:mm:ss" in IST without a zone.
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
    if (m) {
      const [, y, mo, d, h, mi, s = '0'] = m;
      const utc =
        Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) -
        offsetMin * 60_000;
      return { iso: new Date(utc).toISOString(), offsetMin };
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return { iso: parsed.toISOString(), offsetMin: 0 };
  }
  return { iso: new Date(Date.UTC(1970, 0, 1)).toISOString(), offsetMin };
}

/** ULIP container-track milestone code → canonical event type. */
function ulipMilestoneToEvent(code: string | undefined): EventType {
  switch ((code ?? '').toUpperCase()) {
    case 'GATE_IN':
    case 'GATEIN':
    case 'GI':
      return 'GATE_IN';
    case 'GATE_OUT':
    case 'GATEOUT':
    case 'GO':
      return 'GATE_OUT';
    case 'RAIL_IN':
    case 'RAILIN':
      return 'RAIL_IN';
    case 'RAIL_OUT':
    case 'RAILOUT':
      return 'RAIL_OUT';
    case 'LEO':
      return 'LEO';
    case 'SCAN_FLAG':
    case 'CUSTOMS_HOLD':
      return 'CUSTOMS_FLAG';
    default:
      return 'YARD_MOVE';
  }
}

export interface UlipContainerRecord {
  containerNo: string;
  milestone?: string;
  eventDateTime?: string | number;
  facilityCode?: string;
  terminalId?: string;
  gateId?: string;
  vehicleNo?: string;
  sealNo?: string;
  [k: string]: unknown;
}

/** Map ULIP container track/trace records → CargoEvent[]. */
export function mapUlipContainerTrack(
  records: UlipContainerRecord[],
  opts: BaseOpts = {},
): MapResult<CargoEvent[]> {
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;
  const events: CargoEvent[] = [];

  for (const rec of records) {
    if (!rec.containerNo) {
      warnings.push('ULIP record without containerNo skipped');
      continue;
    }
    const eventType = ulipMilestoneToEvent(rec.milestone);
    const { iso, offsetMin } = parseUlipTs(rec.eventDateTime, offsetDefault);
    const facilityId = rec.facilityCode ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
    const externalRef = `${rec.containerNo}-${rec.milestone ?? 'EVT'}-${iso}`;
    const rawRef = makeRawRef('ULIP', 'container-track', externalRef);

    events.push(
      finalizeEvent({
        eventId: deriveEventId('ULIP', 'container-track', externalRef, rec.containerNo, eventType),
        containerNo: rec.containerNo,
        eventType,
        ts: iso,
        sourceOffsetMin: offsetMin,
        facilityId,
        terminalId: rec.terminalId,
        gateId: rec.gateId,
        vehicleNo: rec.vehicleNo,
        sourceSystem: 'ULIP',
        rawRef,
        payload: { milestone: rec.milestone, sealNo: rec.sealNo },
      }),
    );
  }
  return { data: events, rawRef: makeRawRef('ULIP', 'container-track', 'batch'), warnings };
}

export interface UlipFoisRecord {
  rakeId?: string;
  trainNo?: string;
  foisRef?: string;
  ctoOperator?: string;
  sidingId?: 'T1' | 'T2';
  terminalId?: string;
  arrivalDateTime?: string | number;
  placementDateTime?: string | number;
  removalDateTime?: string | number;
  departureDateTime?: string | number;
  wagonCount?: number;
  direction?: 'INBOUND' | 'OUTBOUND';
  mixedFlag?: boolean;
  [k: string]: unknown;
}

/** Map ULIP/FOIS rail track/trace → canonical Rake (prompt §6 FOIS-via-ULIP). */
export function mapUlipFoisRake(rec: UlipFoisRecord, opts: BaseOpts = {}): MapResult<Rake> {
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;
  const rakeId = rec.rakeId ?? rec.foisRef ?? rec.trainNo ?? 'UNKNOWN_RAKE';

  const rake: Rake = {
    rakeId,
    ctoOperator: rec.ctoOperator ?? 'UNKNOWN',
    trainNo: rec.trainNo ?? rakeId,
    foisRef: rec.foisRef ?? rakeId,
    sidingId: rec.sidingId ?? 'T1',
    terminalId: rec.terminalId ?? opts.defaultFacilityId ?? 'UNKNOWN',
    arrivalTs: parseUlipTs(rec.arrivalDateTime, offsetDefault).iso,
    placementTs: rec.placementDateTime ? parseUlipTs(rec.placementDateTime, offsetDefault).iso : undefined,
    removalTs: rec.removalDateTime ? parseUlipTs(rec.removalDateTime, offsetDefault).iso : undefined,
    departureTs: rec.departureDateTime ? parseUlipTs(rec.departureDateTime, offsetDefault).iso : undefined,
    wagonCount: rec.wagonCount ?? 0,
    direction: rec.direction ?? 'INBOUND',
    mixedFlag: rec.mixedFlag ?? false,
  };
  if (!rec.sidingId) warnings.push('FOIS record missing sidingId; defaulted to T1');
  return { data: rake, rawRef: makeRawRef('FOIS', 'ulip-fois-rake', rakeId), warnings };
}

export interface UlipVahanRecord {
  vehicleNo: string;
  ownerName?: string;
  vehicleClass?: string;
  fitnessValidUpto?: string;
  permitValidUpto?: string;
  rcStatus?: string;
  [k: string]: unknown;
}

/** Vahan lookup result — normalised vehicle compliance projection (gate checks). */
export interface VahanVehicle {
  vehicleNo: string;
  vehicleClass?: string;
  fitnessValidUpto?: string;
  permitValidUpto?: string;
  /** True if RC active and fitness+permit not expired (gate-automation input). */
  compliant: boolean;
}

export function mapUlipVahan(rec: UlipVahanRecord, asOf?: string): MapResult<VahanVehicle> {
  const warnings: string[] = [];
  const ref = asOf ?? '1970-01-01T00:00:00.000Z';
  const notExpired = (d?: string) => (d ? new Date(d).getTime() >= new Date(ref).getTime() : true);
  const compliant =
    (rec.rcStatus ? /ACTIVE/i.test(rec.rcStatus) : true) &&
    notExpired(rec.fitnessValidUpto) &&
    notExpired(rec.permitValidUpto);
  if (!rec.vehicleNo) warnings.push('Vahan record without vehicleNo');
  return {
    data: {
      vehicleNo: rec.vehicleNo,
      vehicleClass: rec.vehicleClass,
      fitnessValidUpto: rec.fitnessValidUpto,
      permitValidUpto: rec.permitValidUpto,
      compliant,
    },
    rawRef: makeRawRef('ULIP', 'vahan', rec.vehicleNo ?? 'UNKNOWN'),
    warnings,
  };
}
