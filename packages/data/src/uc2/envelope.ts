/**
 * UC-2 local What-If envelope — structurally identical to the audited-answer
 * envelope the UC-3 engine returns (`EngineResult` in apps/web/src/whatif/
 * engineClient.ts) so the shared four-beat `WhatIfAnswer` component renders a
 * locally computed UC-2 scenario exactly like a remotely computed one: verdict,
 * assumptions stated separately with their provenance, the data reads behind
 * every figure, and notes.
 *
 * Defined here (not imported from apps/web) because packages/data cannot depend
 * on the app; the app-side type is the SHARED-FILE canonical copy and this one
 * mirrors it. Provenance vocabulary is the repo-wide contract:
 *   MEASURED  — read directly from a data source
 *   DERIVED   — calculated from measured data
 *   ASSUMED   — no data exists; a declared modelling assumption
 *   PARAMETER — a configurable value the operator can change (config/uc2-whatif.json)
 * A quantity that cannot be produced at all is reported as UNAVAILABLE in
 * `figures`/`notes` — never silently invented.
 */

export type Uc2AssumptionSource = 'MEASURED' | 'DERIVED' | 'ASSUMED' | 'PARAMETER';

export interface Uc2Assumption {
  field: string;
  value: unknown;
  reason: string;
  source: Uc2AssumptionSource;
}

/**
 * A data read behind the answer. For these locally computed scenarios there is
 * no SQL — `sql` carries the exact in-memory filter expression instead, and
 * `api` names the DataAdapter read the inputs came from, so the trail stays
 * checkable ("which rows, from which read, filtered how").
 */
export interface Uc2Query {
  purpose: string;
  sql: string;
  params: Record<string, unknown>;
  api?: string;
  row_count?: number;
  error?: string;
}

export interface Uc2AnswerResult {
  scenario: string;
  method: string;
  result: Record<string, unknown>;
  figures: Record<string, number | string | boolean | null>;
  assumptions: Uc2Assumption[];
  queries: Uc2Query[];
  recommendations: Array<{ action: string; reason: string; [k: string]: unknown }>;
  data_available: boolean;
  notes: string[];
}

/** The sentence every UC-2 what-if screen must carry (non-destructive rule). */
export const UC2_HYPOTHETICAL_NOTICE =
  'Hypothetical only — operational plans and live allocations are not changed.';
