/**
 * Reference-data ingest (build-time, Node-only).
 *
 * Reads the JNPA reference data package's machine-readable subset from a
 * configurable directory and emits a canonical cargo dataset JSON that the web
 * app imports when VITE_CARGO_SOURCE=reference. It performs NO parsing of its
 * own — it drives the pure, unit-tested transforms exported from @jnpa/data
 * (parseShiplineCsv / parseEirJson / buildReferenceDataset), so the file source
 * can be swapped for a live feed with zero change to the mapping logic.
 *
 * Consumes today (dependency-free formats only):
 *   - Shipping lines: Data/4-Shipping Lines/{IAL FORMAT,EAL_FORMAT}/*.csv
 *   - EIR (pre-parsed): Data/8- Form13, EIR, PIN/EIR/eir_parsed/*.json
 * Everything else in the package (XLSX/EDIFACT/CHPOI-XML/PDF/JPEG) needs a
 * parser dependency or a new mapper and is intentionally skipped — see the
 * project notes on remaining work.
 *
 * Usage:
 *   node scripts/ingest-reference/index.mjs                    # local files (default)
 *   node scripts/ingest-reference/index.mjs --source api       # shipline CSVs from UC-3 gateway
 *   JNPA_REFERENCE_DIR="/path/to/Digital Twin" node scripts/ingest-reference/index.mjs
 *
 * --source api exercises the swap promised above: the shipping-line CSV set is
 * pulled from the jnpa-uc3-poc gateway file API (see gateway-source.mjs for the
 * endpoints and UC3_GATEWAY_URL / UC3_USERNAME / UC3_PASSWORD env) and fed to
 * the SAME parse functions. The EIR JSONs remain file-sourced from the local
 * reference dir in BOTH modes — they are corpus-folder-8 parsed artifacts
 * (Data/8- Form13, EIR, PIN/EIR/eir_parsed), not a gateway API group.
 *
 * Requires @jnpa/data to be built first (its dist/reference is imported below);
 * the `pnpm ingest:reference` npm script builds it (and its @jnpa/sim dep) for you.
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { login, listShiplineFiles, fetchFileText } from './gateway-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// --source files|api (default files = walk the local reference dir, byte-identical
// to the pre-swap behavior; api = shipline CSVs from the UC-3 gateway).
function parseSourceArg(argv) {
  let value = 'files';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') value = argv[i + 1] ?? '';
    else if (argv[i].startsWith('--source=')) value = argv[i].slice('--source='.length);
  }
  if (value !== 'files' && value !== 'api') {
    console.error(`[ingest-reference] invalid --source "${value}" (expected: files | api)`);
    process.exit(1);
  }
  return value;
}
const SOURCE = parseSourceArg(process.argv.slice(2));

// Import the pure transforms from @jnpa/data's built dist by path (this script is
// run standalone from the repo root, where the workspace package name is not
// resolvable). Requires: pnpm --filter @jnpa/data build.
const {
  parseShiplineCsv,
  parseEirJson,
  buildReferenceDataset,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages', 'data', 'dist', 'reference', 'index.js')).href);

// Default to the reference package location; override with JNPA_REFERENCE_DIR.
const REFERENCE_DIR =
  process.env.JNPA_REFERENCE_DIR ||
  'C:/Users/AnkitSonawane/Downloads/Digital Twin/Digital Twin';

// Emit to the web app's public/ dir: Vite serves it at runtime and does NOT
// bundle it, so the default mock/poc3 builds never contain reference data. This
// file is git-ignored (a generated artifact, not source).
const OUT_FILE = join(REPO_ROOT, 'apps', 'web', 'public', 'reference-dataset.json');

// Stamp derived shipping-line events at the mock window origin (matches @jnpa/sim
// DEMO_ORIGIN_MS = 2026-06-15T00:00Z) so reference and synthetic timelines align.
// Deterministic; no Date.now.
const AS_OF = '2026-06-15T00:00:00.000Z';

// Keep the committed artifact modest; a real feed would remove this cap.
const MAX_CONTAINERS = 300;

/** Recursively list files under `dir` (returns [] if the dir is absent). */
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

async function main() {
  const all = walk(REFERENCE_DIR);
  if (all.length === 0 && SOURCE === 'files') {
    console.error(`[ingest-reference] No files found under: ${REFERENCE_DIR}`);
    console.error('[ingest-reference] Set JNPA_REFERENCE_DIR to the reference package path.');
    process.exitCode = 1;
    return;
  }
  if (all.length === 0) {
    // api mode: shipline comes from the gateway, but EIR is still file-sourced —
    // warn (do not fail) so a corpus-less machine can still ingest shipline data.
    console.warn(`[ingest-reference] reference dir absent (${REFERENCE_DIR}) — EIR records will be empty.`);
  }

  const shipline = [];
  let ialFiles = 0;
  let ealFiles = 0;
  if (SOURCE === 'api') {
    // Live swap: same IAL/EAL classification as the file walk, but keyed on the
    // gateway-reported original filename (e.g. "IAL APMT.csv", "EAL_NSFT.csv")
    // instead of the directory name — then the SAME parseShiplineCsv transform.
    const token = await login();
    const items = await listShiplineFiles(token);
    for (const item of items) {
      let filename, text;
      try {
        ({ filename, text } = await fetchFileText(item.sha256, token));
      } catch (err) {
        console.warn(`[ingest-reference] skipped ${item.filename} (${item.sha256}): ${err.message}`);
        continue;
      }
      const name = (filename || item.filename).toUpperCase();
      const isIal = name.includes('IAL');
      const isEal = !isIal && name.includes('EAL');
      if (!isIal && !isEal) {
        console.warn(`[ingest-reference] skipped ${filename}: cannot classify as IAL or EAL`);
        continue;
      }
      const kind = isIal ? 'IAL' : 'EAL';
      try {
        const rows = parseShiplineCsv(text, kind, AS_OF);
        shipline.push(...rows);
        if (isIal) ialFiles++; else ealFiles++;
      } catch (err) {
        console.warn(`[ingest-reference] skipped ${filename}: ${err.message}`);
      }
    }
  } else {
    for (const f of all) {
      if (extname(f).toLowerCase() !== '.csv') continue;
      const upper = f.toUpperCase().replace(/\\/g, '/');
      const isIal = upper.includes('/IAL');
      const isEal = upper.includes('/EAL');
      if (!isIal && !isEal) continue;
      const kind = isIal ? 'IAL' : 'EAL';
      try {
        const rows = parseShiplineCsv(readFileSync(f, 'utf8'), kind, AS_OF);
        shipline.push(...rows);
        if (isIal) ialFiles++; else ealFiles++;
      } catch (err) {
        console.warn(`[ingest-reference] skipped ${f}: ${err.message}`);
      }
    }
  }

  const eir = [];
  let eirFiles = 0;
  for (const f of all) {
    if (extname(f).toLowerCase() !== '.json') continue;
    if (!f.toLowerCase().replace(/\\/g, '/').includes('eir_parsed')) continue;
    try {
      const rec = parseEirJson(JSON.parse(readFileSync(f, 'utf8')), AS_OF);
      if (rec) { eir.push(rec); eirFiles++; }
    } catch (err) {
      console.warn(`[ingest-reference] skipped ${f}: ${err.message}`);
    }
  }

  let override = buildReferenceDataset({ shipline, eir, asOfIso: AS_OF });

  // Apply the size cap (keep the containers' own events).
  if (override.containers.length > MAX_CONTAINERS) {
    const kept = new Set(override.containers.slice(0, MAX_CONTAINERS).map((c) => c.containerNo));
    override = {
      containers: override.containers.filter((c) => kept.has(c.containerNo)),
      events: override.events.filter((e) => kept.has(e.containerNo)),
    };
  }

  const artifact = {
    generatedFrom: 'JNPA reference data package (machine-readable subset)',
    asOf: AS_OF,
    // Provenance: where each feed came from this run. shipline flips to the
    // UC-3 gateway under --source api; EIR is corpus-folder-8 parsed artifacts
    // (not a gateway API group), so it is file-sourced in BOTH modes.
    sources: {
      ialFiles,
      ealFiles,
      eirFiles,
      shipline: SOURCE === 'api' ? 'uc3-gateway-api' : 'files',
      eir: 'files',
    },
    counts: { containers: override.containers.length, events: override.events.length },
    containers: override.containers,
    events: override.events,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
  console.log(
    `[ingest-reference] wrote ${override.containers.length} containers / ${override.events.length} events ` +
      `(IAL:${ialFiles} EAL:${ealFiles} EIR:${eirFiles}) → ${OUT_FILE}`,
  );
}

await main();
