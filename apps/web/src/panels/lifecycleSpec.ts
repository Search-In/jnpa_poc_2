/**
 * The canonical container-lifecycle step specs — the DATA behind the step strip.
 *
 * Both markdowns (markdowns/02_Import_Container_Lifecycle.md and
 * markdowns/03_Export_Container_Lifecycle.md) open with a canonical 10-step order
 * and then label each step against the corpus. This file transcribes that, so the
 * dashboard can state which steps it can evidence and which the corpus simply does
 * not contain.
 *
 * Deliberately free of React and Calcite: test/tab-architecture.test.ts imports it
 * to assert that every step resolves to a real view or a rendered tab.
 *
 * ⚠ RULES.
 * 1. Every `state` is a MEASURED fact from the markdowns, not an impression. When
 *    new data lands, change the spec here — never soften a label to make the strip
 *    look fuller.
 * 2. `absent` and `schema-only` steps must keep their `note`. The note is the
 *    deliverable: it is the honest answer to "why is this empty?".
 * 3. Each leg stays at EXACTLY ten steps. The strip prints "N of 10", so adding an
 *    unnumbered surface here would silently restate coverage — shared surfaces go
 *    in SHARED_SURFACES instead.
 */

export type StepState = 'real' | 'schema-only' | 'absent';

export interface LifecycleStep {
  /** 1-based position in the canonical order. */
  no: number;
  /** Stable id, used as the React key and for the `view` linkage. */
  code: string;
  label: string;
  state: StepState;
  /** Shown on hover, and inline when the step is not `real`. The reason, verbatim. */
  note?: string;
  /** Segmented-control value this step is shown under, when it has one. */
  view?: string;
  /** Cross-tab destination, for steps whose documents live on another tab. */
  tab?: string;
  /** Human label for `tab`, e.g. "Customs tab". */
  tabLabel?: string;
}

export const EXPORT_STEPS: LifecycleStep[] = [
  {
    no: 1, code: 'BOOKING', label: 'Liner booking', state: 'absent',
    note: 'No booking register was supplied. Booking numbers appear only as a field on a '
      + 'Form 13 (e.g. MNL030 on MEDU1777575), never as their own document.',
  },
  {
    no: 2, code: 'PREADVICE', label: 'Pre-advice (Form 13 / Form 11)', state: 'real',
    view: 'docs',
    note: 'Road: Form 13 / e-gate pre-advice. Rail: Form 11 (its own view). Both are filed '
      + 'documents, shown as parsed.',
  },
  {
    no: 3, code: 'GATE_IN', label: 'Gate-in (EIR / CODECO)', state: 'real',
    tab: 'gate', tabLabel: 'Gate tab',
    note: '4 export gate-ins across the 5 CODECO messages, plus the terminal EIRs. '
      + '⚠ They share no container with the load list.',
  },
  {
    no: 4, code: 'VGM', label: 'VGM & seals', state: 'real',
    view: 'docs',
    note: 'Carried as fields on the pre-advice rather than as its own document — VGM 29350 kg '
      + 'and both seals are on MEDU1777575’s Form 13. ⚠ Form 11’s figures come from '
      + 'GROSS_WEIGHT with VGM_REQUIRED = No, so calling those VGM is loose.',
  },
  {
    no: 5, code: 'SB', label: 'Shipping Bill', state: 'real',
    view: 'sb',
    note: '15 distinct shipping bills are filed, but the extract carries no container number '
      + 'or BL — so no shipping bill can be attached to a box. Shown as its own register.',
  },
  {
    no: 6, code: 'LEO', label: 'Let Export Order', state: 'real',
    view: 'leo',
    note: '100 LEOs are filed, but they share no SB number with the shipping bills (LEOs are '
      + 'April 2.0–2.4M; SBs are June 4.0M). Two disjoint registers, never one document’s status.',
  },
  {
    no: 7, code: 'EAL', label: 'Export advance list (EAL)', state: 'real',
    view: 'list',
    note: 'The only export source at population scale — 5,743 lines across 5 vessel visits.',
  },
  {
    no: 8, code: 'COPRAR', label: 'Load list (COPRAR)', state: 'schema-only',
    view: 'loadmsgs',
    note: 'The only COPRAR sample is a Kolkata / Haldia call. It demonstrates the message '
      + 'schema and is not JNPA traffic.',
  },
  {
    no: 9, code: 'COARRI', label: 'Load confirmation (COARRI)', state: 'schema-only',
    view: 'loadmsgs',
    note: 'The only COARRI sample is Visakhapatnam, and it is incomplete — 200 items declared '
      + 'against 1,107 containers, of which 50 were lost to a truncated 4th message.',
  },
  {
    no: 10, code: 'VESDEP', label: 'Vessel departure (VESDEP)', state: 'real',
    view: 'departures',
    note: 'Real actual times of departure on core.vessel_call, ingested from the VESDEP messages.',
  },
];

/**
 * Import: `IGM → vessel arrival → discharge (COARRI) → yard → [RMS scan] →
 * customs OOC → E-DO → PIN/pickup → EIR at gate → CODECO gate-out`.
 * Transcribed from markdowns/02_Import_Container_Lifecycle.md.
 */
export const IMPORT_STEPS: LifecycleStep[] = [
  {
    no: 1, code: 'IGM', label: 'Manifested on IGM', state: 'real',
    view: 'igm',
    note: 'Filed ICEGATE CHPOI03 manifests with every declared container line — 16 manifests '
      + 'covering 11,914 distinct containers.',
  },
  {
    no: 2, code: 'ARRIVAL', label: 'Vessel arrival', state: 'real',
    tab: 'gate', tabLabel: 'Gate tab',
    note: 'Recorded inside the container’s own CODECO block (ArrivalDateTime) — the value the '
      + 'dwell calculation starts from.',
  },
  {
    no: 3, code: 'COARRI', label: 'Discharge from vessel', state: 'schema-only',
    tab: 'movements', tabLabel: 'Movements tab',
    note: 'TWO DIFFERENT THINGS share this step. The operational MILESTONE is recordable '
      + 'and audited — Movements has a Discharge action that advances the container to '
      + 'VESSEL_DISCHARGED and raises cargo.vessel_discharged on the event bus. What is '
      + 'missing is the DOCUMENT: no COARRI discharge confirmation exists for any JNPA call '
      + '(the only sample is Visakhapatnam), so the crane, bay and per-move detail cannot be '
      + 'shown. The milestone is recorded; the terminal’s confirmation of it is not on file.',
  },
  {
    no: 4, code: 'YARD', label: 'Yard', state: 'real',
    tab: 'pendency', tabLabel: 'Pendency tab',
    note: 'Yard occupancy and pendency come from the terminals’ published daily status reports.',
  },
  {
    no: 5, code: 'RMS', label: 'RMS scan (when selected)', state: 'real',
    view: 'scan',
    note: 'Scan lists are real, but they name IGMs 1191409 / 1193499 / 1194257 / 1194273, whose '
      + 'manifests are not in the corpus — so the 1,289 flagged and 98 scanned containers do '
      + 'not overlap. A branch, not a step every box takes.',
  },
  {
    no: 6, code: 'OOC', label: 'Customs out-of-charge', state: 'real',
    view: 'ooc',
    note: 'Filed CHPOI10 bills of entry with the granted out-of-charge, importer, duty and '
      + 'invoice items — 8 bills covering 9 containers.',
  },
  {
    no: 7, code: 'EDO', label: 'Electronic delivery order', state: 'real',
    view: 'edo',
    note: 'AGDORD delivery orders — 6 orders over 9 containers. One resolves to a filed '
      + 'manifest by IGM number, BL and container together.',
  },
  {
    no: 8, code: 'PIN', label: 'PIN pickup ticket', state: 'real',
    tab: 'gate', tabLabel: 'Gate tab',
    note: 'Terminal pickup tickets carrying the PIN, lane, yard position and trucking company. '
      + '⚠ Only 2 tickets are on file (NSFT and Nhava Sheva IGT), and one of those names no '
      + 'container — so the Gate tab shows none for any other terminal.',
  },
  {
    no: 9, code: 'EIR', label: 'EIR at gate', state: 'real',
    tab: 'gate', tabLabel: 'Gate tab',
    note: 'Equipment Interchange Reports with truck in/out, driver, licence and measured '
      + 'turnaround.',
  },
  {
    no: 10, code: 'GATE_OUT', label: 'Gate-out on truck (CODECO)', state: 'real',
    tab: 'gate', tabLabel: 'Gate tab',
    note: 'The terminal CODECO gate-out: gate pass, vehicle, gate and delivery mode.',
  },
];

/**
 * Shared surfaces both legs pass through. Top-level tabs, not sub-views, because
 * each serves BOTH directions and some roles need one without the other leg:
 * `CFS_OPERATOR` / `ICD_OPERATOR` reach CFS/ECY without being granted Export.
 */
export const SHARED_SURFACES: Record<string, { tab: string; label: string; note: string }> = {
  gate: {
    tab: 'gate',
    label: 'Gate',
    note: 'The gate serves both directions at once: its CODECO table shows export gate-in and '
      + 'import gate-out side by side, and pairs them into the truck round-trip. Splitting it '
      + 'per leg would break that pairing.',
  },
  pendency: {
    tab: 'pendency',
    label: 'Yard / Pendency',
    note: 'Yard occupancy is published per terminal, not per container, so it cannot be '
      + 'attributed to one leg.',
  },
  cfsecy: {
    tab: 'cfsecy',
    label: 'CFS / ECY',
    note: 'The off-dock leg — empty out, stuffing, then the terminal gate. Real measurements '
      + '(1,928 movements) but PORT-LEVEL ONLY: the feed shares no container with any manifest, '
      + 'advance list or gate document, so it can never be joined to a box.',
  },
  rail: {
    tab: 'rail',
    label: 'Rail T1/T2',
    note: 'Rail siding movements, feeding rail-origin exports and rail-out imports alike.',
  },
};


/**
 * The sub-views each leg's tab can show. Exported so a guided-tour step's `view`
 * (an untyped string) and each spec step's `view` can be validated against the
 * real list rather than a copy of it.
 */
export const IMPORT_VIEWS = ['overview', 'igm', 'scan', 'ooc', 'edo', 'smtp'] as const;
export const EXPORT_VIEWS = [
  'overview', 'list', 'docs', 'form11', 'sb', 'leo',
  'loadmsgs', 'cutoffs', 'departures', 'synthetic',
] as const;
