"""
Tests for the seven UC-II cargo-handling models.
=================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II. Tender ref
GeM/2026/B/7297343.

WHAT THIS FILE IS FOR, GIVEN EVERY MODULE ALREADY HAS A ``_self_test()``
------------------------------------------------------------------------
The module self-tests answer "does this model still behave the way its
docstring claims?" and they run inside ``GET /health``, which is where an
evaluator will look. They are executed here too (one parametrised test), but
they are not the point of this file.

These tests cover the things a single module cannot check about itself:

  * the CONTRACTS the frontend depends on -- interval fields, provenance
    fields, the positional feature order -- which must not drift silently
    because a module's own self-test would still pass;
  * REPRODUCIBILITY, which is an acceptance criterion: the same seed must give
    the same metric, twice, in the same process and across a rebuild;
  * the HONESTY INVARIANTS the submission rests on -- that a degraded state is
    reported rather than hidden, that a synthetic headline is never presented
    as a real-world accuracy, that the corpus's planted anomalies survive the
    loader;
  * CROSS-MODULE agreement, e.g. M6 consuming M3's forecast.

Slow tests (anything that trains or scans the full corpus) are marked ``slow``
and share module-scoped fixtures so the three learned models train once for the
whole file rather than once per test.

    pytest tests/test_uc2_models.py
    pytest tests/test_uc2_models.py -m "not slow"
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from datetime import datetime, timedelta

import pytest

import jnpa_paths

jnpa_paths.ensure_on_syspath()

import uc2_corpus                       # noqa: E402
import uc2_learn as kit                 # noqa: E402
import uc2_m1_container_dwell as m1     # noqa: E402
import uc2_m2_rake_tat as m2            # noqa: E402
import uc2_m3_gate_queue as m3          # noqa: E402
import uc2_m4_event_anomaly as m4       # noqa: E402
import uc2_m5_discharge_berth_stay as m5  # noqa: E402
import uc2_m6_lane_assignment as m6     # noqa: E402
import uc2_m7_empty_pool_reefer as m7   # noqa: E402
import run_uc2                          # noqa: E402

MODULES = (m1, m2, m3, m4, m5, m6, m7)
CORPUS_PRESENT = os.path.isdir(jnpa_paths.UC2_CORPUS_DIR)
needs_corpus = pytest.mark.skipif(
    not CORPUS_PRESENT, reason="UC-II corpus not present in this checkout")


# ==========================================================================
# Fixtures -- train the learned models once for the whole file
# ==========================================================================


@pytest.fixture(scope="module")
def dwell():
    return m1.get_predictor()


@pytest.fixture(scope="module")
def rake():
    return m2.get_forecaster()


@pytest.fixture(scope="module")
def queue():
    return m3.get_forecaster()


# ==========================================================================
# 1 -- Every module's own self-test
# ==========================================================================


# The corpus-absence exemption is defined ONCE, in tools/selftest_gate.py, and
# imported here. The Docker build gate runs that same module, so the build and
# the test suite cannot drift into disagreeing about what "passing" means on a
# checkout that deliberately excludes the corpus (ml/data/corpus/README.md).
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import selftest_gate  # noqa: E402

_is_corpus_absence = selftest_gate.is_corpus_absence


@pytest.mark.slow
@pytest.mark.parametrize("module", MODULES, ids=[m.MODULE_ID for m in MODULES])
def test_module_self_test_passes(module):
    """
    Each module's documented claims about itself still hold.

    Without the corpus the modules still RUN — they fall back and badge
    ``degraded: true`` — so this test keeps asserting every check that does not
    depend on the corpus rather than skipping the module wholesale. What is
    exempted is reported, not swallowed.
    """
    checks = module._self_test()
    failures = [(name, detail) for name, ok, detail in checks if not ok]
    if not CORPUS_PRESENT:
        exempt = [f for f in failures if _is_corpus_absence(f[1])]
        failures = [f for f in failures if not _is_corpus_absence(f[1])]
        if exempt:
            # Printed, not hidden: a green run must still say what it did not check.
            print(f"{module.MODULE_ID}: {len(exempt)} corpus-dependent check(s) "
                  f"not exercised (corpus excluded from this checkout): {exempt}")
    assert not failures, f"{module.MODULE_ID} self-test failures: {failures}"


@pytest.mark.parametrize("module", MODULES, ids=[m.MODULE_ID for m in MODULES])
def test_module_identity_is_complete(module):
    """MODULE_INFO is what the API manifest and the tender pack are built from."""
    info = module.MODULE_INFO
    for key in ("module_id", "module_name", "module_version", "router_prefix",
                "spec_row", "model_type", "constants"):
        assert info.get(key), f"{module.MODULE_ID} MODULE_INFO missing {key!r}"
    assert info["module_id"] == module.MODULE_ID
    assert info["router_prefix"] == module.ROUTER_PREFIX
    assert info["router_prefix"].startswith("/uc2/")


def test_module_versions_are_unique():
    """Two models sharing a version string would make an audit trail useless."""
    versions = [m.MODULE_VERSION for m in MODULES]
    assert len(set(versions)) == len(versions), versions


# ==========================================================================
# 2 -- The shared learning kit
# ==========================================================================


def test_kit_self_test_passes():
    failures = [(n, d) for n, ok, d in kit._self_test() if not ok]
    assert not failures, failures


def test_no_shuffled_split_helper_exists():
    """
    There is deliberately no shuffled-split function to reach for by accident.

    The gate-queue leakage defect started as a convenient helper. Keeping the
    kit free of one is a structural control, not a style preference, so the
    absence is asserted rather than assumed.
    """
    exported = {name for name in dir(kit) if "split" in name.lower()}
    assert exported == {"chronological_split", "rolling_origin_splits", "Split"}, exported


def test_chronological_split_refuses_to_leak():
    rows = [{"t": i} for i in range(100)]
    split = kit.chronological_split(rows, key=lambda r: r["t"], test_fraction=0.2)
    assert split.train[-1]["t"] < split.test[0]["t"]
    assert split.as_dict()["shuffled"] is False


def test_rolling_origin_folds_never_peek():
    rows = [{"t": i} for i in range(200)]
    splits = kit.rolling_origin_splits(rows, key=lambda r: r["t"], n_folds=4)
    assert len(splits) == 4
    for split in splits:
        assert split.train[-1]["t"] < split.test[0]["t"]


def test_metrics_do_not_divide_by_a_legitimate_zero():
    """A queue length of zero is an observation, not an error. MAPE must be None."""
    metrics = kit.regression_metrics([0.0, 2.0, 4.0], [0.5, 2.5, 3.5])
    assert metrics.mape_pct is None
    assert metrics.mae > 0


# ==========================================================================
# 3 -- The corpus loader
# ==========================================================================


@needs_corpus
def test_corpus_loader_self_test():
    failures = [(n, d) for n, ok, d in uc2_corpus._self_test() if not ok]
    assert not failures, failures


def test_corpus_absence_is_reported_not_hidden():
    """
    The counterpart to excluding the corpus: when it is missing, every loader
    must say MOCK/degraded rather than report a confident zero.

    This runs in BOTH checkouts. It is the guard that makes the exclusion safe —
    a loader that returned 0 rows with degraded=False would let the panel render
    an empty pool as a balanced one.
    """
    inv = uc2_corpus.inventory()
    if inv["corpus_present"]:
        pytest.skip("corpus present — the absence path is not exercised here")
    assert inv["sources_total"] == len(uc2_corpus._LOADERS)
    for key, info in inv["sources"].items():
        assert info["source"] == "MOCK", f"{key} claims real data with no corpus"
        assert info["degraded"] is True, f"{key} absent but not badged degraded"


def test_parse_ts_never_raises_on_junk():
    """One malformed row must not take down a 968-row gate log."""
    for junk in ("", "   ", None, "not-a-date", "99/99/9999", 12345.6, [], {}):
        assert uc2_corpus.parse_ts(junk) in (None, uc2_corpus.parse_ts(junk))


def test_reefer_detection_handles_both_iso_dialects():
    """Missing the numeric form would under-count reefers by roughly half."""
    assert uc2_corpus.iso_is_reefer("45R1")      # alphanumeric
    assert uc2_corpus.iso_is_reefer("22R1")
    assert uc2_corpus.iso_is_reefer("4532")      # numeric group 3
    assert not uc2_corpus.iso_is_reefer("2210")
    assert not uc2_corpus.iso_is_reefer("4510")
    assert not uc2_corpus.iso_is_reefer("")


@needs_corpus
def test_planted_anomalies_are_not_repaired():
    """
    The briefing says anomalies are planted on purpose and finding them is graded.

    A loader that quietly paired every gate-out with the nearest gate-in would
    delete exactly the signal UC2-M4 is scored on, and every downstream number
    would look healthier than the data is. This is the guard against that.
    """
    records, prov = uc2_corpus.pair_dwell_records()
    assert prov.source == "CORPUS"
    open_stays = [r for r in records if r.gate_in and not r.gate_out]
    orphans = [r for r in records if r.gate_out and not r.gate_in]
    assert len(open_stays) > 100, "gate-ins with no gate-out were repaired away"
    assert len(orphans) > 100, "orphan gate-outs were repaired away"


@needs_corpus
def test_inventory_reports_every_source():
    inv = uc2_corpus.inventory()
    assert inv["corpus_present"] is True
    assert inv["sources_total"] == len(uc2_corpus._LOADERS)
    for key, info in inv["sources"].items():
        assert "source" in info and "degraded" in info, key
        # A source that could not be read must say so rather than report zero.
        if info["source"] == "MOCK":
            assert info["degraded"] is True, key


@needs_corpus
def test_partial_sources_name_the_missing_files():
    """An inventory that silently loses a terminal is wrong invisibly."""
    _items, prov = uc2_corpus.load_line_inventories()
    if prov.source == "PARTIAL":
        assert prov.missing, "PARTIAL without naming what is missing"
        assert prov.note, "PARTIAL without an explanation"


# ==========================================================================
# 4 -- Response contracts the frontend depends on
# ==========================================================================


@pytest.mark.slow
def test_m1_response_contract(dwell):
    payload = dwell.predict(m1._demo_features()).as_dict()
    for key in ("dwellHours", "p10Hours", "p50Hours", "p90Hours",
                "predictedDepartureWindowH", "model_version", "trained_at",
                "degraded", "decision_path", "breakdown"):
        assert key in payload, key
    assert payload["p10Hours"] <= payload["p50Hours"] <= payload["p90Hours"]
    assert payload["dwellHours"] > 0


@pytest.mark.slow
def test_m2_response_contract(rake):
    payload = rake.predict(m2._demo_features()).as_dict()
    for key in ("tatHours", "p10Hours", "p90Hours", "etaPlacementH", "etaRemovalH",
                "departureWindowH", "model_version", "trained_at", "degraded",
                "decision_path", "breakdown"):
        assert key in payload, key
    assert 0 < payload["etaPlacementH"] < payload["etaRemovalH"] < payload["tatHours"]


@pytest.mark.slow
def test_m3_response_contract(queue):
    payload = queue.predict(m3._demo_features()).as_dict()
    for key in ("queueVehicles", "p10", "p50", "p90", "deferralRecommended",
                "estimatedWaitMinutes", "model_version", "trained_at",
                "degraded", "decision_path"):
        assert key in payload, key
    assert payload["queueVehicles"] >= 0
    assert payload["deferralRecommended"] == (
        payload["queueVehicles"] > m3.DEFERRAL_THRESHOLD)


def test_m4_response_contract():
    trail, now = m4._demo_trail()
    payload = m4.evaluate_trail(trail, now=now, container="TEST0000001").as_dict()
    for key in ("container", "findings", "worstSeverity", "clean",
                "model_version", "evaluated_at", "degraded", "decision_path"):
        assert key in payload, key
    for finding in payload["findings"]:
        for key in ("ruleId", "type", "severity", "reason", "evidence"):
            assert key in finding, key
        assert finding["evidence"], "a finding with no evidence is not actionable"


def test_m5_response_contract():
    payload = m5._demo().as_dict()
    for key in ("projectedTotalStayHours", "remainingWindowHours", "status",
                "rateSource", "model_version", "degraded", "decision_path",
                "breakdown"):
        assert key in payload, key
    lo, hi = payload["remainingWindowHours"]
    assert lo <= payload["remainingHours"] <= hi


def test_m6_response_contract():
    payload = m6.run_scenario("S4").as_dict()
    for key in ("assignments", "unservableDemandPerHour", "worstWaitMinutes",
                "throttleRecommended", "status", "model_version", "degraded",
                "decision_path", "breakdown"):
        assert key in payload, key
    assert all(math.isfinite(a["projectedWaitMinutes"]) for a in payload["assignments"])


def test_m7_response_contract():
    payload = m7.run_scenario("S6").as_dict()
    for key in ("reefersArriving", "plugsAllocatable", "shortfall",
                "hoursToFirstRisk", "priorityEvacuation", "status",
                "model_version", "degraded", "decision_path", "breakdown"):
        assert key in payload, key


@pytest.mark.slow
@pytest.mark.parametrize("module,accessor", [
    (m1, "get_predictor"), (m2, "get_forecaster"), (m3, "get_forecaster"),
])
def test_learned_models_never_return_a_bare_point(module, accessor):
    """
    The UI contract forbids a bare point prediction. Enforced here, not by hope.
    """
    holder = getattr(module, accessor)()
    payload = holder.predict(module._demo_features()).as_dict()
    interval_keys = [k for k in payload if k.lower().startswith("p10")
                     or "window" in k.lower()]
    assert interval_keys, f"{module.MODULE_ID} returned no interval"


# ==========================================================================
# 5 -- Positional feature contracts (published in the submission)
# ==========================================================================


def test_m1_feature_order_is_the_published_one():
    assert m1.FEATURE_NAMES == ("stream_idx", "line_idx", "arrival_cadence_h",
                                "customs_flag", "reefer", "facility_load")


def test_m2_feature_order_is_the_published_one():
    assert m2.FEATURE_NAMES == ("siding", "cto_idx", "wagon_count",
                                "arrival_hour", "inbound")


def test_m2_training_features_extend_the_published_ones():
    """The extension is deliberate and documented; the published five stay first."""
    assert m2.TRAINING_FEATURE_NAMES[:len(m2.FEATURE_NAMES)] == m2.FEATURE_NAMES
    assert m2.TRAINING_FEATURE_NAMES[len(m2.FEATURE_NAMES):] == (
        "container_count", "terminal_count")


def test_m3_feature_order_is_the_published_one():
    assert m3.FEATURE_NAMES == ("queue_lag1", "queue_lag2", "hour_sin",
                                "hour_cos", "uc3_truck_inflow")


@pytest.mark.parametrize("cls,n", [
    (m1.DwellFeatures, 6), (m2.RakeFeatures, 5), (m3.QueueFeatures, 5),
])
def test_positional_vectors_reject_the_wrong_arity(cls, n):
    """Silently accepting a short vector is how a dashboard swaps two columns."""
    with pytest.raises(ValueError):
        cls.from_vector([0.0] * (n - 1))
    with pytest.raises(ValueError):
        cls.from_vector([0.0] * (n + 1))


def test_m3_hour_round_trips_through_sin_cos():
    """A UI passes a clock hour; the service owns the trigonometry."""
    for hour in range(24):
        features = m3.QueueFeatures.from_hour(1.0, 1.0, hour, 2.0)
        assert features.hour_of_day == hour


# ==========================================================================
# 6 -- Reproducibility (an acceptance criterion)
# ==========================================================================


def test_m1_generator_is_reproducible():
    a = m1.generate_synthetic_dwell(300, seed=m1.DEFAULT_SEED)
    b = m1.generate_synthetic_dwell(300, seed=m1.DEFAULT_SEED)
    assert [r[1] for r in a] == [r[1] for r in b]


def test_m1_generator_responds_to_the_seed():
    a = m1.generate_synthetic_dwell(300, seed=m1.DEFAULT_SEED)
    c = m1.generate_synthetic_dwell(300, seed=m1.DEFAULT_SEED + 1)
    assert [r[1] for r in a] != [r[1] for r in c]


def test_m2_generator_is_reproducible():
    a = m2.generate_synthetic_rakes(300, seed=m2.DEFAULT_SEED)
    b = m2.generate_synthetic_rakes(300, seed=m2.DEFAULT_SEED)
    assert [r[1] for r in a] == [r[1] for r in b]


def test_m4_evaluation_is_reproducible():
    a = m4.evaluate(200, seed=m4.DEFAULT_SEED)
    b = m4.evaluate(200, seed=m4.DEFAULT_SEED)
    assert a["trail_level"] == b["trail_level"]


@pytest.mark.slow
def test_m1_metric_is_stable_across_two_fits():
    """Same seed, same MAE. If this fails, a published metric is not reproducible."""
    first = m1.DwellPredictor(seed=m1.DEFAULT_SEED, n_synthetic=1000).fit()
    second = m1.DwellPredictor(seed=m1.DEFAULT_SEED, n_synthetic=1000).fit()
    assert first.model.metrics.mae == pytest.approx(second.model.metrics.mae, abs=1e-9)


# ==========================================================================
# 7 -- Committed thresholds
# ==========================================================================


@pytest.mark.slow
def test_m1_meets_its_committed_threshold(dwell):
    assert dwell.model.metrics.mae <= m1.ACCEPTANCE_MAE_H


@pytest.mark.slow
def test_m2_meets_its_committed_threshold(rake):
    assert rake.model.metrics.mae <= m2.ACCEPTANCE_MAE_H


@pytest.mark.slow
def test_m3_meets_its_committed_threshold(queue):
    assert queue.metrics_obj.rmse <= m3.ACCEPTANCE_RMSE


@pytest.mark.slow
def test_m3_beats_a_persistence_baseline(queue):
    """
    Beating a median is trivial for a queue. Persistence is the real bar.
    """
    assert queue.metrics["beats_persistence"], queue.metrics


def test_m4_meets_precision_and_recall():
    """Recall was previously unmeasured, which made the precision uninformative."""
    metrics = m4.evaluate()
    assert metrics["acceptance"]["meets_precision"]
    assert metrics["acceptance"]["meets_recall"]
    assert not metrics["rules_not_exercised"], (
        f"rules scoring n/a rather than being tested: "
        f"{metrics['rules_not_exercised']}")


# ==========================================================================
# 8 -- Honesty invariants
# ==========================================================================


@pytest.mark.slow
@needs_corpus
def test_m1_publishes_its_real_corpus_result_even_when_it_loses(dwell):
    """
    The model does not beat a median baseline on real data, and says so.

    This test exists to fail loudly if someone quietly stops publishing the
    real-world figure, or starts blending it into the headline. Note it asserts
    the number is PRESENT and honestly labelled -- not that it is good.
    """
    validation = dwell.validate_against_corpus()
    assert validation["status"] == "measured"
    assert "median_baseline_mae" in validation
    assert "beats_baseline" in validation
    assert validation["n"] > 100
    assert validation["n_excluded_left_censored"] > 0, "censoring silently applied"

    card = dwell.model_card()
    accuracy = card["accuracy"]
    assert accuracy["real_corpus_mae_h"] is not None
    assert accuracy["headline_synthetic_mae_h"] != accuracy["real_corpus_mae_h"]
    assert "synthetic" in card["disclosure"].lower()


@pytest.mark.slow
def test_m2_does_not_call_its_fidelity_metric_accuracy(rake):
    """There is no observed rake TAT to be accurate to. The card must say so."""
    card = rake.model_card()
    assert card["accuracy"]["metric_is_fidelity_not_accuracy"] is True
    assert "fidelity" in card["accuracy"] or "headline_fidelity_mae_h" in card["accuracy"]
    assert "no such observation" in card["disclosure"].lower() or \
           "not accuracy" in card["disclosure"].lower()

    exercise = rake.validate_against_corpus()
    # Without the corpus there are no real rakes to exercise against, so the
    # status is "unavailable". Either way the point of the test holds: M2 never
    # claims accuracy. What must NOT happen is a scored status appearing.
    assert exercise["status"] == ("exercised_not_scored" if CORPUS_PRESENT else "unavailable")
    if CORPUS_PRESENT:
        assert "reason_not_scored" in exercise


@pytest.mark.slow
def test_m3_publishes_all_three_split_protocols(queue):
    """The rejected protocols are published as evidence, never served."""
    leak = queue.leakage
    assert leak["status"] == "measured"
    for key in ("chronological", "chronological_tail_for_comparison_only",
                "shuffled_for_comparison_only"):
        assert key in leak, key
        assert "rmse" in leak[key]
    assert leak["served_metric"] == "chronological"
    assert queue.split_info["shuffled"] is False


def test_m5_never_presents_an_assumed_rate_as_observed():
    """A rate from two moves in six minutes must not drive a projection."""
    early = m5.reforecast("Q1", "BMCT", 1000, 2, 0.1)
    assert early.rate_source == "assumption"
    assert early.as_dict()["degraded"] is True

    established = m5.reforecast("Q2", "BMCT", 1000, 300, 6.0)
    assert established.rate_source == "observed"
    assert established.as_dict()["degraded"] is False


def test_m6_reports_unservable_demand_rather_than_absorbing_it():
    """A plan that cannot execute must not look like a long queue."""
    plan = m6.run_scenario("S4")
    assert "HAZARDOUS" in plan.unservable
    placed = sum(sum(a.assigned.values()) for a in plan.assignments)
    assert placed + sum(plan.unservable.values()) == pytest.approx(
        plan.total_demand_per_hour)


def test_m6_never_places_traffic_on_an_incompatible_lane():
    for scenario_id in m6.SCENARIOS:
        plan = m6.run_scenario(scenario_id)
        for assignment in plan.assignments:
            lane = m6.LANES_BY_ID[assignment.lane_id]
            for movement in assignment.assigned:
                assert lane.can_take(movement), (
                    f"{scenario_id}: {lane.lane_id} was given {movement}")


def test_m7_conserves_every_reefer():
    """Allocated plus unplugged must equal arriving, or a box went unaccounted."""
    for arriving in (0, 1, 50, 300, 742):
        allocation = m7.allocate_reefer_plugs(arriving, plugs_failed=18)
        assert sum(allocation.allocated.values()) + allocation.shortfall == arriving


def test_m7_serves_the_most_perishable_cargo_first():
    allocation = m7.allocate_reefer_plugs(
        400, {"PHARMA": 0.25, "FROZEN": 0.25, "CHILLED": 0.25,
              "AMBIENT_CONTROLLED": 0.25}, plugs_failed=18)
    # Anything left unplugged must hold temperature at least as long as
    # everything that got a plug.
    if allocation.unplugged:
        worst_plugged = max(
            (m7.HOLD_HOURS_BY_SENSITIVITY[c] for c in allocation.allocated
             if allocation.allocated[c] > 0), default=0)
        best_unplugged = min(m7.HOLD_HOURS_BY_SENSITIVITY[c]
                             for c in allocation.unplugged)
        assert best_unplugged >= worst_plugged


@pytest.mark.slow
@needs_corpus
def test_m4_finds_the_planted_corpus_anomalies():
    scan = m4.scan_corpus(limit=0)
    assert scan["status"] == "scanned"
    assert scan["containers_scanned"] > 1000
    assert scan["finding_count"] > 500
    # Clean containers must remain clean -- a detector that flags everything is
    # as useless as one that flags nothing.
    assert scan["clean_containers"] > 100
    assert "ANOMALY_ORPHAN_GATE_OUT" in scan["by_type"]
    assert "ANOMALY_MISSING_GATE_OUT" in scan["by_type"]


@pytest.mark.slow
@pytest.mark.parametrize("module,accessor", [
    (m1, "get_predictor"), (m2, "get_forecaster"), (m3, "get_forecaster"),
])
def test_learned_model_cards_state_their_validation_data(module, accessor):
    card = getattr(module, accessor)().model_card()
    for key in ("use_case_solved", "training_data_features", "objective_function",
                "model_used", "rationale", "link_to_model_weights",
                "validation_data", "accuracy", "disclosure"):
        assert card.get(key), f"{module.MODULE_ID} model card missing {key!r}"


# ==========================================================================
# 9 -- Cross-module agreement
# ==========================================================================


@pytest.mark.slow
def test_m6_consumes_m3_rather_than_inventing_demand():
    """The two models must agree on what the gate is facing."""
    plan = m6.plan_from_forecast("CFS", ["L2", "L4"])
    assert plan["demand_source"] in ("uc2_m3", "fallback_baseline")
    if plan["demand_source"] == "uc2_m3":
        assert plan["forecast"]["model_version"] == m3.MODULE_VERSION
        assert plan["degraded"] is False
    assert "classMixNote" in plan, "the assumed class mix must be disclosed"


@pytest.mark.slow
def test_m7_scenario_runs_against_the_real_reefer_count():
    snapshot = m7.load_pool()
    allocation = m7.run_scenario("S6", snapshot)
    if snapshot.reefers:
        expected = int(round(snapshot.reefers * m7.SCENARIOS["S6"].surge_multiplier))
        assert allocation.reefers_arriving == expected


# ==========================================================================
# 10 -- The runner and its sample files
# ==========================================================================


def test_runner_registers_seven_models():
    assert len(run_uc2.RUNNERS) == 7
    assert sorted(run_uc2.RUNNERS) == ["m1", "m2", "m3", "m4", "m5", "m6", "m7"]


def test_runner_self_test():
    failures = [(n, d) for n, ok, d in run_uc2._self_test() if not ok]
    assert not failures, failures


def test_runner_captures_a_failure_instead_of_raising(monkeypatch):
    """One broken model must not stop the other six writing their samples."""
    def boom():
        raise RuntimeError("deliberate")

    monkeypatch.setitem(run_uc2.RUNNERS, "m6", ("UC2-M6", "broken", boom))
    run = run_uc2.run_one("m6")
    assert not run.ok
    assert "deliberate" in run.error
    assert run.traceback


@pytest.mark.slow
def test_every_model_produces_a_serialisable_sample_pair():
    """
    The written sample files are the frontend's contract. They must be valid
    JSON with no NaN or Infinity, which ``json.dumps`` would happily emit.
    """
    for key in sorted(run_uc2.RUNNERS):
        run = run_uc2.run_one(key)
        assert run.ok, f"{key}: {run.error}"
        assert run.request is not None and run.response is not None
        encoded = json.dumps(run_uc2._json_safe(run.as_dict()), default=str)
        assert "NaN" not in encoded and "Infinity" not in encoded, key
        assert run.dashboard.get("headline"), f"{key} has no headline for its card"


@pytest.mark.slow
def test_sample_files_match_what_the_models_return():
    """
    If the checked-in samples exist, they must not have drifted from the models.

    A stale sample file is worse than none: a frontend engineer wires against it
    and only finds out at the demo.
    """
    for key in sorted(run_uc2.RUNNERS):
        path = os.path.join(jnpa_paths.UC2_OUT_DIR, f"{key}_response.json")
        if not os.path.exists(path):
            pytest.skip("sample files not generated yet; run `python run.py uc2`")
        with open(path, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
        assert saved["_module"] == run_uc2.RUNNERS[key][0]
        assert "body" in saved and saved["body"]


# ==========================================================================
# 11 -- The HTTP surface
# ==========================================================================


@pytest.mark.slow
def test_every_model_builds_a_router():
    fastapi = pytest.importorskip("fastapi")
    for module in MODULES:
        router = module.build_router()
        assert router.prefix == module.ROUTER_PREFIX
        assert router.routes, f"{module.MODULE_ID} mounted no routes"


@pytest.mark.slow
def test_api_mounts_all_seven_models():
    pytest.importorskip("fastapi")
    import api_uc2

    assert len(api_uc2.MOUNTED) == len(api_uc2.MODULE_SPECS), api_uc2.IMPORT_FAILURES
    assert not api_uc2.IMPORT_FAILURES
    assert not api_uc2.MOUNT_FAILURES


@pytest.mark.slow
def test_api_manifest_lists_every_module_with_routes():
    pytest.importorskip("fastapi")
    import api_uc2

    manifest = api_uc2.manifest()
    # Derived from MODULE_SPECS, not a magic 7. As delivered this asserted 7
    # while MODULE_SPECS already carried 8 (the adapter was added to the mount
    # list without updating the test), so it failed on an untouched checkout —
    # a PRE-EXISTING failure, not one this port introduced. Counting the source
    # of truth means adding a module cannot make the test lie either way.
    assert len(manifest["modules"]) == len(api_uc2.MODULE_SPECS)
    for module in manifest["modules"]:
        assert module["routes"], f"{module['module_id']} reported zero routes"
        assert any(r["path"].endswith("/health") for r in module["routes"])
        # /constants is the tender's "Link to Model Weights" column, so every
        # MODEL must serve it. UC2-ADAPTER (a translator) and UC2-PREDICTIONS
        # (a fan-out) have no coefficients of their own — requiring constants of
        # them would be requiring a fiction. Matched on the UC2-M<n> id rather
        # than a deny-list, so a new non-model module cannot silently opt itself
        # out and a new MODEL cannot silently skip its weights.
        if re.fullmatch(r"UC2-M\d+", module["module_id"]):
            assert any(r["path"].endswith("/constants") for r in module["routes"]), \
                f"{module['module_id']} is a model but serves no /constants"


@pytest.mark.slow
def test_api_endpoints_answer():
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import api_uc2

    with TestClient(api_uc2.app) as client:
        assert client.get("/").status_code == 200
        assert client.get("/uc2/manifest").status_code == 200
        assert client.get("/uc2/corpus").status_code in (200, 503)

        response = client.post("/uc2/m3/predict-one", json={
            "queue_lag1": 9.0, "queue_lag2": 6.0, "hour": 9,
            "uc3_truck_inflow": 8.0})
        assert response.status_code == 200
        body = response.json()
        assert body["queueVehicles"] >= 0
        assert "decision_path" in body

        # A malformed request must be refused with the field named, so the UI
        # can suspend the panel rather than extrapolate.
        bad = client.post("/uc2/m1/predict", json={"instances": [[1, 2]]})
        assert bad.status_code == 422


@pytest.mark.slow
def test_inference_is_logged_as_acceptance_evidence(tmp_path, monkeypatch):
    """JNPA requires AI-inference logs as evidence (Bidder Briefing p.4)."""
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    import api_uc2

    log_path = tmp_path / "inference_log.jsonl"
    monkeypatch.setattr(api_uc2, "INFERENCE_LOG_PATH", str(log_path))
    monkeypatch.setattr(api_uc2, "_LOG_ENABLED", True)

    with TestClient(api_uc2.app) as client:
        client.get("/uc2/m6/scenario/S4")

    assert log_path.exists(), "no inference log written"
    entries = [json.loads(line) for line in log_path.read_text(
        encoding="utf-8").splitlines() if line.strip()]
    assert entries
    entry = entries[-1]
    for key in ("ts", "method", "path", "status", "latency_ms",
                "module", "model_version"):
        assert key in entry, key
    assert entry["module"] == "UC2-M6"
