/**
 * UC-2 Requirement 1 — Additional Export Containers Loading Request.
 *
 * "Additional export containers loading request after the original planned
 *  stowage is concluded. Simulate the new stowage plan and plan the vessel
 *  loading including all assets plan; show the new estimated timings for
 *  loading completion and sailing plan."
 *
 * What this repository can and cannot support, stated up front (the same
 * honesty contract the yard-feedback scenario follows):
 *
 *  - The ORIGINAL PLANNED LOAD LIST is real: export-stream containers holding a
 *    customs Let Export Order (LEO) at the selected terminal. LEO is the
 *    repository's "planning concluded" marker — after it a box is cleared for
 *    loading and nothing else in the corpus advances the export leg.
 *  - STOWAGE POSITIONS (bay/row/tier) are UNAVAILABLE. The only stowage artifact
 *    anywhere is the unused BAPLIE mapper (packages/schemas mappers), which no
 *    feed populates. The "stowage plan" here is therefore load-list-level:
 *    which boxes, their sizes/weights/special handling — never invented slots.
 *  - VESSEL SLOT CAPACITY is UNAVAILABLE — no vessel entity, TEU capacity or
 *    remaining-slots figure exists. Feasibility is validity-based and says so.
 *  - LOADING RATE: no crane register or loading-rate feed exists. The berth
 *    gross rate is a declared PARAMETER (config/uc2-whatif.json) defaulting to
 *    the one captured UC-3 berth-productivity fleet mean.
 *  - SAILING PLAN: no ETD/sailing feed exists in this corpus, so absolute
 *    sailing times are UNAVAILABLE; the sailing DELAY is derived under a
 *    declared assumption (sailing follows loading completion).
 *
 * Pure and deterministic: same inputs → byte-identical result; the input arrays
 * are never mutated, so running it any number of times changes nothing —
 * the non-destructive guarantee is structural, not procedural.
 */

import type { ContainerMovementDTO } from '../interface.js';
import type { Uc2AnswerResult, Uc2Assumption, Uc2Query } from './envelope.js';

export const UC2_EXPORT_LOADING_ID = 'uc2-export-loading';

/** Default for the loading-rate PARAMETER (config/uc2-whatif.json). */
export const DEFAULT_BERTH_MOVES_PER_HOUR = 45.58;

export interface ExportLoadingParams {
  /** Terminal whose planned export loading is being revised. */
  terminalId: string;
  /** Container numbers requested as ADDITIONAL export loads (may be empty). */
  additionalContainerNos: string[];
  /** Gross berth loading rate, moves/hour — PARAMETER, operator-overridable. */
  berthMovesPerHour?: number;
}

export interface ExportLoadingInput {
  /** Full movement corpus from adapter.getContainerMovements({}). Never mutated. */
  movements: ContainerMovementDTO[];
  /** Simulation "now" — the anchor all hypothetical timings hang off. */
  asOf: string;
  params: ExportLoadingParams;
}

interface PlannedBox {
  containerNo: string;
  sizeFt: number;
  grossWtKg: number;
  reefer: boolean;
  hazmat: boolean;
  originStream: string;
  leoTs: string | null;
}

const isExport = (m: ContainerMovementDTO): boolean =>
  m.container.originStream.startsWith('EXPORT_');

const leoAt = (m: ContainerMovementDTO, terminalId: string): string | null => {
  const hit = m.trail.find((e) => e.eventType === 'LEO' && e.facilityId === terminalId);
  return hit ? hit.ts : null;
};

const toBox = (m: ContainerMovementDTO, terminalId: string): PlannedBox => ({
  containerNo: m.container.containerNo,
  sizeFt: m.container.sizeFt,
  grossWtKg: m.container.grossWtKg,
  reefer: Boolean(m.container.reefer),
  hazmat: Boolean(m.container.hazmatIMDG),
  originStream: m.container.originStream,
  leoTs: leoAt(m, terminalId),
});

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function summarise(boxes: PlannedBox[]) {
  return {
    boxes: boxes.length,
    by_size: {
      '20': boxes.filter((b) => b.sizeFt === 20).length,
      '40': boxes.filter((b) => b.sizeFt === 40).length,
      '45': boxes.filter((b) => b.sizeFt === 45).length,
    },
    gross_weight_kg: sum(boxes.map((b) => b.grossWtKg)),
    reefers: boxes.filter((b) => b.reefer).length,
    hazmat: boxes.filter((b) => b.hazmat).length,
  };
}

/**
 * Simulate the revised load list, asset plan, loading completion and sailing
 * impact for an additional-export-containers request. Non-destructive by
 * construction — the movement corpus is read, never written.
 */
export function runExportLoadingScenario(input: ExportLoadingInput): Uc2AnswerResult {
  const { movements, asOf, params } = input;
  const terminalId = params.terminalId;
  const rate = params.berthMovesPerHour ?? DEFAULT_BERTH_MOVES_PER_HOUR;

  const notes: string[] = [];
  const queries: Uc2Query[] = [];
  const assumptions: Uc2Assumption[] = [];

  if (!terminalId || !Number.isFinite(rate) || rate <= 0) {
    return {
      scenario: UC2_EXPORT_LOADING_ID,
      method: 'Not run — a terminal and a positive loading-rate parameter are required.',
      result: {},
      figures: {},
      assumptions,
      queries,
      recommendations: [],
      data_available: false,
      notes: [
        !terminalId
          ? 'No terminal selected.'
          : `Loading rate parameter must be a positive number of moves/hour (got ${String(params.berthMovesPerHour)}).`,
      ],
    };
  }

  // ---- 1. Original planned load list (MEASURED) ---------------------------
  const exportMovements = movements.filter(isExport);
  const original = exportMovements
    .filter((m) => leoAt(m, terminalId) !== null)
    .map((m) => toBox(m, terminalId))
    .sort((a, b) => a.containerNo.localeCompare(b.containerNo));
  const originalNos = new Set(original.map((b) => b.containerNo));

  queries.push({
    purpose: `Original planned load list — export boxes customs-cleared (LEO) at ${terminalId}`,
    api: 'adapter.getContainerMovements({})',
    sql: `movements.filter(originStream startsWith 'EXPORT_' AND trail has LEO @ ${terminalId})`,
    params: { terminalId },
    row_count: original.length,
  });

  // ---- 2. Validate the additional request against the corpus --------------
  const byNo = new Map(movements.map((m) => [m.container.containerNo, m] as const));
  const seen = new Set<string>();
  const planned: PlannedBox[] = [];
  const unplanned: Array<{ containerNo: string; reason: string }> = [];

  for (const raw of params.additionalContainerNos) {
    const cn = raw.trim().toUpperCase().replace(/\s+/g, '');
    if (!cn) continue;
    if (seen.has(cn)) {
      unplanned.push({ containerNo: cn, reason: 'duplicate in the request — counted once' });
      continue;
    }
    seen.add(cn);
    const m = byNo.get(cn);
    if (!m) {
      unplanned.push({ containerNo: cn, reason: 'not found in the container corpus' });
      continue;
    }
    if (!isExport(m)) {
      unplanned.push({
        containerNo: cn,
        reason: `not an export container (originStream ${m.container.originStream})`,
      });
      continue;
    }
    if (originalNos.has(cn)) {
      unplanned.push({ containerNo: cn, reason: 'already on the original planned load list' });
      continue;
    }
    planned.push(toBox(m, terminalId));
  }
  planned.sort((a, b) => a.containerNo.localeCompare(b.containerNo));

  queries.push({
    purpose: 'Additional-request validation against the same corpus',
    api: 'adapter.getContainerMovements({})',
    sql: 'request → dedupe → must exist, be EXPORT_*, and not already be on the original list',
    params: { requested: params.additionalContainerNos.length },
    row_count: planned.length,
  });

  // ---- 3. Feasibility (validity-based; capacity check UNAVAILABLE) --------
  const requested = seen.size;
  const feasibility =
    requested === 0
      ? 'NO_CHANGE'
      : planned.length === 0
        ? 'NOT_FEASIBLE'
        : unplanned.some((u) => u.reason !== 'duplicate in the request — counted once')
          ? 'PARTIALLY_FEASIBLE'
          : 'FEASIBLE';

  notes.push(
    'Vessel slot capacity: UNAVAILABLE — no vessel entity, TEU capacity or remaining-slot figure exists in this repository, so feasibility is validity-based (box exists, is an export box, is not already planned). A capacity-constrained check cannot be run and is not faked.',
    'Stowage positions: UNAVAILABLE — no bay/row/tier model exists anywhere in this repository (the BAPLIE mapper is present but no feed populates it). Original and revised stowage are therefore shown at load-list level.',
  );

  // ---- 4. Revised plan (DERIVED) ------------------------------------------
  const revised = [...original, ...planned];

  // ---- 5. Asset plan ------------------------------------------------------
  // Only asset types that actually exist in the corpus are planned. Trailer
  // feeder moves are real: an additional box whose trail shows no GATE_IN at
  // this terminal still has to be brought in through the gate before loading.
  const needsGateIn = planned.filter(
    (b) => !byNo.get(b.containerNo)!.trail.some((e) => e.eventType === 'GATE_IN' && e.facilityId === terminalId),
  );
  const railFed = planned.filter(
    (b) => byNo.get(b.containerNo)!.trail.some((e) => e.eventType === 'RAIL_IN'),
  );

  const assets = [
    {
      asset: 'Quay crane gang',
      basis: 'UNAVAILABLE',
      detail:
        'No crane register exists; the one captured berth-productivity feed carries cranes_deployed = null on every measured row, so a per-crane plan cannot be built.',
    },
    {
      asset: 'Berth loading rate',
      basis: 'PARAMETER',
      value: rate,
      detail: `${rate} gross moves/hour per berth (all cranes combined) — operator-overridable.`,
    },
    {
      asset: 'Gate / trailer feeder',
      basis: 'DERIVED',
      value: needsGateIn.length,
      detail: `${needsGateIn.length} of the ${planned.length} planned additional boxes have no GATE_IN at ${terminalId} yet and each needs one trailer gate-in move before loading.`,
    },
    {
      asset: 'Rail-fed boxes',
      basis: 'DERIVED',
      value: railFed.length,
      detail: `${railFed.length} of the planned additional boxes arrived by rail (RAIL_IN on their trail).`,
    },
  ];

  // ---- 6. Loading timing (DERIVED from PARAMETER + declared anchor) -------
  const anchorMs = new Date(asOf).getTime();
  const originalHours = original.length / rate;
  const additionalHours = planned.length / rate;
  const revisedHours = revised.length / rate;
  const iso = (ms: number) => new Date(ms).toISOString();
  const HOUR = 3_600_000;

  const originalCompletion = iso(anchorMs + originalHours * HOUR);
  const revisedCompletion = iso(anchorMs + revisedHours * HOUR);

  const leoTimes = original.map((b) => b.leoTs).filter((t): t is string => t !== null).sort();
  const readiness = leoTimes.length > 0 ? leoTimes[leoTimes.length - 1]! : null;

  assumptions.push(
    {
      field: 'original_load_list_basis',
      value: `LEO at ${terminalId}`,
      reason:
        'The customs Let Export Order is the corpus\'s "planning concluded" marker — after it a box is cleared for vessel loading and no later planning event exists in this repository.',
      source: 'MEASURED',
    },
    {
      field: 'berth_moves_per_hour',
      value: rate,
      reason:
        'No loading-rate feed exists. Default is the fleet-mean gross berth productivity from the one captured UC-3 crane-productivity result (45.58 moves/h) — a snapshot used as a planning parameter, not a live feed. Override per run or in config/uc2-whatif.json.',
      source: 'PARAMETER',
    },
    {
      field: 'loading_start_anchor',
      value: asOf,
      reason:
        'No loading schedule or crane plan exists, so absolute completion times are anchored to the simulation as-of instant. The deltas (additional hours, completion delay, sailing delay) are anchor-independent.',
      source: 'ASSUMED',
    },
    {
      field: 'one_move_per_container',
      value: 1,
      reason: 'Each box is one crane lift; twin-lift and re-stow moves are not modelled — no move-level data exists to calibrate them.',
      source: 'ASSUMED',
    },
    {
      field: 'sailing_follows_completion',
      value: true,
      reason:
        'No sailing plan (ETD) exists in this corpus, so the sailing DELAY is taken as the loading-completion delay under an unchanged completion-to-sailing buffer. Absolute sailing times stay UNAVAILABLE.',
      source: 'ASSUMED',
    },
  );

  notes.push(
    'Sailing plan: UNAVAILABLE as absolute times — no planned-sailing (ETD) feed exists in this corpus (vessel departures exist only on the live POC-3 marine API, which carries no join to these containers). The derived sailing delay equals the loading-completion delay under the declared assumption.',
    'Original loading start/completion as recorded operations: UNAVAILABLE — the corpus has no vessel-loading events (the export trail ends at LEO / gate-out). All completion times shown are hypothetical, anchored as declared.',
    'Non-destructive: this simulation reads the movement corpus and writes nothing. The original planned load list, container records and all operational data are unchanged.',
  );

  // ---- 7. Figures ---------------------------------------------------------
  const figures: Uc2AnswerResult['figures'] = {
    terminal: terminalId,
    requested_additional: requested,
    planned_additional: planned.length,
    unplanned_additional: unplanned.length,
    feasibility,
    capacity_check: 'UNAVAILABLE',
    original_boxes: original.length,
    revised_boxes: revised.length,
    additional_gross_weight_kg: sum(planned.map((b) => b.grossWtKg)),
    additional_reefers: planned.filter((b) => b.reefer).length,
    additional_hazmat: planned.filter((b) => b.hazmat).length,
    original_customs_readiness: readiness,
    original_loading_hours: round2(originalHours),
    additional_loading_hours: round2(additionalHours),
    revised_loading_hours: round2(revisedHours),
    completion_delay_hours: round2(additionalHours),
    original_completion_anchored: originalCompletion,
    revised_completion_anchored: revisedCompletion,
    original_sailing: null,
    revised_sailing: null,
    sailing_delay_hours: round2(additionalHours),
    trailer_feeder_moves: needsGateIn.length,
  };

  // ---- 8. Recommendations -------------------------------------------------
  const recommendations: Uc2AnswerResult['recommendations'] = [];
  if (unplanned.some((u) => u.reason !== 'duplicate in the request — counted once')) {
    recommendations.push({
      action: 'resolve_unplanned_boxes',
      reason: `${unplanned.length} requested ${unplanned.length === 1 ? 'box' : 'boxes'} could not be planned — see the per-container reasons in the working.`,
    });
  }
  if (needsGateIn.length > 0) {
    recommendations.push({
      action: 'schedule_feeder_trailers',
      reason: `${needsGateIn.length} additional ${needsGateIn.length === 1 ? 'box' : 'boxes'} still ${needsGateIn.length === 1 ? 'needs' : 'need'} a gate-in trailer move before loading can absorb ${needsGateIn.length === 1 ? 'it' : 'them'}.`,
    });
  }
  if (planned.some((b) => b.reefer)) {
    recommendations.push({
      action: 'verify_reefer_stowage',
      reason: `${planned.filter((b) => b.reefer).length} planned additional ${planned.filter((b) => b.reefer).length === 1 ? 'box is a reefer' : 'boxes are reefers'} — vessel plug inventory is UNAVAILABLE in this data and must be checked outside the twin.`,
    });
  }

  return {
    scenario: UC2_EXPORT_LOADING_ID,
    method:
      `Original planned load list = export boxes holding a customs LEO at ${terminalId} (measured). ` +
      'The additional request is validated against the same corpus (exists / is export / not already planned); valid boxes join the revised list. ' +
      `Loading time = boxes ÷ berth rate (${rate} moves/h, PARAMETER); the revised completion and its delay follow arithmetically, anchored at the declared start. ` +
      'Sailing delay mirrors the completion delay under the declared sailing-follows-completion assumption; absolute sailing times are UNAVAILABLE. ' +
      'Everything runs in memory on a copy-free read of the corpus — nothing operational is written.',
    result: {
      original: { ...summarise(original), containers: original },
      additional: {
        requested,
        planned: { ...summarise(planned), containers: planned },
        unplanned,
      },
      revised: summarise(revised),
      assets,
      timing: {
        anchor: asOf,
        original_completion: originalCompletion,
        revised_completion: revisedCompletion,
        additional_hours: round1(additionalHours),
      },
      sailing: {
        original: 'UNAVAILABLE',
        revised: 'UNAVAILABLE',
        delay_hours: round2(additionalHours),
        why_unavailable:
          'No planned-sailing (ETD) feed exists in this corpus and no container-to-vessel-call join is possible (all three documented join paths return zero rows).',
      },
      feasibility: { verdict: feasibility, requested, planned: planned.length, unplanned },
      unavailable: [
        'vessel slot capacity',
        'bay/row/tier stowage positions',
        'crane count / per-crane rates',
        'recorded loading start and completion',
        'planned sailing time (ETD)',
      ],
    },
    figures,
    assumptions,
    queries,
    recommendations,
    data_available: true,
    notes,
  };
}
