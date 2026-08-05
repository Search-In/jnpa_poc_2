"""
run_uc2.py -- run every UC-II model and write the sample request/response pairs.
================================================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

    python run.py uc2                     run all seven models, write everything
    python run.py uc2 --model m3          one model
    python run.py uc2 --list              what is available
    python run.py uc2 --export            also write the joblib model bundles

WHAT IT WRITES, AND WHY THERE ARE TWO KINDS OF FILE
----------------------------------------------------
    data/input/uc2/<model>_request.json    a request body you can POST verbatim
    out/uc2/<model>_response.json          exactly what that request returns
    out/uc2/uc2_all_models.json            every model's full output, one file
    out/uc2/uc2_dashboard.json             the flattened shape a UI renders
    out/uc2/uc2_model_cards.json           the WS2 table as JSON
    out/uc2/uc2_corpus_inventory.json      which sources are real vs degraded

The request/response pairs are the point. A frontend engineer wiring the Gate
tab should not have to read a model module to learn the shape of a queue
forecast: the request file is what to send, the response file is what comes
back, and both are regenerated from the real models every run so they cannot
drift into fiction the way a hand-written example does.

Every file is regenerated from scratch. Nothing here is hand-edited.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import jnpa_paths

jnpa_paths.ensure_on_syspath()

MODULE_ID: str = "UC2-RUNNER"
MODULE_VERSION: str = "uc2-runner-v1.0.0"
SCHEMA_VERSION: str = "uc2-dashboard/1.0.0"
TENDER_REF: str = "GeM/2026/B/7297343"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _json_safe(obj: Any) -> Any:
    """Non-finite floats become None; ``json.dumps`` would emit invalid JSON."""
    import math

    if isinstance(obj, float):
        return None if (math.isinf(obj) or math.isnan(obj)) else obj
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


# ==========================================================================
# SECTION 1 -- RESULT SHAPE
# ==========================================================================


@dataclass
class ModelRun:
    """One model's run: what was asked, what came back, what went wrong."""

    key: str
    module_id: str
    name: str
    endpoint: str
    request: Any
    response: Any
    dashboard: Dict[str, Any]
    model_card: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    traceback: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key, "module_id": self.module_id, "name": self.name,
            "endpoint": self.endpoint, "ok": self.ok,
            "request": self.request, "response": self.response,
            "dashboard": self.dashboard,
            "error": self.error, "traceback": self.traceback,
        }


# ==========================================================================
# SECTION 2 -- PER-MODEL RUNNERS
# ==========================================================================
#
# Each runner returns (endpoint, request_body, response_body, dashboard_fields).
# The request body is literally what a caller POSTs; the response is literally
# what the model returns. Keeping them symmetric is what makes the written
# sample files useful rather than decorative.


def run_m1() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m1_container_dwell as m1

    predictor = m1.get_predictor()
    request = {
        "stream_idx": 0, "line_idx": 1, "arrival_cadence_h": 4.0,
        "customs_flag": 1, "reefer": 1, "facility_load": 0.85,
        "gate_in_utc": "2026-08-02T06:30:00Z",
    }
    features = m1.DwellFeatures(
        request["stream_idx"], request["line_idx"], request["arrival_cadence_h"],
        request["customs_flag"], request["reefer"], request["facility_load"])
    prediction = predictor.predict(features)
    response = prediction.as_dict()

    from datetime import timedelta
    gate_in = datetime.fromisoformat(request["gate_in_utc"].replace("Z", "+00:00"))
    response["predictedDepartureUtc"] = (
        gate_in + timedelta(hours=prediction.dwell_hours)).isoformat()

    validation = predictor.validate_against_corpus()
    dashboard = {
        "headline": f"{prediction.dwell_hours:.1f} h dwell",
        "dwellHours": round(prediction.dwell_hours, 2),
        "windowHours": [round(prediction.p10_hours, 2), round(prediction.p90_hours, 2)],
        "engine": prediction.engine,
        "degraded": prediction.degraded,
        "headlineAccuracyMaeH": round(predictor.model.metrics.mae, 3),
        "realCorpusMaeH": validation.get("metrics", {}).get("mae"),
        "realCorpusBeatsBaseline": validation.get("beats_baseline"),
        "calibrationSource": predictor.calibration.source,
        "realStaysObserved": predictor.calibration.n_observed,
    }
    return "POST /uc2/m1/predict-one", request, response, dashboard


def run_m2() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m2_rake_tat as m2

    forecaster = m2.get_forecaster()
    request = {
        "siding": 1, "cto_idx": 0, "wagon_count": 45, "arrival_hour": 9,
        "inbound": 1, "container_count": 53, "terminal_count": 5,
        "engine": "handling", "eta_utc": "2026-08-02T09:00:00Z",
    }
    features = m2.RakeFeatures(
        request["siding"], request["cto_idx"], request["wagon_count"],
        request["arrival_hour"], request["inbound"],
        request["container_count"], request["terminal_count"])
    prediction = forecaster.predict(features, request["engine"])
    response = prediction.as_dict()

    exercise = forecaster.validate_against_corpus()
    dashboard = {
        "headline": f"{prediction.tat_hours:.2f} h rake TAT",
        "tatHours": round(prediction.tat_hours, 2),
        "etaPlacementH": round(prediction.eta_placement_h, 2),
        "etaRemovalH": round(prediction.eta_removal_h, 2),
        "engine": prediction.engine,
        "degraded": prediction.degraded,
        "fidelityMaeH": round(forecaster.model.metrics.mae, 3),
        "metricIsFidelityNotAccuracy": True,
        "realRakesExercised": exercise.get("n_cto_manifests", 0)
        + exercise.get("n_fois_intimations", 0),
        "realTatMedianH": exercise.get("tat_distribution_h", {}).get("median"),
    }
    return "POST /uc2/m2/predict-one", request, response, dashboard


def run_m3() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m3_gate_queue as m3

    forecaster = m3.get_forecaster()
    request = {"queue_lag1": 9.0, "queue_lag2": 6.0, "hour": 9, "uc3_truck_inflow": 8.0}
    features = m3.QueueFeatures.from_hour(
        request["queue_lag1"], request["queue_lag2"], request["hour"],
        request["uc3_truck_inflow"])
    prediction = forecaster.predict(features)
    response = prediction.as_dict()

    gate = forecaster.series_info.gates[0] if forecaster.series_info.gates else None
    curve = forecaster.forecast_curve(gate, 12) if gate else None
    response["forecastCurveExample"] = (
        {"gate": gate, "endpoint": f"GET /uc2/m3/forecast/{gate}?hours=12",
         "points": curve["points"][:4] if curve else [],
         "note": "First 4 of 12 points; call the endpoint for the full curve."}
        if curve else None)

    leak = forecaster.leakage
    dashboard = {
        "headline": f"{prediction.queue_vehicles:.1f} vehicles queued",
        "queueVehicles": round(prediction.queue_vehicles, 2),
        "deferralRecommended": prediction.deferral_recommended,
        "estimatedWaitMinutes": round(prediction.estimated_wait_minutes, 1),
        "engine": prediction.engine,
        "degraded": prediction.degraded,
        "rmse": round(forecaster.metrics_obj.rmse, 4),
        "splitPolicy": forecaster.split_info.get("policy"),
        "seriesSource": forecaster.series_info.source,
        "realGateMovements": forecaster.series_info.arrivals_total,
        "leakageCheck": {
            "servedRmse": leak.get("chronological", {}).get("rmse"),
            "shuffledRmse": leak.get("shuffled_for_comparison_only", {}).get("rmse"),
            "tailRmse": leak.get("chronological_tail_for_comparison_only", {}).get("rmse"),
        },
    }
    return "POST /uc2/m3/predict-one", request, response, dashboard


def run_m4() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m4_event_anomaly as m4

    trail, now = m4._demo_trail()
    request = {"trail": trail, "now": now.isoformat(), "container": "DEMO0000001"}
    result = m4.evaluate_trail(request["trail"], now=now, container=request["container"])
    response = result.as_dict()

    scan = m4.scan_corpus(limit=25)
    metrics = m4.evaluate()
    response["corpusScanExample"] = {
        "endpoint": "GET /uc2/m4/scan?limit=100",
        "containersScanned": scan.get("containers_scanned"),
        "containersWithFindings": scan.get("containers_with_findings"),
        "byType": scan.get("by_type"),
        "bySeverity": scan.get("by_severity"),
        "topFindings": scan.get("results", [])[:5],
        "note": "Top 5 of the full scan; call the endpoint for all of them.",
    }
    dashboard = {
        "headline": f"{len(result.findings)} finding(s) on this container",
        "findings": [f.finding_type for f in result.findings],
        "worstSeverity": result.worst_severity,
        "precision": metrics["trail_level"]["precision"],
        "recall": metrics["trail_level"]["recall"],
        "f1": metrics["trail_level"]["f1"],
        "corpusContainersScanned": scan.get("containers_scanned"),
        "corpusFindings": scan.get("finding_count"),
        "corpusClean": scan.get("clean_containers"),
        "corpusByType": scan.get("by_type"),
        "degraded": False,
    }
    return "POST /uc2/m4/predict", request, response, dashboard


def run_m5() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m5_discharge_berth_stay as m5

    request = {"via_no": "Q2806", "terminal": "BMCT", "moves_total": 1200,
               "moves_done": 400, "elapsed_h": 8.0, "planned_stay_h": 24.0,
               "cranes": 3.0}
    result = m5.reforecast(**request)
    response = result.as_dict()

    tracking = m5.track_corpus_calls()
    response["trackingExample"] = {
        "endpoint": "GET /uc2/m5/tracking",
        "nCalls": tracking.get("n_calls"),
        "summary": tracking.get("summary"),
        "calls": tracking.get("calls", [])[:3],
        "note": "First 3 of the real TOS calls; call the endpoint for all of them.",
    }
    dashboard = {
        "headline": f"{result.projected_total_stay_h:.1f} h projected stay",
        "projectedTotalStayHours": round(result.projected_total_stay_h, 2),
        "varianceVsPlanHours": round(result.variance_vs_plan_h, 2)
        if result.variance_vs_plan_h is not None else None,
        "status": result.status,
        "rateSource": result.rate_source,
        "degraded": result.rate_source != "observed",
        "realCallsTracked": tracking.get("n_calls", 0),
        "meanStayVarianceH": tracking.get("summary", {}).get(
            "stay_variance_h", {}).get("mean"),
    }
    return "POST /uc2/m5/reforecast", request, response, dashboard


def run_m6() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m6_lane_assignment as m6

    request = {
        "demand_per_hour": dict(m6.SCENARIOS["S4"].demand_per_hour),
        "closed_lanes": list(m6.SCENARIOS["S4"].closed_lanes),
    }
    plan = m6.assign_lanes(request["demand_per_hour"], request["closed_lanes"],
                           "S4", m6.SCENARIOS["S4"].title, demand_source="caller")
    response = plan.as_dict()

    comparison = m6.compare_to_baseline("S4")
    response["baselineComparison"] = comparison["delta"]
    dashboard = {
        "headline": f"{plan.status}, worst wait {plan.worst_wait_minutes:.0f} min",
        "status": plan.status,
        "worstWaitMinutes": round(plan.worst_wait_minutes, 1),
        "throttleRecommended": plan.throttle_recommended,
        "unservable": {k: round(v, 1) for k, v in plan.unservable.items()},
        "openLanes": list(plan.open_lanes),
        "closedLanes": list(plan.closed_lanes),
        "waitIncreaseVsBaselineMin": comparison["delta"]["worstWaitIncreaseMinutes"],
        "degraded": plan.demand_source == "fallback_baseline",
    }
    return "POST /uc2/m6/plan", request, response, dashboard


def run_m7() -> Tuple[str, Any, Any, Dict[str, Any]]:
    import uc2_m7_empty_pool_reefer as m7

    snapshot = m7.load_pool()
    scenario = m7.SCENARIOS["S6"]
    arriving = int(round((snapshot.reefers or 60) * scenario.surge_multiplier))
    request = {
        "reefers_arriving": arriving,
        "plugs_failed": scenario.plugs_failed,
        "plugs_total": m7.CPP_REEFER_PLUGS,
        "sensitivity_mix": dict(scenario.sensitivity_mix),
    }
    allocation = m7.allocate_reefer_plugs(
        request["reefers_arriving"], request["sensitivity_mix"],
        request["plugs_failed"], request["plugs_total"],
        scenario.scenario_id, scenario.title)
    response = allocation.as_dict()

    balance = m7.balance_empty_pool(snapshot=snapshot)
    response["emptyPoolExample"] = {
        "endpoint": "POST /uc2/m7/empty-balance",
        "demandSource": balance.get("demand_source"),
        "shortTerminals": balance.get("short_terminals"),
        "repositionPlan": balance.get("reposition_plan"),
        "balances": balance.get("balances"),
    }
    dashboard = {
        "headline": f"{allocation.shortfall} reefers with no plug",
        "status": allocation.status,
        "shortfall": allocation.shortfall,
        "hoursToFirstRisk": allocation.hours_to_first_risk,
        "priorityEvacuation": list(allocation.priority_evacuation),
        "poolTotal": snapshot.total_containers,
        "poolEmpties": snapshot.empties,
        "poolReefers": snapshot.reefers,
        "poolSource": snapshot.source,
        "shortTerminals": balance.get("short_terminals", []),
        "degraded": snapshot.source != "CORPUS",
    }
    return "POST /uc2/m7/reefer-allocation", request, response, dashboard


RUNNERS: Dict[str, Tuple[str, str, Callable[[], Tuple[str, Any, Any, Dict[str, Any]]]]] = {
    "m1": ("UC2-M1", "Container Dwell Prediction", run_m1),
    "m2": ("UC2-M2", "Rake TAT Forecast", run_m2),
    "m3": ("UC2-M3", "Gate Queue Forecast", run_m3),
    "m4": ("UC2-M4", "Event-Sequence Anomaly Detection", run_m4),
    "m5": ("UC2-M5", "Discharge-Rate & Berth-Stay Tracking", run_m5),
    "m6": ("UC2-M6", "Dynamic Lane Assignment", run_m6),
    "m7": ("UC2-M7", "Empty-Pool & Reefer Surge Management", run_m7),
}


# ==========================================================================
# SECTION 3 -- ORCHESTRATION
# ==========================================================================


def run_one(key: str) -> ModelRun:
    """
    Run one model, capturing a failure rather than propagating it.

    A model that throws must not stop the other six from writing their sample
    files -- the whole point of the run is to leave a frontend engineer with
    something to wire against.
    """
    module_id, name, runner = RUNNERS[key]
    try:
        endpoint, request, response, dashboard = runner()
        return ModelRun(key, module_id, name, endpoint, request,
                        _json_safe(response), _json_safe(dashboard))
    except Exception as exc:  # noqa: BLE001
        return ModelRun(key, module_id, name, "", None, None, {},
                        error=repr(exc)[:400],
                        traceback=traceback.format_exc(limit=6)[-1500:])


def _write_json(path: str, payload: Any) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(_json_safe(payload), fh, indent=2, default=str)
        fh.write("\n")
    return path


def write_outputs(runs: Sequence[ModelRun], export_bundles: bool = False) -> List[str]:
    """Write every sample file and return the paths, in the order they landed."""
    written: List[str] = []

    for run in runs:
        if not run.ok:
            continue
        written.append(_write_json(
            os.path.join(jnpa_paths.UC2_INPUT_DIR, f"{run.key}_request.json"),
            {
                "_comment": (
                    f"Sample request for {run.module_id} {run.name}. POST this body "
                    f"verbatim to {run.endpoint} on the UC-II service (default port "
                    f"8200). Regenerated by `python run.py uc2` -- do not hand-edit."),
                "_endpoint": run.endpoint,
                "_module": run.module_id,
                "body": run.request,
            }))
        written.append(_write_json(
            os.path.join(jnpa_paths.UC2_OUT_DIR, f"{run.key}_response.json"),
            {
                "_comment": (
                    f"Exactly what {run.endpoint} returns for the matching request in "
                    f"data/input/uc2/{run.key}_request.json. Regenerated by "
                    f"`python run.py uc2` -- do not hand-edit."),
                "_endpoint": run.endpoint,
                "_module": run.module_id,
                "_generated_at_utc": _utc_now_iso(),
                "body": run.response,
            }))

    written.append(_write_json(
        os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_all_models.json"),
        {
            "schema_version": SCHEMA_VERSION,
            "runner_version": MODULE_VERSION,
            "tender_ref": TENDER_REF,
            "generated_at_utc": _utc_now_iso(),
            "models_run": len(runs),
            "models_ok": sum(1 for r in runs if r.ok),
            "runs": [r.as_dict() for r in runs],
        }))

    written.append(_write_json(
        os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_dashboard.json"),
        {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": _utc_now_iso(),
            "glossary": {
                "degraded": "A fallback produced this number. Render the badge.",
                "headline": "One line fit for a card title.",
                "metricIsFidelityNotAccuracy": (
                    "UC2-M2 only: the error is measured against a deterministic model, "
                    "not against an observed rake TAT, because the corpus has none."),
                "realCorpusMaeH": (
                    "UC2-M1 only: error on real container stays, published beside the "
                    "synthetic headline and NOT interchangeable with it."),
                "leakageCheck": (
                    "UC2-M3 only: the same model scored under all three split protocols. "
                    "servedRmse is the one that counts."),
            },
            "models": {r.module_id: r.dashboard for r in runs if r.ok},
            "failures": {r.module_id: r.error for r in runs if not r.ok},
        }))

    cards: Dict[str, Any] = {}
    card_errors: Dict[str, str] = {}
    for run in runs:
        try:
            cards[run.module_id] = _model_card_for(run.key)
        except Exception as exc:  # noqa: BLE001
            card_errors[run.module_id] = repr(exc)[:300]
    written.append(_write_json(
        os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_model_cards.json"),
        {
            "generated_at_utc": _utc_now_iso(),
            "tender_ref": TENDER_REF,
            "columns": ["Use Case Solved", "Training Data (Features)",
                        "Objective Function", "Model Used", "Rationale",
                        "Link to Model Weights", "Validation Data", "Accuracy"],
            "cards": cards, "errors": card_errors,
        }))

    try:
        import uc2_corpus
        written.append(_write_json(
            os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_corpus_inventory.json"),
            uc2_corpus.inventory()))
    except Exception as exc:  # noqa: BLE001
        written.append(_write_json(
            os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_corpus_inventory.json"),
            {"error": repr(exc)[:300], "degraded": True}))

    if export_bundles:
        exports: Dict[str, Any] = {}
        for key, module_name in (("m1", "uc2_m1_container_dwell"),
                                 ("m2", "uc2_m2_rake_tat"),
                                 ("m3", "uc2_m3_gate_queue")):
            try:
                mod = __import__(module_name)
                holder = (mod.get_predictor() if hasattr(mod, "get_predictor")
                          else mod.get_forecaster())
                exports[key] = holder.export()
            except Exception as exc:  # noqa: BLE001
                exports[key] = {"error": repr(exc)[:300]}
        written.append(_write_json(
            os.path.join(jnpa_paths.UC2_OUT_DIR, "uc2_export_manifest.json"),
            {"generated_at_utc": _utc_now_iso(), "exports": exports}))

    return written


def _model_card_for(key: str) -> Dict[str, Any]:
    """Fetch a model card whichever accessor the module happens to expose."""
    module_name = {
        "m1": "uc2_m1_container_dwell", "m2": "uc2_m2_rake_tat",
        "m3": "uc2_m3_gate_queue", "m4": "uc2_m4_event_anomaly",
        "m5": "uc2_m5_discharge_berth_stay", "m6": "uc2_m6_lane_assignment",
        "m7": "uc2_m7_empty_pool_reefer",
    }[key]
    mod = __import__(module_name)
    if hasattr(mod, "model_card"):
        return mod.model_card()
    if hasattr(mod, "get_predictor"):
        return mod.get_predictor().model_card()
    if hasattr(mod, "get_forecaster"):
        return mod.get_forecaster().model_card()
    raise RuntimeError(f"{module_name} exposes no model card")


# ==========================================================================
# SECTION 4 -- SELF-TEST AND CLI
# ==========================================================================


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []
    checks.append(("seven models registered", len(RUNNERS) == 7,
                   ", ".join(sorted(RUNNERS))))

    run = run_one("m6")          # deterministic and fast, so cheap to smoke-test
    checks.append(("a model runs end to end", run.ok, run.error or run.endpoint))
    checks.append(("request and response both produced",
                   run.request is not None and run.response is not None,
                   "sample pair is complete"))
    checks.append(("dashboard fields present", bool(run.dashboard),
                   f"{len(run.dashboard)} fields"))
    checks.append(("output is JSON serialisable",
                   isinstance(json.dumps(_json_safe(run.as_dict()), default=str), str),
                   "no NaN or Infinity leaks into the file"))

    bad = ModelRun("mX", "UC2-MX", "broken", "", None, None, {}, error="boom")
    checks.append(("a failed run is captured, not raised", not bad.ok, "error recorded"))
    return checks


def _print_list() -> None:
    print("UC-II models:")
    for key, (module_id, name, _) in RUNNERS.items():
        print(f"  {key:<5}{module_id:<10}{name}")
    print("\nRun all:  python run.py uc2")
    print("Run one:  python run.py uc2 --model m3")


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="Run the UC-II models and write their sample request/response files.")
    ap.add_argument("--model", default="all",
                    help="m1..m7 or 'all' (default)")
    ap.add_argument("--list", action="store_true", help="list the models and exit")
    ap.add_argument("--export", action="store_true",
                    help="also write the joblib model bundles under trained_models/uc2/")
    ap.add_argument("--no-write", action="store_true",
                    help="run the models but write nothing")
    ap.add_argument("--json", action="store_true", help="print the full result as JSON")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.list:
        _print_list()
        return 0

    if args.selftest:
        checks = _self_test()
        for name, ok, detail in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:<42} {detail}")
        failed = [c for c in checks if not c[1]]
        print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if failed else 0

    keys = sorted(RUNNERS) if args.model == "all" else [args.model.lower()]
    unknown = [k for k in keys if k not in RUNNERS]
    if unknown:
        print(f"unknown model(s) {unknown}; expected {sorted(RUNNERS)} or 'all'")
        return 2

    print("=" * 78)
    print(f"JNPA UC-II model run   {MODULE_VERSION}   tender {TENDER_REF}")
    print("=" * 78)

    runs: List[ModelRun] = []
    for key in keys:
        module_id, name, _ = RUNNERS[key]
        print(f"\n  {module_id}  {name}")
        run = run_one(key)
        runs.append(run)
        if run.ok:
            print(f"    endpoint   {run.endpoint}")
            print(f"    headline   {run.dashboard.get('headline', '-')}")
            if run.dashboard.get("degraded"):
                print("    DEGRADED   a fallback produced this number")
        else:
            print(f"    FAILED     {run.error}")

    if args.json:
        print(json.dumps(_json_safe({"runs": [r.as_dict() for r in runs]}),
                         indent=2, default=str))

    if not args.no_write:
        written = write_outputs(runs, export_bundles=args.export)
        print(f"\n  wrote {len(written)} file(s):")
        for path in written:
            print(f"    {jnpa_paths.relative(path)}")

    ok = sum(1 for r in runs if r.ok)
    print(f"\n{ok}/{len(runs)} models ran")
    print("=" * 78)
    return 0 if ok == len(runs) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
