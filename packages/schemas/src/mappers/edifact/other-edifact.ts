/**
 * Remaining EDIFACT mappers (prompt §4): COARRI, COPRAR, BAPLIE, IFTSTA.
 * Each converts native → CargoEvent[] (or canonical projection) and records a
 * rawRef. Profiles are the common D21A subsets; segment positions documented.
 */
import type { CargoEvent, EventType } from '../../entities/cargo-event.js';
import { deriveEventId, finalizeEvent, makeRawRef, parseEdifactDateTime } from '../support.js';
import { comp, findAllSegs, findSeg, tokenizeEdifact } from './tokenizer.js';
import type { MapResult } from '../support.js';

interface BaseOpts {
  defaultFacilityId?: string;
  defaultOffsetMin?: number;
}

function firstDateTime(
  segments: ReturnType<typeof tokenizeEdifact>['segments'],
  qualifiers: string[],
  offsetDefault: number,
): { iso: string; offsetMin: number } | undefined {
  for (const dtm of findAllSegs(segments, 'DTM')) {
    const qual = comp(dtm, 0, 0);
    if (qual && qualifiers.includes(qual)) {
      const value = comp(dtm, 0, 1) ?? '';
      const fmt = comp(dtm, 0, 2) ?? '203';
      return parseEdifactDateTime(value, fmt, offsetDefault);
    }
  }
  return undefined;
}

/**
 * COARRI — container discharge/load report (vessel ↔ yard). We map:
 *   discharge -> RAIL_IN? no — vessel discharge lands in yard => YARD_MOVE
 *   load      -> YARD_MOVE (onto vessel)
 * The BGM message function (RFF/STS) carries D (discharge) vs L (load); kept on
 * payload.movement so downstream can distinguish without inventing event types.
 */
export function mapCoarri(raw: string, opts: BaseOpts = {}): MapResult<CargoEvent[]> {
  const { segments } = tokenizeEdifact(raw);
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;

  const bgm = findSeg(segments, 'BGM');
  const docNo = comp(bgm!, 1) ?? 'UNKNOWN';
  const nad = findSeg(segments, 'NAD');
  const facilityId = comp(nad!, 1) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
  const dt = firstDateTime(segments, ['7', '137', '798'], offsetDefault);
  const ts = dt?.iso ?? new Date(Date.UTC(1970, 0, 1)).toISOString();

  const rawRef = makeRawRef('TOS', 'COARRI', docNo);
  const events: CargoEvent[] = [];

  // RFF+ refs may carry the movement type; default to discharge.
  const movement = (comp(findSeg(segments, 'STS')!, 1) ?? 'D').toUpperCase();

  for (const eqd of findAllSegs(segments, 'EQD').filter((s) => comp(s, 0) === 'CN')) {
    const containerNo = comp(eqd, 1) ?? '';
    events.push(
      finalizeEvent({
        eventId: deriveEventId('TOS', 'COARRI', docNo, containerNo, 'YARD_MOVE'),
        containerNo,
        eventType: 'YARD_MOVE',
        ts,
        sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
        facilityId,
        sourceSystem: 'TOS',
        rawRef,
        payload: { movement: movement === 'L' ? 'LOAD' : 'DISCHARGE', isoTypeCode: comp(eqd, 2) },
      }),
    );
  }
  if (events.length === 0) warnings.push('COARRI had no EQD+CN segments');
  return { data: events, rawRef, warnings };
}

/**
 * COPRAR — load/discharge ORDER (planning, not actuals). We do not emit movement
 * CargoEvents (nothing has happened yet); instead we return an order projection
 * the TOS connector can hold as expected work. Represented as a lightweight
 * payload-only event list with eventType omitted is not allowed by the closed
 * enum, so we surface it as canonical "expected" records via warnings + payload.
 */
export interface CoprarOrder {
  docNo: string;
  facilityId: string;
  vesselRef?: string;
  containers: Array<{ containerNo: string; isoTypeCode?: string; action: 'LOAD' | 'DISCHARGE' }>;
}

export function mapCoprar(raw: string, opts: BaseOpts = {}): MapResult<CoprarOrder> {
  const { segments } = tokenizeEdifact(raw);
  const warnings: string[] = [];
  const bgm = findSeg(segments, 'BGM');
  const docNo = comp(bgm!, 1) ?? 'UNKNOWN';
  const nad = findSeg(segments, 'NAD');
  const facilityId = comp(nad!, 1) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
  const tdt = findSeg(segments, 'TDT');
  const vesselRef = comp(tdt!, 7) ?? comp(tdt!, 1);

  const containers = findAllSegs(segments, 'EQD')
    .filter((s) => comp(s, 0) === 'CN')
    .map((eqd) => ({
      containerNo: comp(eqd, 1) ?? '',
      isoTypeCode: comp(eqd, 2),
      action: 'LOAD' as 'LOAD' | 'DISCHARGE',
    }));

  if (containers.length === 0) warnings.push('COPRAR had no EQD+CN segments');
  return { data: { docNo, facilityId, vesselRef, containers }, rawRef: makeRawRef('TOS', 'COPRAR', docNo), warnings };
}

/**
 * BAPLIE — bayplan / stowage. Returns the stowed positions per container; used
 * for vessel stow visibility, not movement. LOC+147 carries the bay/row/tier.
 */
export interface BaplieStow {
  vesselRef?: string;
  positions: Array<{ containerNo: string; stowage?: string; isoTypeCode?: string }>;
}

export function mapBaplie(raw: string): MapResult<BaplieStow> {
  const { segments } = tokenizeEdifact(raw);
  const warnings: string[] = [];
  const tdt = findSeg(segments, 'TDT');
  const vesselRef = comp(tdt!, 7) ?? comp(tdt!, 1);

  // BAPLIE groups by LOC+147 (stowage cell) then EQD+CN within.
  const positions: BaplieStow['positions'] = [];
  let currentStow: string | undefined;
  for (const seg of segments) {
    if (seg.tag === 'LOC' && comp(seg, 0) === '147') {
      currentStow = comp(seg, 1);
    } else if (seg.tag === 'EQD' && comp(seg, 0) === 'CN') {
      positions.push({ containerNo: comp(seg, 1) ?? '', stowage: currentStow, isoTypeCode: comp(seg, 2) });
    }
  }
  if (positions.length === 0) warnings.push('BAPLIE had no stowed containers');
  return { data: { vesselRef, positions }, rawRef: makeRawRef('TOS', 'BAPLIE', vesselRef ?? 'UNKNOWN'), warnings };
}

/**
 * IFTSTA — multimodal status report. STS status code → CargoEvent. We map the
 * common transport-status codes to canonical event types; unknown codes become
 * YARD_MOVE with the raw status on payload (no invented event types).
 */
function iftstaStatusToEvent(statusCode?: string): EventType {
  switch (statusCode) {
    case '1':
    case 'AG': // arrival at gate
      return 'GATE_IN';
    case '7':
    case 'AF': // departed gate
      return 'GATE_OUT';
    case 'RL': // rail load
      return 'RAIL_OUT';
    case 'RU': // rail unload
      return 'RAIL_IN';
    default:
      return 'YARD_MOVE';
  }
}

export function mapIftsta(raw: string, opts: BaseOpts = {}): MapResult<CargoEvent[]> {
  const { segments } = tokenizeEdifact(raw);
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;
  const bgm = findSeg(segments, 'BGM');
  const docNo = comp(bgm!, 1) ?? 'UNKNOWN';
  const nad = findSeg(segments, 'NAD');
  const facilityId = comp(nad!, 1) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
  const dt = firstDateTime(segments, ['334', '7', '137'], offsetDefault);
  const ts = dt?.iso ?? new Date(Date.UTC(1970, 0, 1)).toISOString();

  const sts = findSeg(segments, 'STS');
  const statusCode = comp(sts!, 1, 0) ?? comp(sts!, 0);
  const eventType = iftstaStatusToEvent(statusCode);

  const rawRef = makeRawRef('TOS', 'IFTSTA', docNo);
  const events = findAllSegs(segments, 'EQD')
    .filter((s) => comp(s, 0) === 'CN')
    .map((eqd) => {
      const containerNo = comp(eqd, 1) ?? '';
      return finalizeEvent({
        eventId: deriveEventId('TOS', 'IFTSTA', docNo, containerNo, eventType),
        containerNo,
        eventType,
        ts,
        sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
        facilityId,
        sourceSystem: 'TOS',
        rawRef,
        payload: { statusCode },
      });
    });
  if (events.length === 0) warnings.push('IFTSTA had no EQD+CN segments');
  return { data: events, rawRef, warnings };
}
