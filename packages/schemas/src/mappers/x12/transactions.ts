/**
 * ANSI X12 transaction-set mappers (prompt §4 / bid §8.4.1):
 *   322 — Terminal Operations & Intermodal Ramp Activity
 *   315 — Status Details (Ocean)
 *   304 — Shipping Instructions
 * Each → CargoEvent[] or canonical projection, with rawRef preserved.
 */
import type { CargoEvent, EventType } from '../../entities/cargo-event.js';
import { deriveEventId, finalizeEvent, makeRawRef } from '../support.js';
import { el, findAllX12, findX12, parseX12DateTime, tokenizeX12 } from './tokenizer.js';
import type { MapResult } from '../support.js';

interface BaseOpts {
  defaultFacilityId?: string;
  defaultOffsetMin?: number;
}

/**
 * X12 322 status/action codes (Y4 segment, element 5) → canonical event types.
 * Common codes: I=gate in, O=gate out, RD=rail departed, RA=rail arrived,
 * VD=vessel discharge, VL=vessel load.
 */
function status322ToEvent(code?: string): EventType {
  switch (code) {
    case 'I':
    case 'GI':
      return 'GATE_IN';
    case 'O':
    case 'GO':
      return 'GATE_OUT';
    case 'RA':
      return 'RAIL_IN';
    case 'RD':
      return 'RAIL_OUT';
    case 'VD':
    case 'VL':
      return 'YARD_MOVE';
    default:
      return 'YARD_MOVE';
  }
}

/**
 * 322 — Terminal Operations & Intermodal Ramp Activity.
 * Structure (subset):
 *   ST*322*0001~
 *   Q5*...                 status / equipment-area
 *   N9*BM*<ref>~           reference (booking/BOL)
 *   Y4*<containerNo>*...*<statusCode>~   container + status
 *   N1*<facility>~
 *   DTM*... or use Y4 date
 */
export function map322(raw: string, opts: BaseOpts = {}): MapResult<CargoEvent[]> {
  const { segments } = tokenizeX12(raw);
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;

  const n1 = findX12(segments, 'N1');
  const facilityId = (n1 && el(n1, 4)) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';

  const st = findX12(segments, 'ST');
  const ctrlNo = (st && el(st, 2)) ?? 'UNKNOWN';
  const rawRef = makeRawRef('TOS', 'X12-322', ctrlNo);

  const events: CargoEvent[] = [];
  for (const y4 of findAllX12(segments, 'Y4')) {
    // Y4: 01 booking, 02 booking seq, 03 date, 04 time?, 05 status/equipment
    const containerNo = el(y4, 1) ?? el(y4, 6) ?? '';
    const statusCode = el(y4, 5);
    const date = el(y4, 3);
    const time = el(y4, 4);
    const dt = parseX12DateTime(date, time, offsetDefault);
    const eventType = status322ToEvent(statusCode);
    if (!containerNo) {
      warnings.push('Y4 without container number skipped');
      continue;
    }
    events.push(
      finalizeEvent({
        eventId: deriveEventId('TOS', 'X12-322', ctrlNo, containerNo, eventType),
        containerNo,
        eventType,
        ts: dt?.iso ?? new Date(Date.UTC(1970, 0, 1)).toISOString(),
        sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
        facilityId,
        sourceSystem: 'TOS',
        rawRef,
        payload: { statusCode },
      }),
    );
  }
  if (events.length === 0) warnings.push('322 had no Y4 segments');
  return { data: events, rawRef, warnings };
}

/**
 * 315 — Status Details (Ocean). R4/Q2 carry port + vessel; status events in V9.
 * Maps to YARD_MOVE/GATE events keyed by V9 status code, container from N9*EQ.
 */
function status315ToEvent(code?: string): EventType {
  switch (code) {
    case 'I':
      return 'GATE_IN';
    case 'OA':
    case 'OUT':
      return 'GATE_OUT';
    case 'UV': // unloaded from vessel
      return 'YARD_MOVE';
    case 'AE': // loaded on vessel
      return 'YARD_MOVE';
    default:
      return 'YARD_MOVE';
  }
}

export function map315(raw: string, opts: BaseOpts = {}): MapResult<CargoEvent[]> {
  const { segments } = tokenizeX12(raw);
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;

  const st = findX12(segments, 'ST');
  const ctrlNo = (st && el(st, 2)) ?? 'UNKNOWN';
  const rawRef = makeRawRef('SHIPLINE', 'X12-315', ctrlNo);

  // Container number: B4 element 7, or N9*EQ.
  const b4 = findX12(segments, 'B4');
  let containerNo = b4 ? el(b4, 7) : undefined;
  if (!containerNo) {
    const n9eq = findAllX12(segments, 'N9').find((s) => el(s, 1) === 'EQ' || el(s, 1) === 'CN');
    containerNo = n9eq ? el(n9eq, 2) : undefined;
  }
  if (!containerNo) {
    warnings.push('315 without resolvable container number');
    return { data: [], rawRef, warnings };
  }

  const statusCode = b4 ? el(b4, 1) : undefined;
  const date = b4 ? el(b4, 5) : undefined;
  const time = b4 ? el(b4, 6) : undefined;
  const dt = parseX12DateTime(date, time, offsetDefault);

  const r4 = findX12(segments, 'R4');
  const facilityId = (r4 && el(r4, 3)) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
  const eventType = status315ToEvent(statusCode);

  return {
    data: [
      finalizeEvent({
        eventId: deriveEventId('SHIPLINE', 'X12-315', ctrlNo, containerNo, eventType),
        containerNo,
        eventType,
        ts: dt?.iso ?? new Date(Date.UTC(1970, 0, 1)).toISOString(),
        sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
        facilityId,
        sourceSystem: 'SHIPLINE',
        rawRef,
        payload: { statusCode },
      }),
    ],
    rawRef,
    warnings,
  };
}

/**
 * 304 — Shipping Instructions. This is documentary, not a movement; returns a
 * ShippingDoc-like projection (type inferred EAL for export instructions).
 */
export interface X12ShippingInstruction {
  ctrlNo: string;
  bolNo?: string;
  lineId?: string;
  containerNos: string[];
}

export function map304(raw: string): MapResult<X12ShippingInstruction> {
  const { segments } = tokenizeX12(raw);
  const warnings: string[] = [];
  const st = findX12(segments, 'ST');
  const ctrlNo = (st && el(st, 2)) ?? 'UNKNOWN';

  const b2 = findX12(segments, 'B2');
  const lineId = b2 ? el(b2, 1) : undefined;
  const bolNo = b2 ? el(b2, 3) : undefined;

  const containerNos = findAllX12(segments, 'N9')
    .filter((s) => el(s, 1) === 'EQ' || el(s, 1) === 'CN')
    .map((s) => el(s, 2) ?? '')
    .filter(Boolean);

  if (containerNos.length === 0) warnings.push('304 had no equipment references');
  return {
    data: { ctrlNo, bolNo, lineId, containerNos },
    rawRef: makeRawRef('SHIPLINE', 'X12-304', ctrlNo),
    warnings,
  };
}
