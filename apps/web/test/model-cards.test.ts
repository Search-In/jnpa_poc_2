/**
 * UC2-019 — the number on the screen must equal the number in the artefact.
 *
 * The cards were hardcoded with Gen-1 figures while the submitted WS2 tables
 * carried Gen-2 (dwell 3.47 vs 3.69, gate 0.323 vs 0.909), and the anomaly card
 * listed four features that exist nowhere in the code. A card that contradicts
 * the submission on stage destroys the methodology-honesty argument that the
 * rest of this work rests on.
 *
 * So these tests do not check the transcription against a copy of itself: they
 * re-read `models/uc2/<bundle>/metrics.json` — the exported artefacts — and
 * assert the UI's numbers match. Re-export a bundle with different numbers and
 * this suite fails until the card is updated with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL_METRICS } from '../src/panels/modelMetrics.js';

const bundleDir = fileURLToPath(new URL('../../../models/uc2/', import.meta.url));

function bundle(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${bundleDir}${name}/metrics.json`, 'utf-8'));
}

/** Tolerance for the rounding the cards apply when displaying. */
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

describe('model cards are transcribed from the exported bundles', () => {
  it('dwell predictor matches dwell-predictor/metrics.json', () => {
    const m = bundle('dwell-predictor') as {
      metrics: { held_out_synthetic: { n: number; mae: number }; acceptance_threshold_mae_h: number };
      corpus_validation: { metrics: { mae: number; n: number }; median_baseline_mae: number };
    };
    const card = MODEL_METRICS.dwell!;

    expect(near(card.value, m.metrics.held_out_synthetic.mae)).toBe(true);
    expect(card.nTest).toBe(m.metrics.held_out_synthetic.n);
    expect(card.threshold).toBe(m.metrics.acceptance_threshold_mae_h);
    // The real-corpus number that LOSES must travel with the headline.
    expect(card.alsoMeasured?.text).toContain(m.corpus_validation.metrics.mae.toFixed(2));
    expect(card.alsoMeasured?.text).toContain(String(m.corpus_validation.metrics.n));
  });

  it('rake TAT forecaster matches rake-tat-forecaster/metrics.json', () => {
    const m = bundle('rake-tat-forecaster') as {
      metrics: { held_out_synthetic: { n: number; mae: number }; acceptance_threshold_mae_h: number };
    };
    const card = MODEL_METRICS['rake-tat']!;

    expect(near(card.value, m.metrics.held_out_synthetic.mae)).toBe(true);
    expect(card.nTest).toBe(m.metrics.held_out_synthetic.n);
    expect(card.threshold).toBe(m.metrics.acceptance_threshold_mae_h);
    // Fidelity, not accuracy — the distinction is the whole honesty of this card.
    expect(card.basis).toMatch(/fidelity/i);
  });

  it('gate queue forecaster matches gate-queue-forecaster/metrics.json', () => {
    const m = bundle('gate-queue-forecaster') as {
      metrics: { held_out_rolling_origin: { n: number; rmse: number } };
    };
    const card = MODEL_METRICS['gate-queue']!;

    expect(near(card.value, m.metrics.held_out_rolling_origin.rmse)).toBe(true);
    expect(card.nTest).toBe(m.metrics.held_out_rolling_origin.n);
  });

  it('anomaly detector matches event-anomaly-detector/metrics.json', () => {
    const m = bundle('event-anomaly-detector') as {
      value: number; threshold: number; n_test: number;
      feature_list: string[];
      coverage: { rules_total: number; rules_evaluated: number };
    };
    const card = MODEL_METRICS.anomaly!;

    expect(card.value).toBe(m.value);
    expect(card.threshold).toBe(m.threshold);
    expect(card.nTest).toBe(m.n_test);
    // The card used to list queue_zscore / txn_time_delta / flag_rate / time_of_day.
    // The engine consumes the event trail and nothing else.
    expect(card.features).toEqual(m.feature_list);
    expect(card.alsoMeasured?.text).toContain(
      `${m.coverage.rules_evaluated} of ${m.coverage.rules_total}`);
  });
});

describe('no card claims more than it measured', () => {
  it('states what every headline number is measured on', () => {
    for (const [key, card] of Object.entries(MODEL_METRICS)) {
      expect(card.basis, `${key} has no basis`).toBeTruthy();
      expect(card.basis.length, `${key} basis is too thin to be meaningful`).toBeGreaterThan(30);
    }
  });

  it('does not describe the anomaly detector as a hybrid', () => {
    // The service string says "rule engine + IsolationForest hybrid", but the
    // forest is trained at import and never consulted. Nothing in the UI may
    // repeat that claim.
    const card = MODEL_METRICS.anomaly!;
    expect(JSON.stringify(card)).not.toMatch(/isolation ?forest|hybrid/i);
  });

  it('keeps every bundle name resolvable on disk', () => {
    for (const card of Object.values(MODEL_METRICS)) {
      expect(() => bundle(card.bundle)).not.toThrow();
    }
  });
});
