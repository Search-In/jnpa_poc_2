/**
 * EIR (Equipment Interchange Receipt) parsed-JSON → canonical gate
 * {@link CargoEvent} + {@link Container} (reference data path).
 *
 * The reference package ships EIRs both as scanned images (not machine-readable)
 * and as already-parsed JSON under `eir_parsed/`. Only the JSON is consumable
 * here. An EIR records a container crossing a terminal gate by road, so it is the
 * one reference source with a REAL event timestamp, truck registration and seal —
 * everything a canonical gate event needs. It reuses the `@jnpa/schemas`
 * CargoEvent spine (the same closed EventType list the format-mappers target).
 *
 * PURE: no fs, no Date.now. The Node ingest script reads the files and passes the
 * parsed objects in; a live gate/TOS feed could replace the file source unchanged.
 */
import type { CargoEvent, Container, ContainerSizeFt, EventType, OriginStream } from '@jnpa/schemas';

/** One parsed EIR: the real gate event plus the container it concerns. */
export interface EirRecord {
  container: Container;
  event: CargoEvent;
}

/** Terminal codes we can resolve from an EIR's free-text terminal / to-from. */
const KNOWN_TERMINALS = ['BMCT', 'NSICT', 'NSIGT', 'NSFT', 'GTI', 'APMT', 'JNPCT'];

function str(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Resolve a known terminal code from any of the EIR's location strings. */
function terminalFrom(...texts: string[]): string {
  const hay = texts.join(' ').toUpperCase();
  return KNOWN_TERMINALS.find((t) => hay.includes(t)) ?? '';
}

/** Parse "DD/MM/YYYY HH:MM" (EIR local time, IST) → { iso, offsetMin }. */
function parseEirDateTime(value: string, offsetMin = 330): { iso: string; offsetMin: number } | undefined {
  const m = /(\d{2})[/-](\d{2})[/-](\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return undefined;
  const [, dd, mm, yyyy, hh = '0', min = '0'] = m;
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min)) - offsetMin * 60_000;
  return { iso: new Date(utc).toISOString(), offsetMin };
}

/** "24.6 t" → 24600 kg; "24600 kg" → 24600; bare number → as kg. */
function grossToKg(raw: string): number {
  const n = Number((raw.match(/[\d.]+/) ?? ['0'])[0]);
  if (!Number.isFinite(n)) return 0;
  return /t\b|tonne|mt/i.test(raw) ? Math.round(n * 1000) : Math.round(n);
}

function sizeFt(raw: string): ContainerSizeFt {
  const n = Number(raw);
  return n === 40 ? 40 : n === 45 ? 45 : 20;
}

/**
 * Map one parsed EIR JSON object to an {@link EirRecord}. Returns null when the
 * object has no container number. `fallbackIso` stamps events/containers whose
 * EIR has no parseable DateTime, keeping the transform free of Date.now.
 *
 * Direction heuristic (documented): an "Export" EIR is a gate-IN to the terminal;
 * anything else (import/empty return) is a gate-OUT. The raw DocumentType rides
 * on the payload so a consumer can re-derive direction if needed.
 */
export function parseEirJson(obj: unknown, fallbackIso: string): EirRecord | null {
  if (obj == null || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;

  const containerNo = str(rec, 'ContainerNo', 'ContainerNumber', 'Container').toUpperCase().replace(/\s+/g, '');
  if (!containerNo) return null;

  const documentType = str(rec, 'DocumentType');
  const isExport = /export/i.test(documentType);
  const eventType: EventType = isExport ? 'GATE_IN' : 'GATE_OUT';
  const originStream: OriginStream = isExport ? 'EXPORT_CFS' : 'IMPORT_CFS';

  const parsedTs = parseEirDateTime(str(rec, 'DateTime', 'Date'));
  const ts = parsedTs?.iso ?? fallbackIso;
  const offsetMin = parsedTs?.offsetMin ?? 330;

  const terminal = terminalFrom(str(rec, 'Terminal'), str(rec, 'ToFrom'), str(rec, 'VesselVia'));
  const vehicleNo = str(rec, 'LICNo', 'VehicleNo', 'TruckNo');
  const seal1 = str(rec, 'SealNo1', 'SealNo');
  const currentSealNo = /noseal/i.test(seal1) ? '' : seal1;
  const eirNo = str(rec, 'EIRNo', 'EIRNumber');

  const event: CargoEvent = {
    eventId: `EIR-${containerNo}-${eirNo || ts}`,
    containerNo,
    eventType,
    ts,
    sourceOffsetMin: offsetMin,
    facilityId: terminal,
    ...(terminal ? { terminalId: terminal } : {}),
    ...(vehicleNo ? { vehicleNo } : {}),
    sourceSystem: 'TOS',
    rawRef: `raw/reference/eir/${eirNo || containerNo}`,
    payload: {
      documentType,
      shippingAgent: str(rec, 'ShippingAgent'),
      truckCompany: str(rec, 'TruckCompany'),
      toFrom: str(rec, 'ToFrom'),
      vesselVia: str(rec, 'VesselVia'),
      batNo: str(rec, 'BATNo'),
      sealNo1: seal1,
      sealNo2: str(rec, 'SealNo2'),
      eirNo,
    },
  };

  const container: Container = {
    containerNo,
    isoTypeCode: str(rec, 'ISOCode', 'ISO'),
    sizeFt: sizeFt(str(rec, 'ContainerSize', 'Size')),
    laden: !/empty/i.test(str(rec, 'ContainerStatus')),
    grossWtKg: grossToKg(str(rec, 'GrossWeight')),
    cargoType: '',
    lineOwner: containerNo.slice(0, 4),
    currentSealNo,
    status: eventType,
    originStream,
    lastUpdatedTs: ts,
  };

  return { container, event };
}
