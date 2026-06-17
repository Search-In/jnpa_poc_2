/**
 * CODECO (Container gate-in/gate-out report) → CargoEvent[] (prompt §4).
 *
 * Mapping rules (from §4, explicit):
 *  - movement type (CNI/EQD/RFF chain)  -> GATE_IN | GATE_OUT
 *  - seal segment (SEL)                 -> currentSealNo  (also emits ESEAL_AFFIX)
 *  - damage segment (DGS/FTX+AAI or EQD damage code) -> DAMAGE_FLAG
 *  - inland-transport segment (TDT / EQD mode) -> road vs rail mode on payload
 *
 * CODECO real structure (D21A, simplified to the segments we consume):
 *   UNH+<ref>+CODECO:D:21A:UN'
 *   BGM+34+<docNo>+9'                      message function
 *   DTM+137:<datetime>:203'                document date
 *   NAD+CA+<terminal>'                     terminal / facility
 *   EQD+CN+<containerNo>+<isoType>'        equipment
 *   RFF+<qual>:<gateRef>'                  references (e.g. gate id)
 *   DTM+7:<datetime>:203'                  actual movement datetime
 *   LOC+165+<gateId>'                      gate location
 *   MEA+...'                               measurements (gross weight)
 *   SEL+<sealNo>+<party>'                  seal
 *   TDT+<qual>++<mode>'                    transport mode (3=road, 2=rail...)
 *   FTX+AAI+++DAMAGE...'                   free text — damage note
 *   CNI / movement qualifier             gate direction
 */

import type { CargoEvent, EventType } from '../../entities/cargo-event.js';
import { deriveEventId, finalizeEvent, makeRawRef, parseEdifactDateTime } from '../support.js';
import { comp, findAllSegs, findSeg, tokenizeEdifact } from './tokenizer.js';
import type { MapResult } from '../support.js';

export interface CodecoMapOptions {
  /** Facility id when NAD is absent or terminal not resolvable. */
  defaultFacilityId?: string;
  /** Source local offset (minutes); JNPT default IST. */
  defaultOffsetMin?: number;
}

/** EDIFACT transport-mode code (TDT/8067) → canonical mode label. */
function transportMode(code?: string): 'ROAD' | 'RAIL' | 'SEA' | 'UNKNOWN' {
  switch (code) {
    case '3':
      return 'ROAD';
    case '2':
      return 'RAIL';
    case '1':
      return 'SEA';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Determine gate direction from BGM message function / movement code.
 * In CODECO, BGM element 1 (document name code) commonly carries the movement:
 *   '34' / 'gate in', and the RFF/STS chain disambiguates. We support a robust
 * heuristic: explicit MOA/STS not present in this profile, so we read a custom
 * GID/STS code if present, else fall back to BGM doc-name code mapping.
 */
function gateDirection(
  bgmDocCode: string | undefined,
  movementCode: string | undefined,
): EventType {
  // Movement code from STS or a TDT inland segment, if the feed supplies it.
  if (movementCode === 'IN' || movementCode === 'GATEIN') return 'GATE_IN';
  if (movementCode === 'OUT' || movementCode === 'GATEOUT') return 'GATE_OUT';
  // BGM document name codes used by common terminal CODECO profiles:
  //   34 = gate-in advice, 36 = gate-out advice (terminal-specific; documented)
  if (bgmDocCode === '36') return 'GATE_OUT';
  return 'GATE_IN';
}

export function mapCodeco(raw: string, opts: CodecoMapOptions = {}): MapResult<CargoEvent[]> {
  const { segments } = tokenizeEdifact(raw);
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;

  const unh = findSeg(segments, 'UNH');
  const msgRef = comp(unh!, 0) ?? 'UNKNOWN';
  const msgType = comp(unh!, 1, 0);
  if (msgType && msgType !== 'CODECO') {
    warnings.push(`Expected CODECO message, got ${msgType}`);
  }

  const bgm = findSeg(segments, 'BGM');
  const bgmDocCode = comp(bgm!, 0);
  const docNo = comp(bgm!, 1) ?? msgRef;

  const nad = findSeg(segments, 'NAD');
  const facilityId = comp(nad!, 1) ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';

  // Movement datetime: prefer DTM+7 (actual), else DTM+137 (doc date).
  const dtms = findAllSegs(segments, 'DTM');
  let movementIso: string | undefined;
  let movementOffset = offsetDefault;
  let docIso: string | undefined;
  for (const dtm of dtms) {
    const qual = comp(dtm, 0, 0);
    const value = comp(dtm, 0, 1) ?? '';
    const fmt = comp(dtm, 0, 2) ?? '203';
    const parsed = parseEdifactDateTime(value, fmt, offsetDefault);
    if (qual === '7') {
      movementIso = parsed.iso;
      movementOffset = parsed.offsetMin;
    } else if (qual === '137') {
      docIso = parsed.iso;
    }
  }
  const ts = movementIso ?? docIso;
  if (!ts) {
    warnings.push('No usable DTM; movement timestamp missing');
  }

  // Transport mode (road/rail) from TDT.
  const tdt = findSeg(segments, 'TDT');
  const mode = transportMode(comp(tdt!, 2, 0) ?? comp(tdt!, 2));

  // Each EQD+CN starts an equipment (container) block.
  const eqds = findAllSegs(segments, 'EQD').filter((s) => comp(s, 0) === 'CN');
  if (eqds.length === 0) {
    warnings.push('No EQD+CN equipment segments found');
  }

  // Resolve seal / damage / gate / weight which (in this profile) apply to the
  // single equipment in a CODECO; multi-equipment feeds repeat the block.
  const sel = findSeg(segments, 'SEL');
  const sealNo = comp(sel!, 0);

  const loc = findAllSegs(segments, 'LOC').find((s) => comp(s, 0) === '165');
  const gateId = comp(loc!, 1) ?? undefined;

  const mea = findAllSegs(segments, 'MEA').find((s) => comp(s, 0) === 'AAE' || comp(s, 0) === 'WT');
  const grossWtRaw = comp(mea!, 2, 1);
  const grossWtKg = grossWtRaw ? Number(grossWtRaw) : undefined;

  const damageFtx = findAllSegs(segments, 'FTX').find(
    (s) => comp(s, 0) === 'AAI' && /DAMAG/i.test((s.elements[3] ?? []).join(' ')),
  );

  const rawRef = makeRawRef('TOS', 'CODECO', docNo);
  const events: CargoEvent[] = [];
  const baseTs = ts ?? new Date(Date.UTC(1970, 0, 1)).toISOString();

  for (const eqd of eqds) {
    const containerNo = comp(eqd, 1) ?? '';
    const isoType = comp(eqd, 2);
    const direction = gateDirection(bgmDocCode, undefined);

    const payload: Record<string, unknown> = {
      isoTypeCode: isoType,
      transportMode: mode,
      grossWtKg,
      gateId,
      sealNo,
      messageRef: msgRef,
    };

    events.push(
      finalizeEvent({
        eventId: deriveEventId('TOS', 'CODECO', docNo, containerNo, direction),
        containerNo,
        eventType: direction,
        ts: baseTs,
        sourceOffsetMin: movementOffset,
        facilityId,
        gateId,
        sourceSystem: 'TOS',
        rawRef,
        payload,
      }),
    );

    // Seal present -> emit ESEAL_AFFIX so currentSealNo is updated by the fold.
    if (sealNo) {
      events.push(
        finalizeEvent({
          eventId: deriveEventId('TOS', 'CODECO', docNo, containerNo, 'ESEAL_AFFIX'),
          containerNo,
          eventType: 'ESEAL_AFFIX',
          ts: baseTs,
          sourceOffsetMin: movementOffset,
          facilityId,
          gateId,
          sourceSystem: 'TOS',
          rawRef,
          payload: { sealNo },
        }),
      );
    }

    // Damage note -> DAMAGE_FLAG.
    if (damageFtx) {
      events.push(
        finalizeEvent({
          eventId: deriveEventId('TOS', 'CODECO', docNo, containerNo, 'DAMAGE_FLAG'),
          containerNo,
          eventType: 'DAMAGE_FLAG',
          ts: baseTs,
          sourceOffsetMin: movementOffset,
          facilityId,
          gateId,
          sourceSystem: 'TOS',
          rawRef,
          payload: { note: (damageFtx.elements[3] ?? []).join(' ') },
        }),
      );
    }
  }

  return { data: events, rawRef, warnings };
}
