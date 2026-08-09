/**
 * The measured numbers behind the Model Cards (ticket UC2-019).
 *
 * ⚠ THIS FILE IS DERIVED, NOT AUTHORED. Every value is transcribed from the
 * exported bundles under `models/uc2/<service>/metrics.json`, which are the
 * artefacts the submitted WS2 figures were measured on. `test/model-cards.test.ts`
 * re-reads those JSON files and fails if a single number here disagrees, so the
 * screen, the artefact and the submission cannot drift apart.
 *
 * It exists as a transcription rather than a runtime fetch for the reason the
 * panel's own docstring gives: the browser bundle must not depend on the Python
 * service tree. The test is what makes a transcription safe.
 *
 * The cards previously carried GEN-1 numbers (dwell MAE 3.47, gate RMSE 0.323)
 * while the submission carried Gen-2, and the anomaly card listed four features
 * that do not exist in the code. Both are corrected here.
 */

export interface ModelMetric {
  /** Matches the directory under models/uc2/. */
  bundle: string;
  metric: string;
  value: number;
  threshold: number;
  betterIsLower: boolean;
  nTest: number;
  /** What the headline number is measured ON — never left implicit. */
  basis: string;
  /** The features the code actually consumes. */
  features: string[];
  /**
   * A second, weaker measurement that must travel with the headline.
   *
   * Publishing only the number that passes is how a model card stops being
   * evidence. Where a bundle records a real-data score that loses, it is here.
   */
  alsoMeasured?: { label: string; text: string };
}

export const MODEL_METRICS: Record<string, ModelMetric> = {
  'rake-tat': {
    bundle: 'rake-tat-forecaster',
    metric: 'MAE (h)',
    value: 0.85,
    threshold: 2.0,
    betterIsLower: true,
    nTest: 500,
    basis: 'Held-out synthetic slice (n=500) — FIDELITY to the deterministic handling '
      + 'model, not accuracy against an observed rake TAT. The corpus contains none.',
    features: ['siding', 'cto_idx', 'wagon_count', 'arrival_hour', 'inbound'],
    alsoMeasured: {
      label: 'Real corpus',
      text: 'Exercised but NOT scored — the corpus records no rake placement, removal or '
        + 'departure time, so there is no label to score against.',
    },
  },
  'gate-queue': {
    bundle: 'gate-queue-forecaster',
    metric: 'RMSE (vehicles)',
    value: 0.9087,
    threshold: 3.5,
    betterIsLower: true,
    nTest: 611,
    basis: 'Rolling-origin held-out over 5 chronological folds (n=611), derived from the '
      + '1,929 real CODECO gate movements.',
    features: ['queue_lag1', 'queue_lag2', 'hour_sin', 'hour_cos', 'uc3_truck_inflow'],
  },
  dwell: {
    bundle: 'dwell-predictor',
    metric: 'MAE (h)',
    value: 3.6908,
    threshold: 8.0,
    betterIsLower: true,
    nTest: 800,
    basis: 'Held-out synthetic test set (n=800), generator anchored to the measured '
      + 'CFS-CODECO dwell distribution (median 49.2 h).',
    features: ['stream_idx', 'line_idx', 'arrival_cadence_h', 'customs_flag', 'reefer', 'facility_load'],
    alsoMeasured: {
      label: 'Real corpus',
      text: 'MAE 21.36 h on 254 real CFS-CODECO stays, against a 15.74 h median baseline — '
        + 'the bundle records "model does NOT beat the median baseline". Published because '
        + 'the corpus shares no container numbers, so stream, customs hold and reefer status '
        + 'cannot be joined to any real label and are marginalised out.',
    },
  },
  anomaly: {
    bundle: 'event-anomaly-detector',
    metric: 'precision',
    value: 1.0,
    threshold: 0.85,
    betterIsLower: false,
    nTest: 400,
    basis: 'Labelled synthetic trails (n=400) — measured on rule 1 '
      + '(ANOMALY_MISSING_GATE_OUT) only; the other two rules are not exercised by the set.',
    // The card used to list queue_zscore, txn_time_delta, flag_rate and time_of_day.
    // None exist: the engine consumes the ordered event trail and nothing else.
    features: ['trail_json'],
    alsoMeasured: {
      label: 'Coverage',
      text: '1 of 3 rules evaluated. ANOMALY_LEO_NO_MOVE and ANOMALY_SCAN_FLAG_NO_SCAN are '
        + 'unevaluated, and the negative case cannot produce a false positive by construction.',
    },
  },
};
