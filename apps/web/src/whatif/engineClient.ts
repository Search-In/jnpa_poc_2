/**
 * The audited answer for a UC-2 scenario.
 *
 * Why UC-2 does not compute these itself
 * --------------------------------------
 * S1-S6 in `packages/data/src/scenarios-mock.ts` are a before/after storytelling
 * instrument: a named parameter set multiplied into a KPI snapshot
 * (`value * factor`). They are honest about it — every run prepends an
 * `AB_ASSUMPTIONS` action saying so — and they are the right tool for the guided
 * tour, which has to run offline on a demo machine.
 *
 * They cannot answer the JNPA Notice. II-A asks whether the gate absorbs a modal
 * shift, with an hourly profile before and after and the first constraint to
 * saturate; II-B asks for gross moves per hour worked per vessel call. Neither
 * quantity exists in this repository: there is no crane, berth or move entity in
 * `packages/schemas`, and the only hourly array in the codebase is a hard-coded
 * 24-point weight curve. Both live in the UC-3 database.
 *
 * Notice §1.d settles it regardless — *"the API queries used to obtain the
 * underlying data, so the working can be traced"*. A multiplier applied in the
 * browser has no query to show.
 *
 * So the two coexist:
 *
 *   S1-S6    the story — coach-marked steps, map overlays, the KPI wall
 *   engine   the numbers — hourly profiles, saturation, the query trace
 *
 * Same engine as UC-1 and UC-3, so a figure quoted here is the figure quoted
 * there. The gateway is reached through the existing `/poc3` proxy, which
 * already points at the UC-3 backend this app takes all its cargo data from.
 */
import { CARGO_API_BASE } from '../state/AppContext';

/** Mirrors services/cargo/simulation/base.py::SimulationResult. */
export interface EngineAssumption {
  field: string;
  value: unknown;
  reason: string;
  source: 'MEASURED' | 'DERIVED' | 'ASSUMED' | 'PARAMETER';
}

export interface EngineQuery {
  purpose: string;
  sql: string;
  params: Record<string, unknown>;
  api?: string;
  row_count?: number;
  error?: string;
}

export interface EngineResult {
  scenario: string;
  method: string;
  result: Record<string, any>;
  // Booleans are part of this contract: modal-shift reports `gate_absorbs_load`
  // and channel-closure `berth_lock_reached` as figures.
  figures: Record<string, number | string | boolean | null>;
  assumptions: EngineAssumption[];
  queries: EngineQuery[];
  recommendations: Array<{ action: string; reason: string; [k: string]: unknown }>;
  data_available: boolean;
  notes: string[];
}

/**
 * The two JNPA Notice scenarios this use case is asked about, plus the one
 * bidder-proposed scenario whose subject is the yard.
 *
 * `owner` is UC-2 for all three; they are computed in UC-3 because that is where
 * the berthing, traffic and gate tables are. The panel says so rather than
 * leaving an evaluator to wonder why the UC-2 answer is not computed in UC-2.
 */
export const UC2_SCENARIOS = [
  {
    id: 'modal-shift',
    ref: 'II-A',
    label: 'Rail to road modal shift',
    question:
      'If 20% of rail-evacuated volume moves to road for 1-3 August, does the gate absorb it?',
    // "Twenty per cent of containers currently evacuated by rail are moved to
    //  road instead for period 1st August 2026 to 3rd August 2026."
    params: { from_date: '2026-08-01', to_date: '2026-08-03', shift_pct: 0.2 },
  },
  {
    id: 'crane-productivity',
    ref: 'II-B',
    label: 'Equipment availability',
    question:
      'What is the effective productivity per vessel call, and what does a 25% reduction on one call cost?',
    // "Model a twenty-five per cent reduction … Take up a vessel on 6th August."
    params: { as_of: '2026-08-06T00:00:00Z', reduction_pct: 0.25, window_hours: 48 },
  },
  {
    id: 'yard-feedback',
    ref: 'N-2',
    label: 'Yard saturation feedback (bidder-proposed)',
    question:
      'Evacuation drops while discharge continues. Where does the yard settle, and when does it tip?',
    params: { from_date: '2026-08-01', to_date: '2026-08-05', evacuation_drop_pct: 0.5 },
  },
] as const;

export type Uc2ScenarioId = (typeof UC2_SCENARIOS)[number]['id'];

export class EngineUnavailable extends Error {}

/**
 * Run one audited scenario against the UC-3 gateway.
 *
 * Throws :class:`EngineUnavailable` on any transport failure so the caller can
 * say "the audited figures need the gateway" instead of rendering a broken
 * panel. S1-S6 never depend on this — they run fully in the browser.
 */
export async function runEngineScenario(
  scenario: string,
  params: Record<string, unknown> = {},
): Promise<EngineResult> {
  const url = `${CARGO_API_BASE}/api/cargo/simulate/${encodeURIComponent(scenario)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new EngineUnavailable(
      'The UC-3 gateway is not reachable, so the audited figures cannot be ' +
      'fetched. The guided scenarios below still run.',
    );
  }
  if (!res.ok) {
    throw new EngineUnavailable(
      `The UC-3 gateway returned ${res.status} for this scenario.`,
    );
  }
  return (await res.json()) as EngineResult;
}
