/**
 * Which panels can ingest data, and as what.
 *
 * POC-3 exposes one validate/upload pair per ingest MODULE, each keyed by a
 * document discriminator whose form-field name differs per module:
 *
 *   /api/shipping-lines  list_type = IAL | EAL | EDO
 *   /api/gate-docs       doc_type  = EIR | PIN | FORM13
 *   /api/cfs-ecy         facility  = CFS | ECY
 *
 * A panel that maps onto one of these gets an Import button; the rest do not,
 * because there is nothing to upload to. Keeping the map here rather than inline
 * makes that coverage reviewable in one place.
 *
 * ⚠ Verified against the live gateway. Adding an entry whose module/param does
 * not exist server-side produces a 400 at upload time, not a compile error — so
 * check the router before adding one.
 *
 * Currently MOUNTED: `eal` (Export → Load list), `edo` (Import → E-DO),
 * `eir` + `pin` (Gate tab), `cfs`/`ecy` (CFS/ECY, once a facility is chosen).
 * `ial` and `form13` are defined and valid but have no single-purpose panel to
 * hang off yet — the Export gate-documents view mixes Form 13, EIR and PIN in one
 * table, so it has no unambiguous doc_type. Mount them when such a view exists.
 *
 * NOT here, deliberately:
 *  - Movements / cargo — `POST /api/cargo` creates ONE record from a form; there
 *    is no bulk cargo ingest endpoint.
 *  - Movements / cargo — `POST /api/cargo` creates ONE record from a form; there
 *    is no bulk cargo ingest endpoint. (Repeated above; kept for the contrast.)
 *  - ITRHO, Empty, Rail, Pendency — simulator-backed, no ingest route.
 */
import type { UploadTarget } from '@jnpa/data';

const SPREADSHEET = '.csv,.xlsx,.xls,.xml,text/csv';

export const UPLOAD_TARGETS = {
  /**
   * Customs documents — IGM, OOC, SMTP, RMS, LEO, Shipping Bill (UC2-036).
   *
   * The odd one out, twice over. It carries NO discriminator: the server routes
   * on the filename (CHPOI03 / CHPOI10 / CHPOI13 prefixes, .TXT, an .XLSX header
   * probe), so the operator picks a file and the module identifies itself.
   *
   * And it has NO dry run. `POST /api/customs/import` re-scans a server-side
   * directory and cannot take a file; the new `/upload` route reuses the same
   * `import_bytes` path the JNPA sync uses, which writes. Offering a preview the
   * server cannot honour would be worse than admitting there isn't one — the
   * import is idempotent by content hash, so a repeat upload is recognised
   * rather than duplicated, and that is what makes going straight to import safe.
   */
  customs: {
    module: 'customs',
    label: 'Customs document — IGM / OOC / SMTP / RMS / LEO / SB',
    // NOT .xls — the server's spreadsheet branch tests for .XLSX only, so an
    // .xls would always be refused. Offering it in the picker would invite a
    // failure the operator could not have predicted.
    accept: '.xml,.txt,.xlsx,text/xml',
    dryRun: false,
    template: false,
  },
  /** Export advance list — the EAL register behind the Export load list. */
  eal: {
    module: 'shipping-lines', param: 'list_type', value: 'EAL',
    label: 'EAL — Export Advance List', accept: SPREADSHEET,
  },
  /** Import advance list — the IAL counterpart. */
  ial: {
    module: 'shipping-lines', param: 'list_type', value: 'IAL',
    label: 'IAL — Import Advance List', accept: SPREADSHEET,
  },
  /** Electronic delivery order / CODECO. */
  edo: {
    module: 'shipping-lines', param: 'list_type', value: 'EDO',
    label: 'EDO — Electronic Delivery Order', accept: SPREADSHEET,
  },
  /** Equipment Interchange Report — the gate transaction record. */
  eir: {
    module: 'gate-docs', param: 'doc_type', value: 'EIR',
    label: 'EIR — Equipment Interchange Report', accept: SPREADSHEET,
  },
  /** PIN pickup ticket. */
  pin: {
    module: 'gate-docs', param: 'doc_type', value: 'PIN',
    label: 'PIN — Pickup Ticket', accept: SPREADSHEET,
  },
  /** Form 13 / e-gate pre-advice. */
  form13: {
    module: 'gate-docs', param: 'doc_type', value: 'FORM13',
    label: 'Form 13 — Gate Pre-advice', accept: SPREADSHEET,
  },
  /** Container Freight Station movements. */
  cfs: {
    module: 'cfs-ecy', param: 'facility', value: 'CFS',
    label: 'CFS — Container Freight Station', accept: SPREADSHEET,
  },
  /** Empty Container Yard movements. */
  ecy: {
    module: 'cfs-ecy', param: 'facility', value: 'ECY',
    label: 'ECY — Empty Container Yard', accept: SPREADSHEET,
  },
} satisfies Record<string, UploadTarget>;
