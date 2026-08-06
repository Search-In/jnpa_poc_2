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
 *  - IGM / OOC / SMTP — `POST /api/customs/import` takes no file. It re-scans a
 *    server-side directory ($CUSTOMS_DATA_DIR), so it is an admin action rather
 *    than a browser upload.
 *  - ITRHO, Empty, Rail, Pendency — simulator-backed, no ingest route.
 */
import type { UploadTarget } from '@jnpa/data';

const SPREADSHEET = '.csv,.xlsx,.xls,.xml,text/csv';

export const UPLOAD_TARGETS = {
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
