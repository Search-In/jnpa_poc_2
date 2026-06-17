/**
 * Universal RFID e-seal reader mapper (prompt §4/§6). The reader feed is a flat
 * JSON record per read; affix vs break is carried by `eventCode`. Maps to
 * ESEAL_AFFIX / ESEAL_BREAK CargoEvents which the fold uses to keep
 * Container.currentSealNo accurate and to flag tamper (break before gate-out).
 */
import type { CargoEvent } from '../../entities/cargo-event.js';
import { deriveEventId, finalizeEvent, makeRawRef } from '../support.js';
import type { MapResult } from '../support.js';

export interface ESealReadRecord {
  containerNo: string;
  sealNo: string;
  eventCode: 'AFFIX' | 'BREAK' | string;
  readerId?: string;
  facilityId?: string;
  gateId?: string;
  readTs: string;
  [k: string]: unknown;
}

export function mapESealRead(
  rec: ESealReadRecord,
  defaultFacilityId = 'UNKNOWN_FACILITY',
  offsetMin = 330,
): MapResult<CargoEvent> {
  const warnings: string[] = [];
  const eventType = rec.eventCode === 'BREAK' ? 'ESEAL_BREAK' : 'ESEAL_AFFIX';
  if (rec.eventCode !== 'AFFIX' && rec.eventCode !== 'BREAK') {
    warnings.push(`Unknown e-seal eventCode "${rec.eventCode}" treated as AFFIX`);
  }
  const facilityId = rec.facilityId ?? defaultFacilityId;
  const ts = new Date(rec.readTs).toISOString();
  const rawRef = makeRawRef('ESEAL', 'rfid', `${rec.containerNo}-${rec.sealNo}-${rec.eventCode}`);

  return {
    data: finalizeEvent({
      eventId: deriveEventId('ESEAL', 'rfid', rec.sealNo, rec.containerNo, eventType),
      containerNo: rec.containerNo,
      eventType,
      ts,
      sourceOffsetMin: offsetMin,
      facilityId,
      gateId: rec.gateId,
      sourceSystem: 'ESEAL',
      rawRef,
      payload: { sealNo: rec.sealNo, readerId: rec.readerId },
    }),
    rawRef,
    warnings,
  };
}
