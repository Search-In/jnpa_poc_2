/**
 * UC-II model-service connector — the Movements feed → seven-model path.
 *
 * Structured like the app's other connectors: endpoint constants, exported PURE
 * mappers, and the I/O function last, so every mapping is unit-testable with no
 * network and no fetch stub.
 *
 * Three facts about this integration are worth knowing before reading the code:
 *
 *  • **The visible page is sent, not one container.** This is not an
 *    optimisation. `arrival_cadence_h` — hours since the previous container
 *    arrived at the same facility — is not a property of a row; it is only
 *    measurable ACROSS rows. Send one container and M1 falls back to the 6.0 h
 *    default and raises `degraded`. Send the page and the cadence is measured.
 *    M6 and M7 are the same story at facility scale.
 *
 *  • **The service does the translating, not this module.** A Movements row
 *    carries no yard utilisation and no arrival cadence; the substitutions that
 *    fill those gaps live in `ml/src/uc2_models/uc2_webapp_adapter.py`,
 *    versioned, with a ledger per row. This module deliberately estimates
 *    NOTHING — a second estimator in the frontend is how two screens end up
 *    showing different dwell times for the same box.
 *
 *  • **The request is capped and the cap is reported.** The service scores at
 *    most `max_batch` containers per call. `selectPage` decides which ones
 *    travel — the focal container first, always — and the response states how
 *    many were left out rather than letting the count silently shrink.
 */

import type { ContainerMovementDTO } from '@jnpa/data';
import { mlHttp } from './client.js';
import type {
  ContainerPrediction,
  PredictionRequestRow,
  PredictionResponse,
} from './types.js';

/** Endpoint suffixes, relative to ML_API_BASE (so '/ml-api' is NOT repeated). */
export const PREDICTIONS_PATH = '/uc2/webapp/predictions';
export const MAPPINGS_PATH = '/uc2/webapp/mappings';
// ML_HEALTH_PATH lives in client.ts — its liveness probe needs it, and one
// definition beats two that can drift apart.

/**
 * How many containers travel in one call.
 *
 * Mirrors `MAX_BATCH` in `ml/src/pipeline/uc2_predictions.py`. Kept slightly
 * BELOW the service's own cap on purpose: if the two ever disagree, the request
 * is trimmed here where the operator can be told, rather than server-side where
 * the count would just come back smaller.
 */
export const MAX_BATCH = 60;

/** Event types in a Movements trail that mark the box entering the terminal. */
const GATE_IN_EVENTS = ['GATE_IN', 'VESSEL_DISCHARGE', 'RAIL_IN', 'CFS_IN'];
/** …and leaving it. */
const GATE_OUT_EVENTS = ['GATE_OUT', 'DELIVERY', 'RAIL_OUT', 'CFS_OUT'];

/** First timestamp in the trail whose event type is in `types`. Pure. */
function firstTs(move: ContainerMovementDTO, types: string[]): string | undefined {
  return move.trail.find((e) => types.includes(e.eventType))?.ts;
}

/**
 * Map one Movements row onto the request row. Pure.
 *
 * A PROJECTION, not a translation: only fields the app genuinely observed are
 * sent, under the column names the Python adapter validates against. Everything
 * absent stays absent — the service names its substitution in the ledger, which
 * is worth far more than a plausible number invented here.
 *
 * Note what is NOT done: `originStream` is passed through verbatim rather than
 * being expanded into delivery-mode columns. That expansion is domain knowledge
 * and lives in `uc2_predictions.normalise_row`, in Python, where it is
 * versioned and recorded. Doing it here would be the second copy.
 */
export function toRequestRow(move: ContainerMovementDTO): PredictionRequestRow {
  const { container, cargo } = move;
  const gateIn = firstTs(move, GATE_IN_EVENTS);
  const gateOut = firstTs(move, GATE_OUT_EVENTS);

  const row: PredictionRequestRow = {
    Container_No: container.containerNo,
    // The stream the app holds, unmodified. Python expands it.
    Origin_Stream: cargo?.origin_stream ?? container.originStream,
    Laden: container.laden ? 'Yes' : 'No',
    Shipping_Line_Code: container.lineOwner,
    ISO_Size_Type: container.isoTypeCode,
    Nature_Of_Cargo: container.cargoType,
  };

  if (move.facilityId) row.Terminal_Code = move.facilityId;
  if (container.currentSealNo) row.Seal_No = container.currentSealNo;
  // Arrival: the recorded gate-in if there is one, else the cargo ETA. Both are
  // observed; neither is derived from the other.
  const arrival = gateIn ?? cargo?.eta ?? undefined;
  if (arrival) row.Arrival_DateTime = arrival;
  if (gateIn) row.Gate_In_DateTime = gateIn;
  if (gateOut) row.Gate_Out_DateTime = gateOut;
  if (cargo?.customs_status) row.Customs_Status = cargo.customs_status;
  if (cargo?.vessel_name) row.Vessel_Name = cargo.vessel_name;
  if (cargo?.eta) row.Vessel_ETA = cargo.eta;
  if (cargo?.yard_block) row.Yard_Block = cargo.yard_block;
  // A vehicle number or a gate is what makes this a ROAD movement, which is
  // what earns the row M3's gate-queue forecast. Absent for a rail box, and
  // absent is the right answer there — a gate queue is not about that box.
  if (cargo?.vehicle_number) {
    row.Vehicle_No = cargo.vehicle_number;
    if (gateIn) row.Truck_In_Time = gateIn;
  }
  if (cargo?.gate) row.Gate = cargo.gate;
  if (move.lastEventType) row.Move_Type = move.lastEventType;

  return row;
}

/**
 * Choose which containers travel when the page is larger than the cap. Pure.
 *
 * The focal container is always first — the operator asked about that box, and
 * a panel answering "it was not in the sample" would be useless. The rest keep
 * feed order, so the same page always produces the same request and a cached
 * response agrees with a fresh one.
 */
export function selectPage(
  moves: ContainerMovementDTO[],
  focusContainerNo: string,
  cap: number = MAX_BATCH,
): ContainerMovementDTO[] {
  if (cap <= 0) return [];
  const focus = moves.filter((m) => m.container.containerNo === focusContainerNo);
  const rest = moves.filter((m) => m.container.containerNo !== focusContainerNo);
  return [...focus, ...rest].slice(0, cap);
}

/**
 * Index a response by container number so a table row finds its own box. Pure.
 */
export function indexByContainer(
  res: PredictionResponse,
): Map<string, ContainerPrediction> {
  const out = new Map<string, ContainerPrediction>();
  for (const entry of res.dashboard?.containers ?? []) {
    if (entry.container) out.set(entry.container, entry);
  }
  return out;
}

/**
 * Models that failed in this run, as readable lines. The panel shows these
 * rather than quietly rendering five blocks where seven were expected. Pure.
 */
export function failedModels(res: PredictionResponse): string[] {
  return (res.dashboard?.run?.models_failed ?? []).map(
    (f) => `${f.model}${f.error ? ` — ${f.error}` : ''}`,
  );
}

/**
 * The label for the estimated-inputs chip. Pure.
 *
 * COUNT WORDS CAREFULLY HERE. These are model INPUTS, not models. A fraction
 * like "5 of 8" sitting beside a suite of seven models reads as *five of the
 * seven models were estimated*, which is a different and much worse claim. The
 * count also varies per container, because the ledger only records inputs it
 * actually had to resolve — so a bare count is the only honest form.
 */
export function estimatedLabel(inputsAssumed: number): string {
  if (inputsAssumed <= 0) return 'all inputs observed';
  return `${inputsAssumed} estimated`;
}

/** Score a page of containers. Throws (operator-readable) on any failure. */
export async function fetchPredictions(
  moves: ContainerMovementDTO[],
  focusContainerNo: string,
): Promise<PredictionResponse> {
  const page = selectPage(moves, focusContainerNo);
  if (page.length === 0) throw new Error('[ML] no containers in the page to score');
  return mlHttp<PredictionResponse>(PREDICTIONS_PATH, {
    method: 'POST',
    body: JSON.stringify({
      rows: page.map(toRequestRow),
      focus: focusContainerNo,
      closed_lanes: [],
    }),
  });
}

/**
 * The catalogue of code tables and constants the service may substitute for a
 * field the Movements row cannot supply.
 */
export async function fetchMappingCatalogue(): Promise<Record<string, unknown>> {
  return mlHttp<Record<string, unknown>>(MAPPINGS_PATH);
}
