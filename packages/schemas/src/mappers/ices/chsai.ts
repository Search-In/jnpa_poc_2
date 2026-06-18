/**
 * ICEGATE / ICES 1.5 Sea-Custodian message-exchange parser (prompt §4).
 *
 * ICES 1.5 custodian messages are XML documents in the CHSAI message family
 * (Custom House Sea-cargo Custodian / Automated Interface). We parse the
 * message-type code and map to canonical CargoEvents:
 *   GATEPASS      -> GATE_IN / GATE_OUT (by direction)
 *   TALLY         -> YARD_MOVE
 *   LEO           -> LEO            (Let Export Order)
 *   STUFFING      -> STUFFING
 *   DESTUFFING    -> DESTUFFING
 *   ESEAL         -> ESEAL_AFFIX / ESEAL_BREAK
 *   BE_FLAGS      -> CUSTOMS_FLAG with payload.dpdReady / payload.selectedForScan
 *
 * We use a tiny dependency-free XML reader sufficient for the flat ICES message
 * structure (element text + repeating container blocks). Production swaps in a
 * hardened XML parser, but the mapping contract is unchanged.
 */
import type { CargoEvent, EventType } from '../../entities/cargo-event.js';
import { deriveEventId, finalizeEvent, makeRawRef } from '../support.js';
import type { MapResult } from '../support.js';

// ---- minimal XML helpers --------------------------------------------------

/** First text content of <tag>…</tag>, searched within `scope`. */
function tagText(scope: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(scope);
  return m ? m[1]!.trim() : undefined;
}

/** All inner XML blocks for repeating <tag>…</tag>. */
function tagBlocks(scope: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) out.push(m[1]!);
  return out;
}

// ---- date parsing (ICES uses DD-MM-YYYY or DD/MM/YYYY HH:MM) ---------------

function parseIcesDateTime(value: string | undefined, offsetMin = 330): { iso: string; offsetMin: number } | undefined {
  if (!value) return undefined;
  const m = /(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh = '0', min = '0', ss = '0'] = m;
  const utc =
    Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)) -
    offsetMin * 60_000;
  return { iso: new Date(utc).toISOString(), offsetMin };
}

// ---- message-type dispatch -------------------------------------------------

export interface IcesMapOptions {
  defaultFacilityId?: string;
  defaultOffsetMin?: number;
}

interface ContainerFlags {
  dpdReady?: boolean;
  selectedForScan?: boolean;
}

function readBool(scope: string, tag: string): boolean | undefined {
  const v = tagText(scope, tag);
  if (v == null) return undefined;
  return /^(Y|YES|TRUE|1)$/i.test(v);
}

function messageEventType(messageType: string, direction?: string): EventType | 'BE_FLAGS' {
  switch (messageType.toUpperCase()) {
    case 'GATEPASS':
    case 'CHSAI_GATEPASS':
      return direction?.toUpperCase() === 'OUT' ? 'GATE_OUT' : 'GATE_IN';
    case 'TALLY':
    case 'CHSAI_TALLY':
      return 'YARD_MOVE';
    case 'LEO':
    case 'CHSAI_LEO':
      return 'LEO';
    case 'STUFFING':
      return 'STUFFING';
    case 'DESTUFFING':
      return 'DESTUFFING';
    case 'ESEAL':
    case 'ESEAL_AFFIX':
      return 'ESEAL_AFFIX';
    case 'ESEAL_BREAK':
      return 'ESEAL_BREAK';
    case 'BE_FLAGS':
    case 'CHSAI_BE':
      return 'BE_FLAGS';
    default:
      return 'YARD_MOVE';
  }
}

/**
 * Parse an ICES 1.5 CHSAI message into canonical CargoEvents. The document is
 * expected to have a <MessageType>, optional <Direction>, <Facility>/<Custodian>,
 * <DateTime>, and one or more <Container> blocks each with <ContainerNo>,
 * <SealNo>, <DPDReady>, <SelectedForScan>.
 */
export function mapIcesChsai(raw: string, opts: IcesMapOptions = {}): MapResult<CargoEvent[]> {
  const warnings: string[] = [];
  const offsetDefault = opts.defaultOffsetMin ?? 330;

  const messageType = tagText(raw, 'MessageType') ?? tagText(raw, 'MsgType') ?? 'TALLY';
  const direction = tagText(raw, 'Direction');
  const msgRef = tagText(raw, 'MessageId') ?? tagText(raw, 'MsgId') ?? 'UNKNOWN';
  const facilityId =
    tagText(raw, 'Facility') ?? tagText(raw, 'CustodianCode') ?? opts.defaultFacilityId ?? 'UNKNOWN_FACILITY';
  const dt = parseIcesDateTime(tagText(raw, 'DateTime') ?? tagText(raw, 'EventDateTime'), offsetDefault);
  const ts = dt?.iso ?? new Date(Date.UTC(1970, 0, 1)).toISOString();

  const resolved = messageEventType(messageType, direction);
  const rawRef = makeRawRef('ICEGATE', `ICES-${messageType}`, msgRef);

  const containerBlocks = tagBlocks(raw, 'Container');
  if (containerBlocks.length === 0) {
    warnings.push('ICES message had no <Container> blocks');
  }

  const events: CargoEvent[] = [];
  for (const block of containerBlocks) {
    const containerNo = tagText(block, 'ContainerNo') ?? tagText(block, 'ContainerNumber') ?? '';
    if (!containerNo) {
      warnings.push('Container block without ContainerNo skipped');
      continue;
    }
    const sealNo = tagText(block, 'SealNo') ?? tagText(block, 'ESealNo');
    const flags: ContainerFlags = {
      dpdReady: readBool(block, 'DPDReady'),
      selectedForScan: readBool(block, 'SelectedForScan'),
    };

    if (resolved === 'BE_FLAGS') {
      // BE third-stage flags -> CUSTOMS_FLAG carrying dpdReady / selectedForScan.
      events.push(
        finalizeEvent({
          eventId: deriveEventId('ICEGATE', `ICES-${messageType}`, msgRef, containerNo, 'CUSTOMS_FLAG'),
          containerNo,
          eventType: 'CUSTOMS_FLAG',
          ts,
          sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
          facilityId,
          sourceSystem: 'ICEGATE',
          rawRef,
          payload: { dpdReady: flags.dpdReady, selectedForScan: flags.selectedForScan },
        }),
      );
      // If selected for scan, also seed a SCAN_START intent? No — that is the
      // scanner's actual event. We only flag here.
      continue;
    }

    events.push(
      finalizeEvent({
        eventId: deriveEventId('ICEGATE', `ICES-${messageType}`, msgRef, containerNo, resolved),
        containerNo,
        eventType: resolved,
        ts,
        sourceOffsetMin: dt?.offsetMin ?? offsetDefault,
        facilityId,
        sourceSystem: 'ICEGATE',
        rawRef,
        payload: { messageType, sealNo, ...flags },
      }),
    );
  }

  return { data: events, rawRef, warnings };
}
