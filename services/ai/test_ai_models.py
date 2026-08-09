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


# --- UC2-014: the exported rule set IS the anomaly detector's artefact --------
# It has no learned weights, so `models/uc2/event-anomaly-detector/rules.json`
# is what an evaluator is handed when they ask to see the model. A rule set that
# has drifted from the code is worse than no rule set: it is a confident,
# checkable, wrong statement of what the system does.

RULES_JSON = os.path.join(
    AI_DIR, "..", "..", "models", "uc2", "event-anomaly-detector", "rules.json")


def _rules_doc():
    import json
    with open(os.path.abspath(RULES_JSON), encoding="utf-8") as fh:
        return json.load(fh)


def test_exported_rules_match_the_code_thresholds():
    mod = _load("event-anomaly-detector")
    doc = _rules_doc()
    sla = doc["sla_thresholds_hours"]

    assert sla["GATE_OUT_SLA_H"] == mod.GATE_OUT_SLA_H
    assert sla["LEO_MOVE_SLA_H"] == mod.LEO_MOVE_SLA_H
    assert sla["SCAN_START_SLA_H"] == mod.SCAN_START_SLA_H


def test_exported_rules_cover_every_rule_the_engine_can_emit():
    """Every finding type the engine produces must be documented, and nothing
    may be documented that the engine cannot produce."""
    from datetime import datetime, timedelta, timezone

    mod = _load("event-anomaly-detector")
    now = datetime(2026, 6, 17, tzinfo=timezone.utc)
    old = now - timedelta(hours=200)
    # A trail that trips all three rules at once.
    trail = [
        {"eventType": "GATE_IN", "ts": old.isoformat()},
        {"eventType": "LEO", "ts": old.isoformat()},
        {"eventType": "CUSTOMS_FLAG", "ts": old.isoformat()},
    ]
    emitted = {f["type"] for f in mod.service_detect(trail, now.isoformat())}
    documented = {r["id"] for r in _rules_doc()["rules"]}

    assert emitted == documented, f"emitted={emitted} documented={documented}"


def test_exported_rules_match_severities():
    from datetime import datetime, timedelta, timezone

    mod = _load("event-anomaly-detector")
    now = datetime(2026, 6, 17, tzinfo=timezone.utc)
    old = now - timedelta(hours=200)
    trail = [
        {"eventType": "GATE_IN", "ts": old.isoformat()},
        {"eventType": "LEO", "ts": old.isoformat()},
        {"eventType": "CUSTOMS_FLAG", "ts": old.isoformat()},
    ]
    emitted = {f["type"]: f["severity"] for f in mod.service_detect(trail, now.isoformat())}
    documented = {r["id"]: r["severity"] for r in _rules_doc()["rules"]}

    assert emitted == documented


def test_precision_coverage_is_disclosed_not_generalised():
    """The published 1.0 covers ONE rule. If someone later broadens the labelled
    set, this test fails and forces the disclosure to be updated with it."""
    import json
    metrics_path = os.path.abspath(os.path.join(
        AI_DIR, "..", "..", "models", "uc2", "event-anomaly-detector", "metrics.json"))
    with open(metrics_path, encoding="utf-8") as fh:
        m = json.load(fh)

    assert m["coverage"]["rules_total"] == len(_rules_doc()["rules"])
    assert m["coverage"]["rules_evaluated"] == 1
    assert set(m["coverage"]["evaluated"]) | set(m["coverage"]["unevaluated"]) == {
        r["id"] for r in _rules_doc()["rules"]}
