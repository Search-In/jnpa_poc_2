"""AI model tests (prompt §7) — assert each model's metric meets its bid §8.4.2
threshold, that /predict returns sane output, and that the anomaly rules fire.
Models train on import (synthetic, seeded) so tests are self-contained.
"""
import importlib.util
import os
import sys

import pytest

AI_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AI_DIR)


def _load(model_subdir: str):
    path = os.path.join(AI_DIR, model_subdir, "model.py")
    spec = importlib.util.spec_from_file_location(f"{model_subdir.replace('-', '_')}_model", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


REGRESSORS = ["dwell-predictor", "gate-queue-forecaster", "rake-tat-forecaster"]


@pytest.mark.parametrize("subdir", REGRESSORS)
def test_regressor_meets_threshold(subdir):
    mod = _load(subdir)
    r = mod._report
    assert r.passed, f"{r.model} {r.metric}={r.value} exceeds threshold {r.threshold}"
    assert r.value >= 0
    # metrics.json was written
    assert os.path.exists(os.path.join(AI_DIR, subdir, "metrics.json"))


@pytest.mark.parametrize("subdir", REGRESSORS)
def test_regressor_predict(subdir):
    mod = _load(subdir)
    # one feature vector of the right width
    width = len(mod.FEATURES)
    preds = mod._predict([[1.0] * width])
    assert len(preds) == 1
    assert isinstance(preds[0], float)


def test_anomaly_detector_threshold_and_rules():
    mod = _load("event-anomaly-detector")
    assert mod.report.passed
    # GATE_IN long ago with no GATE_OUT → CRIT
    trail = [{"eventType": "GATE_IN", "ts": "2026-06-10T00:00:00+00:00"}]
    findings = mod.service_detect(trail, "2026-06-17T00:00:00+00:00")
    assert any(f["type"] == "ANOMALY_MISSING_GATE_OUT" and f["severity"] == "CRIT" for f in findings)
    # GATE_IN with a timely GATE_OUT → no missing-gate-out finding
    ok_trail = [
        {"eventType": "GATE_IN", "ts": "2026-06-16T00:00:00+00:00"},
        {"eventType": "GATE_OUT", "ts": "2026-06-16T03:00:00+00:00"},
    ]
    assert not any(f["type"] == "ANOMALY_MISSING_GATE_OUT" for f in mod.service_detect(ok_trail, "2026-06-17T00:00:00+00:00"))


def test_dwell_postprocess_shape():
    mod = _load("dwell-predictor")
    out = mod._postprocess(20.0)
    assert "predictedDwellHours" in out and "predictedDepartureWindowH" in out
