/**
 * Unit tests for the UC-II predictions data layer and its presentation rules.
 *
 * Every test in the "regression" blocks below was written against a DEFECT that
 * actually shipped in the UC-1 build of this feature, and each was confirmed to
 * FAIL when its fix is removed — a test that passes with and without the fix is
 * worse than no test, because it certifies nothing while looking like coverage.
 * The comment above each one names the removal that makes it go red.
 *
 * These are pure tests: no DOM, no network, no fetch stub. That is deliberate —
 * the mappers, the error classification and the value formatting are all pure
 * functions precisely so they can be checked without any of that. The component
 * itself is exercised in ml-predictions-render.test.tsx.
 */

import { describe, expect, it } from 'vitest';
import type { ContainerMovementDTO } from '@jnpa/data';
import {
  estimatedLabel, failedModels, indexByContainer, selectPage, toRequestRow, MAX_BATCH,
} from '../src/data/ml/predictions.js';
import {
  httpErrorMessage, looksLikeProxyFailure, mlUrl, unreachableMessage,
  ML_PREFIX, ML_UNREACHABLE,
} from '../src/data/ml/client.js';
import {
  formatValue, gridFields, humaniseKey, orderedBlocks, statusTone, viewFor, MODEL_VIEWS,
} from '../src/components/predictions/modelViews.js';
import type { PredictionResponse } from '../src/data/ml/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function move(
  containerNo: string,
  overrides: Partial<ContainerMovementDTO> = {},
): ContainerMovementDTO {
  return {
    container: {
      containerNo,
      isoTypeCode: '45R1',
      sizeFt: 40,
      laden: true,
      grossWtKg: 21000,
      cargoType: 'FROZEN SEAFOOD',
      lineOwner: 'MAEU',
      currentSealNo: 'SL-1',
      status: 'GATED_IN',
      originStream: 'IMPORT_DPD',
      updatedTs: '2026-08-02T06:30:00Z',
    },
    lastEventType: 'GATE_IN',
    lastEventTs: '2026-08-02T06:30:00Z',
    facilityId: 'NSICT',
    trail: [
      { eventType: 'GATE_IN', ts: '2026-08-02T06:30:00Z', facilityId: 'NSICT', sourceSystem: 'TOS' },
    ],
    ...overrides,
  } as ContainerMovementDTO;
}

// ---------------------------------------------------------------------------
// toRequestRow — a projection, never an estimate
// ---------------------------------------------------------------------------

describe('toRequestRow', () => {
  it('sends the observed fields under the adapter’s own column names', () => {
    const row = toRequestRow(move('MAEU6123458'));
    expect(row.Container_No).toBe('MAEU6123458');
    expect(row.Terminal_Code).toBe('NSICT');
    expect(row.Shipping_Line_Code).toBe('MAEU');
    expect(row.ISO_Size_Type).toBe('45R1');
    expect(row.Gate_In_DateTime).toBe('2026-08-02T06:30:00Z');
  });

  /**
   * GOTCHA 4 — never estimate in the frontend.
   *
   * `originStream` travels VERBATIM. Expanding 'IMPORT_DPD' into the adapter's
   * DPD_Eligible / Delivery_Mode columns is domain knowledge, and it lives in
   * Python (uc2_predictions.normalise_row) where it is versioned and recorded
   * in the ledger. If this ever starts emitting Delivery_Mode, there are two
   * copies of that mapping and they will disagree.
   *
   * FAILS WITHOUT THE FIX: add `Delivery_Mode: 'D'` to toRequestRow.
   */
  it('passes the origin stream through without interpreting it', () => {
    const row = toRequestRow(move('MAEU6123458')) as Record<string, unknown>;
    expect(row.Origin_Stream).toBe('IMPORT_DPD');
    expect(row.Delivery_Mode).toBeUndefined();
    expect(row.DPD_Eligible).toBeUndefined();
    expect(row.Arrival_Cadence_H).toBeUndefined();
    expect(row.Facility_Load).toBeUndefined();
  });

  it('omits absent fields rather than sending a placeholder', () => {
    const row = toRequestRow(move('MSCU7654321')) as Record<string, unknown>;
    // No cargo record → no customs status, no vessel, no vehicle. Absent, not ''.
    expect('Customs_Status' in row).toBe(false);
    expect('Vessel_Name' in row).toBe(false);
    expect('Vehicle_No' in row).toBe(false);
  });

  it('only marks a road movement when the row actually carries one', () => {
    const road = toRequestRow(
      move('MAEU6123458', {
        cargo: { vehicle_number: 'MH04AB1234' },
      } as Partial<ContainerMovementDTO>),
    );
    // A vehicle number is what earns the row M3's gate-queue forecast.
    expect(road.Vehicle_No).toBe('MH04AB1234');
    expect(road.Truck_In_Time).toBe('2026-08-02T06:30:00Z');
    expect(toRequestRow(move('X')).Truck_In_Time).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectPage — the focal container always travels
// ---------------------------------------------------------------------------

describe('selectPage', () => {
  it('puts the focal container first so the panel can always answer', () => {
    const moves = [move('A'), move('B'), move('C')];
    expect(selectPage(moves, 'C').map((m) => m.container.containerNo)).toEqual(['C', 'A', 'B']);
  });

  it('keeps the focal container even when the page overflows the cap', () => {
    const moves = Array.from({ length: MAX_BATCH + 20 }, (_, i) => move(`C${i}`));
    const sent = selectPage(moves, `C${MAX_BATCH + 10}`);
    expect(sent).toHaveLength(MAX_BATCH);
    expect(sent[0].container.containerNo).toBe(`C${MAX_BATCH + 10}`);
  });

  it('is stable, so the same page always builds the same request', () => {
    const moves = [move('A'), move('B'), move('C')];
    expect(selectPage(moves, 'B')).toEqual(selectPage(moves, 'B'));
  });

  it('returns nothing for a non-positive cap rather than the whole feed', () => {
    expect(selectPage([move('A')], 'A', 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// estimatedLabel — Gotcha 5, count words carefully
// ---------------------------------------------------------------------------

describe('estimatedLabel', () => {
  /**
   * GOTCHA 5 — "5 of 8" beside a suite of seven models reads as *five of the
   * seven models were estimated*. These are model INPUTS, and the count varies
   * per container because the ledger only records inputs it had to resolve. So
   * the label must be a bare count and must NEVER contain a fraction.
   *
   * FAILS WITHOUT THE FIX: return `${n} of ${total} inputs estimated`.
   */
  it('never renders a fraction that could be read as a model count', () => {
    for (const n of [1, 2, 5, 8, 12]) {
      const label = estimatedLabel(n);
      expect(label).toBe(`${n} estimated`);
      expect(label).not.toMatch(/\bof\b/);
      expect(label).not.toMatch(/\//);
      expect(label).not.toMatch(/model/i);
    }
  });

  it('says so plainly when nothing was estimated', () => {
    expect(estimatedLabel(0)).toBe('all inputs observed');
    expect(estimatedLabel(-1)).toBe('all inputs observed');
  });
});

// ---------------------------------------------------------------------------
// client — Gotcha 2, a dead backend behind a dev proxy
// ---------------------------------------------------------------------------

describe('ml client URL building', () => {
  it('builds a relative URL so the browser stays same-origin', () => {
    expect(mlUrl('/uc2/webapp/predictions', '/ml-api')).toBe('/ml-api/uc2/webapp/predictions');
  });

  it('does not double the prefix when a caller passes the full path', () => {
    expect(mlUrl('/ml-api/uc2/webapp/predictions', '/ml-api')).toBe('/ml-api/uc2/webapp/predictions');
  });
});

describe('ml error classification', () => {
  /**
   * GOTCHA 2 — this is the one that shipped broken in UC-1.
   *
   * With the model service stopped, Vite's dev proxy answers 500 with an EMPTY
   * text/plain body (nginx does the same with 502), so `fetch` RESOLVES and the
   * network-error branch never runs. Classified by status alone the message
   * reads as a generic 5xx and the panel blames a backend that was not
   * involved. The discriminator is the BODY: FastAPI always answers JSON, so a
   * 5xx with no JSON body did not come from the model service.
   *
   * FAILS WITHOUT THE FIX: `return status >= 500` (ignoring the body) makes the
   * "real 500 from FastAPI" case below go red.
   */
  it('treats a 5xx with no JSON body as the proxy failing, not the service', () => {
    expect(looksLikeProxyFailure(500, undefined)).toBe(true);
    expect(looksLikeProxyFailure(502, null)).toBe(true);
  });

  it('treats a 5xx that DID carry a JSON body as the service answering', () => {
    // FastAPI crashed on this request. "Read the traceback", not "start it".
    expect(looksLikeProxyFailure(500, { detail: 'ValueError: bad row' })).toBe(false);
    expect(looksLikeProxyFailure(500, 'internal error')).toBe(false);
  });

  it('never mistakes a 4xx for a dead service', () => {
    expect(looksLikeProxyFailure(422, undefined)).toBe(false);
    expect(looksLikeProxyFailure(404, null)).toBe(false);
  });

  /**
   * The message must name THE MODEL SERVICE and the command that starts it.
   * "If it blames the gateway, Gotcha 2 is not fixed."
   */
  it('names the model service and how to start it', () => {
    const message = unreachableMessage('/uc2/webapp/predictions');
    expect(message).toContain(ML_PREFIX);
    expect(message).toContain(ML_UNREACHABLE);
    expect(message).toMatch(/UC-II model service/);
    expect(message).toMatch(/run\.py serve-uc2/);
    expect(message).toMatch(/8200/);
    // The systems it must NOT blame.
    expect(message).not.toMatch(/gateway/i);
    expect(message).not.toMatch(/POC-?3/i);
  });

  it('marks every failure with the ML prefix so the panel can key on it', () => {
    expect(httpErrorMessage('/p', 422, 'Unprocessable', { detail: 'x' })).toContain(ML_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// formatValue — Gotcha 8, empty string is not a blank cell
// ---------------------------------------------------------------------------

describe('formatValue', () => {
  /**
   * GOTCHA 8 — a raw empty string leaves a gap that reads as broken UI rather
   * than as an absent value. UC-1 found this by rendering a real payload, not
   * by unit test, which is why it is pinned here.
   *
   * FAILS WITHOUT THE FIX: `if (typeof value === 'string') return value;`
   */
  it('renders an empty or whitespace string as an em dash', () => {
    expect(formatValue('')).toBe('—');
    expect(formatValue('   ')).toBe('—');
  });

  it('distinguishes "no value" from zero', () => {
    expect(formatValue(null)).toBe('—');
    expect(formatValue(0)).toBe('0');
  });

  it('keeps at most two decimals and does not re-round integers', () => {
    expect(formatValue(102.16234)).toBe('102.16');
    expect(formatValue(47)).toBe('47');
  });

  it('renders non-finite numbers as absent rather than as Infinity', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatValue(Number.NaN)).toBe('—');
  });

  it('renders empty collections as absent, not as an empty line', () => {
    expect(formatValue([])).toBe('—');
    expect(formatValue({})).toBe('—');
  });

  it('flattens arrays and objects readably', () => {
    expect(formatValue(['R1', 'R4'])).toBe('R1, R4');
    expect(formatValue({ servedRmse: 1.5 })).toBe('Served rmse: 1.5');
  });
});

// ---------------------------------------------------------------------------
// modelViews — ordering, tone, and the unknown-model rule
// ---------------------------------------------------------------------------

describe('statusTone', () => {
  it('treats a recommended deferral or throttle as a warning, not as good news', () => {
    // These are the only booleans that reach a status chip, and `true` means
    // the gate cannot cope. A naive true→good mapping would paint it green.
    expect(statusTone(true)).toBe('warn');
    expect(statusTone(false)).toBe('good');
  });

  it('carries the domain meaning of the verdict words', () => {
    expect(statusTone('OK')).toBe('good');
    expect(statusTone('THROTTLE')).toBe('warn');
    expect(statusTone('CRIT')).toBe('bad');
  });

  it('is neutral about a word it does not know, never optimistic', () => {
    expect(statusTone('hist_gradient_boosting')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });
});

describe('orderedBlocks', () => {
  it('orders the known models to spec and skips ones that did not run', () => {
    const ordered = orderedBlocks({ 'UC2-M4': { a: 1 }, 'UC2-M1': { b: 2 } });
    expect(ordered.map((o) => o.view.id)).toEqual(['UC2-M1', 'UC2-M4']);
  });

  /**
   * A model block the frontend has never heard of must still RENDER. Dropping
   * it would hide exactly the thing worth looking at, and the whole point of
   * the open document shape is that a new model needs no frontend change.
   *
   * FAILS WITHOUT THE FIX: drop the `extra` branch in orderedBlocks.
   */
  it('renders an unknown model rather than dropping it', () => {
    const ordered = orderedBlocks({ 'UC2-M1': { a: 1 }, 'UC2-M9': { c: 3 } });
    expect(ordered.map((o) => o.view.id)).toEqual(['UC2-M1', 'UC2-M9']);
    expect(ordered[1].view.title).toBeTruthy();
  });
});

/**
 * GOTCHA 6 — facility-level models are not per-container models.
 *
 * M6 describes the gate and M7 the yard. If either loses its facilityLevel
 * mark, the drawer stops rendering the scope line and an operator can read
 * "worst wait 14 min" as a fact about the box they opened.
 *
 * FAILS WITHOUT THE FIX: delete `facilityLevel: true` from either view.
 */
describe('facility-level models are marked as such', () => {
  it('marks M6 and M7, and only those', () => {
    const facility = MODEL_VIEWS.filter((v) => v.facilityLevel).map((v) => v.id);
    expect(facility).toEqual(['UC2-M6', 'UC2-M7']);
  });

  it('keeps facility_scope out of the generic grid so the card renders it itself', () => {
    const view = viewFor('UC2-M6');
    const fields = gridFields({ facility_scope: 'describes the gate', status: 'OK' }, view);
    expect(fields.map(([k]) => k)).not.toContain('facility_scope');
  });
});

describe('gridFields', () => {
  it('does not repeat the headline, the status or the raw headline string', () => {
    const view = viewFor('UC2-M1');
    const block = { headline: '47.4 h dwell', dwellHours: 47.4, engine: 'hgb', windowHours: [41, 53] };
    expect(gridFields(block, view).map(([k]) => k)).toEqual(['windowHours']);
  });
});

describe('humaniseKey', () => {
  it('makes camelCase and snake_case readable', () => {
    expect(humaniseKey('dwellHours')).toBe('Dwell hours');
    expect(humaniseKey('facility_scope')).toBe('Facility scope');
  });
});

// ---------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------

describe('response helpers', () => {
  const res = {
    dashboard: {
      containers: [{ container: 'A' }, { container: 'B' }],
      run: { models_failed: [{ model: 'UC2-M7', error: 'no inventory' }] },
    },
  } as unknown as PredictionResponse;

  it('indexes containers so a row finds its own box', () => {
    expect(indexByContainer(res).get('B')?.container).toBe('B');
    expect(indexByContainer(res).has('Z')).toBe(false);
  });

  it('reports a failed model rather than quietly showing fewer cards', () => {
    expect(failedModels(res)).toEqual(['UC2-M7 — no inventory']);
  });
});
