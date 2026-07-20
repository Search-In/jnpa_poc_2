/**
 * Shipping-line list (IAL / EAL) CSV → canonical {@link Container} (reference
 * data path, not the synthetic generator).
 *
 * The reference data package ships two shipping-line manifests as plain CSV:
 *   - IAL = Import Advance List   (Category "I") — imports expected at the port
 *   - EAL = Export Acceptance List (Category "E") — exports accepted for a vessel
 *
 * These are the ONLY cargo-grade source files in the package that are directly
 * machine-readable with no third-party dependency, so they seed the reference
 * container set. The two dialects differ in header spelling (e.g. `Container`
 * vs `ContainerNbr`, `GrossWeightInMT` vs `GrossWeightin KGS`, `Seal` present
 * only on IAL, `REEFER STS`/`TEMP` present only on EAL), so every field is read
 * through a tolerant multi-name lookup.
 *
 * This module is PURE (no fs, no Date.now) and browser-safe: the Node ingest
 * script reads the files and passes their text in, so the same transform is unit
 * -testable and could later be fed by a live shipping-line feed unchanged. It
 * reuses the canonical `@jnpa/schemas` entity — it does NOT invent a new shape.
 */
import type { Container, ContainerSizeFt, OriginStream } from '@jnpa/schemas';

/** One parsed shipping-line row: the canonical container + the list-level
 * metadata that has no Container field (carried into the derived event later). */
export interface ShiplineRecord {
  container: Container;
  /** Which list this row came from. */
  source: 'IAL' | 'EAL';
  /** Port of discharge (destination), when present. */
  pod?: string;
  /** Port of loading (origin), when present. */
  pol?: string;
  /** Operating line/service code from the list (e.g. "KMD"). */
  line?: string;
}

/**
 * Minimal RFC-4180-ish CSV reader: splits rows on newlines and fields on commas,
 * honouring double-quoted fields (which may contain commas). Returns one record
 * per data row keyed by the trimmed header names. Blank trailing rows are
 * dropped. Sufficient for the flat shipping-line lists; a live feed would swap
 * in a hardened parser behind the same {@link ShiplineRecord} contract.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  const header = rows.shift();
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (const r of rows) {
    if (r.every((c) => c.trim() === '')) continue; // skip blank rows
    const rec: Record<string, string> = {};
    keys.forEach((k, idx) => { rec[k] = (r[idx] ?? '').trim(); });
    out.push(rec);
  }
  return out;
}

/** Case/space-tolerant field lookup across the two header dialects. */
function pick(row: Record<string, string>, ...names: string[]): string {
  const lowered = new Map(Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ''), v]));
  for (const n of names) {
    const v = lowered.get(n.toLowerCase().replace(/\s+/g, ''));
    if (v != null && v !== '') return v;
  }
  return '';
}

/** ISO 6346 size/type code → size in feet (first character: 2=20', 4=40', L=45'). */
function sizeFromIso(iso: string): ContainerSizeFt {
  const c = iso.trim().charAt(0).toUpperCase();
  if (c === '4') return 40;
  if (c === 'L') return 45;
  return 20;
}

/** Category letter (I/E) or list kind → canonical origin stream (CFS default). */
function streamFor(category: string, kind: 'IAL' | 'EAL'): OriginStream {
  const c = category.trim().toUpperCase();
  if (c === 'E' || (c === '' && kind === 'EAL')) return 'EXPORT_CFS';
  return 'IMPORT_CFS';
}

/**
 * Map one shipping-line CSV row to a {@link ShiplineRecord}. Returns null when
 * the row has no container number (the natural key). `asOfIso` stamps
 * `lastUpdatedTs` deterministically — the caller supplies the dataset window
 * origin so the transform stays free of Date.now.
 */
export function shiplineRowToRecord(
  row: Record<string, string>,
  kind: 'IAL' | 'EAL',
  asOfIso: string,
): ShiplineRecord | null {
  const containerNo = pick(row, 'Container', 'ContainerNbr', 'ContainerNo').toUpperCase().replace(/\s+/g, '');
  if (!containerNo) return null;

  const isoTypeCode = pick(row, 'ISO');
  const sizeFt = sizeFromIso(isoTypeCode);
  // Both lists carry gross weight as a plain number; the IAL header is labelled
  // "MT" but the values are kilograms (e.g. 19880 for a 20' box), so both are
  // read as KG. Documented normalisation, not a guess about the real unit.
  const grossWtKg = Number(pick(row, 'GrossWeightInMT', 'GrossWeightin KGS', 'GrossWeight', 'GrossWeightInKGS')) || 0;
  const statusLetter = pick(row, 'Status').toUpperCase();
  const seal = pick(row, 'Seal');
  const line = pick(row, 'Line');
  const category = pick(row, 'Category');
  const pod = pick(row, 'POD');
  const pol = pick(row, 'POL');

  // Reefer: EAL carries an explicit REEFER STS flag + TEMP; IAL carries Temp.
  const reeferSts = pick(row, 'REEFER STS', 'ReeferStatus').toUpperCase();
  const tempRaw = pick(row, 'TEMP', 'Temp');
  const temp = Number(tempRaw);
  const isReefer = reeferSts === 'Y' || (tempRaw !== '' && Number.isFinite(temp) && isoTypeCode.toUpperCase().includes('R'));

  // Hazmat: first IMDG/UN pair when present.
  const imdgClass = pick(row, 'IMDG1', 'IMO1');
  const unNo = pick(row, 'UN NBR 1', 'UN1', 'UNNBR1');

  const container: Container = {
    containerNo,
    isoTypeCode,
    sizeFt,
    laden: statusLetter !== 'E',
    grossWtKg,
    cargoType: '',
    ...(isReefer && Number.isFinite(temp) ? { reefer: { setpointC: temp, currentC: temp } } : {}),
    ...(imdgClass ? { hazmatIMDG: { imdgClass, ...(unNo ? { unNo } : {}) } } : {}),
    lineOwner: containerNo.slice(0, 4),
    currentSealNo: seal,
    status: 'EXPECTED',
    originStream: streamFor(category, kind),
    lastUpdatedTs: asOfIso,
  };

  return {
    container,
    source: kind,
    ...(pod ? { pod } : {}),
    ...(pol ? { pol } : {}),
    ...(line ? { line } : {}),
  };
}

/** Parse a whole IAL/EAL CSV file's text into canonical shipping-line records. */
export function parseShiplineCsv(text: string, kind: 'IAL' | 'EAL', asOfIso: string): ShiplineRecord[] {
  return parseCsv(text)
    .map((row) => shiplineRowToRecord(row, kind, asOfIso))
    .filter((r): r is ShiplineRecord => r !== null);
}
