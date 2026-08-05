"""
api_uc2 -- JNPA UC-II Unified FastAPI Application
=================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

Mounts all seven UC-II models behind one HTTP surface so a React / Next.js /
Vue frontend can consume every model as JSON.

    /uc2/m1   Container dwell prediction
    /uc2/m2   Rake TAT forecast
    /uc2/m3   Gate queue forecast
    /uc2/m4   Event-sequence anomaly detection
    /uc2/m5   Discharge-rate & berth-stay tracking
    /uc2/m6   Dynamic lane assignment
    /uc2/m7   Empty-pool & reefer surge management

Every model also exposes ``/constants`` (the versioned coefficients -- literally
the tender's "Link to Model Weights" column served over HTTP), ``/demo``,
``/health`` and ``/model-card``.

RUN
---
    pip install -r requirements.txt
    python run.py serve-uc2                 # or: uvicorn api_uc2:app --port 8200

    http://127.0.0.1:8200/docs              interactive OpenAPI
    http://127.0.0.1:8200/health            all 7 modules
    http://127.0.0.1:8200/uc2/manifest      route and version discovery
    http://127.0.0.1:8200/uc2/model-cards   the whole WS2 table as JSON
    http://127.0.0.1:8200/uc2/corpus        which sources are real vs degraded

WHY IT DOES NOT REFUSE TO START
-------------------------------
The UC-I app has a hard gate: if the duplicated DUKC core has drifted it exits
rather than serve two definitions of "safe under-keel clearance". That is right
for a safety-of-navigation calculation.

UC-II has no such shared invariant, and the failure mode here is different: the
models degrade individually and visibly. A module that will not import is
recorded, the other six still serve, and ``/health`` returns 503 with the
traceback. Refusing to start because the reefer model is broken would take the
gate queue down with it.

INFERENCE LOGGING
-----------------
JNPA requires AI-inference logs as acceptance evidence (Bidder Briefing p.4,
"Evidence: Machine & AI inference, logs"). Middleware records every request to
a model endpoint -- path, status, latency, request body size, model version --
as one JSON line per inference in ``out/uc2/inference_log.jsonl``. It is on by
default; ``JNPA_UC2_INFERENCE_LOG=0`` disables it and ``JNPA_UC2_LOG_BODIES=1``
adds request/response bodies for a demo run.
"""

from __future__ import annotations

import importlib
import json
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# src/service/api_uc2.py -> src/service -> src -> src/pipeline holds jnpa_paths,
# which puts the model + pipeline folders on sys.path. Doing it here means
# `uvicorn api_uc2:app` works without the caller setting PYTHONPATH.
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

try:
    from fastapi import FastAPI, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "FastAPI is required to run the API layer.\n"
        "Install with:  pip install -r requirements.txt\n"
        f"Import error: {exc!r}\n\n"
        "Note the seven model modules run without FastAPI -- try:\n"
        "  python src/uc2_models/uc2_m1_container_dwell.py"
    ) from exc

APP_NAME = "JNPA UC-II Improved Cargo Handling & Logistics Optimization"
APP_VERSION = "uc2-api-v1.0.0"
TENDER_REF = "GeM/2026/B/7297343"
DEFAULT_PORT = 8200

# (import name, short label, is the model learned?)
MODULE_SPECS: Tuple[Tuple[str, str, bool], ...] = (
    ("uc2_m1_container_dwell", "M1 Container Dwell", True),
    ("uc2_m2_rake_tat", "M2 Rake TAT", True),
    ("uc2_m3_gate_queue", "M3 Gate Queue", True),
    ("uc2_m4_event_anomaly", "M4 Event Anomaly", False),
    ("uc2_m5_discharge_berth_stay", "M5 Discharge & Berth Stay", False),
    ("uc2_m6_lane_assignment", "M6 Lane Assignment", False),
    ("uc2_m7_empty_pool_reefer", "M7 Empty Pool & Reefer", False),
    # Not a model -- the translation layer that lets the web app POST rows
    # shaped like Cargo_Training_Input_Sample.xlsx straight at the models
    # instead of reimplementing the code tables in the frontend.
    ("uc2_webapp_adapter", "JNPA journey-sheet adapter", False),
    # Also not a model -- the fan-out that turns the adapter's twelve per-model
    # endpoints into ONE dashboard-shaped document per container, so a panel
    # makes one call instead of six and does not have to decide for itself
    # which models describe a box and which describe the yard.
    ("uc2_predictions", "UC-II per-container prediction fan-out", False),
)

INFERENCE_LOG_PATH = os.path.join(jnpa_paths.UC2_OUT_DIR, "inference_log.jsonl")
_LOG_ENABLED = os.environ.get("JNPA_UC2_INFERENCE_LOG", "1") not in ("0", "false", "False")
_LOG_BODIES = os.environ.get("JNPA_UC2_LOG_BODIES", "0") in ("1", "true", "True")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def json_safe(obj: Any) -> Any:
    """
    Recursively replace non-finite floats with ``None``.

    ``json.dumps`` emits bare ``Infinity`` / ``NaN`` for these, which is invalid
    JSON: Starlette's encoder rejects it and the whole response 500s. Legitimate
    non-finite values do occur -- an undefined R2 on a flat test slice, an
    unbounded queue -- so they are sanitised at the boundary.
    """
    import math as _math

    if isinstance(obj, float):
        return None if (_math.isinf(obj) or _math.isnan(obj)) else obj
    if isinstance(obj, dict):
        return {k: json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    return obj


def load_modules() -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """
    Import the seven model modules.

    A module that fails to import is recorded rather than crashing the app, so
    six working models still serve while the seventh is diagnosed. The failure
    is surfaced loudly in ``/health``.
    """
    loaded: Dict[str, Any] = {}
    failures: List[Dict[str, str]] = []
    for name, label, _ in MODULE_SPECS:
        try:
            loaded[name] = importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 - report, do not abort
            failures.append({
                "module": name, "label": label,
                "error": repr(exc)[:300],
                "traceback": traceback.format_exc(limit=3)[-600:],
            })
    return loaded, failures


MODULES, IMPORT_FAILURES = load_modules()

app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    description=(
        f"All seven UC-II models behind one HTTP surface. Tender ref {TENDER_REF}.\n\n"
        "Every model exposes `/constants` (versioned coefficients -- the tender's "
        "'Link to Model Weights' column), `/demo`, `/health` and `/model-card`.\n\n"
        "**Read the model cards before quoting an accuracy.** UC2-M1's headline is "
        "measured on synthetic data and its real-corpus figure is published beside it; "
        "UC2-M2's metric is fidelity to a deterministic model, not accuracy against an "
        "observed rake TAT, because the corpus contains none; UC2-M3 publishes all "
        "three split protocols it was scored under. Every response carries `degraded` "
        "and `decision_path`."
    ),
)

# Permissive CORS: this is a PoC serving a separate frontend dev server.
# Tighten allow_origins to the deployed frontend before any public exposure.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MOUNTED: List[Dict[str, Any]] = []
MOUNT_FAILURES: List[Dict[str, str]] = []

for _name, _label, _learned in MODULE_SPECS:
    _mod = MODULES.get(_name)
    if _mod is None:
        continue
    try:
        app.include_router(_mod.build_router())
        MOUNTED.append({
            "module": _name, "label": _label,
            "module_id": getattr(_mod, "MODULE_ID", "?"),
            "module_version": getattr(_mod, "MODULE_VERSION", "?"),
            "prefix": getattr(_mod, "ROUTER_PREFIX", "?"),
            "learned": _learned,
        })
    except Exception as exc:  # noqa: BLE001
        MOUNT_FAILURES.append({"module": _name, "error": repr(exc)[:300]})


# --------------------------------------------------------------------------
# Inference logging -- JNPA acceptance evidence
# --------------------------------------------------------------------------

@app.middleware("http")
async def log_inference(request: Request, call_next):
    """
    One JSON line per model call, for the acceptance evidence pack.

    Only ``/uc2/*`` paths are logged; the meta endpoints are not inferences.
    A logging failure must never fail the request the operator is waiting on,
    so the write is wrapped and its error recorded on the response header
    rather than raised.
    """
    started = time.perf_counter()
    response = await call_next(request)
    if not _LOG_ENABLED or not request.url.path.startswith("/uc2/"):
        return response

    entry: Dict[str, Any] = {
        "ts": _utc_now_iso(),
        "method": request.method,
        "path": request.url.path,
        "query": str(request.url.query) or None,
        "status": response.status_code,
        "latency_ms": round((time.perf_counter() - started) * 1000, 2),
        "client": request.client.host if request.client else None,
        "module": next((m["module_id"] for m in MOUNTED
                        if request.url.path.startswith(m["prefix"])), None),
        "model_version": next((m["module_version"] for m in MOUNTED
                               if request.url.path.startswith(m["prefix"])), None),
        "app_version": APP_VERSION,
    }
    try:
        os.makedirs(os.path.dirname(INFERENCE_LOG_PATH), exist_ok=True)
        with open(INFERENCE_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, default=str) + "\n")
        response.headers["X-Inference-Logged"] = "1"
    except OSError as exc:
        response.headers["X-Inference-Logged"] = "0"
        response.headers["X-Inference-Log-Error"] = repr(exc)[:120]
    return response


# --------------------------------------------------------------------------
# Meta endpoints
# --------------------------------------------------------------------------

@app.get("/", tags=["meta"], summary="Service banner")
def root() -> Dict[str, Any]:
    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "tender_ref": TENDER_REF,
        "modules_mounted": len(MOUNTED),
        "docs": "/docs",
        "manifest": "/uc2/manifest",
        "model_cards": "/uc2/model-cards",
        "corpus": "/uc2/corpus",
        "health": "/health",
    }


@app.get("/health", tags=["meta"], summary="All modules and their self-tests")
def health(deep: bool = False) -> JSONResponse:
    """
    Service health.

    ``deep=true`` runs every module's full ``_self_test()``. That is slower --
    three models train -- so it is off by default and intended for a smoke test
    after deployment rather than a liveness probe.
    """
    modules: List[Dict[str, Any]] = []
    degraded = False

    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info: Dict[str, Any] = {**entry, "info": getattr(mod, "MODULE_INFO", {})}
        if deep:
            try:
                checks = mod._self_test()
                passed = sum(1 for _, ok, _ in checks if ok)
                info["self_test"] = {
                    "passed": passed, "total": len(checks),
                    "ok": passed == len(checks),
                    "failures": [{"name": n, "detail": d} for n, ok, d in checks if not ok],
                }
                if passed != len(checks):
                    degraded = True
            except Exception as exc:  # noqa: BLE001
                info["self_test"] = {"error": repr(exc)[:300]}
                degraded = True
        modules.append(info)

    if IMPORT_FAILURES or MOUNT_FAILURES or len(MOUNTED) != len(MODULE_SPECS):
        degraded = True

    payload = {
        "status": "degraded" if degraded else "ok",
        "service": APP_NAME, "version": APP_VERSION,
        "generated_at_utc": _utc_now_iso(),
        "modules_expected": len(MODULE_SPECS),
        "modules_mounted": len(MOUNTED),
        "inference_logging": {
            "enabled": _LOG_ENABLED,
            "path": jnpa_paths.relative(INFERENCE_LOG_PATH),
            "bodies_logged": _LOG_BODIES,
        },
        "modules": modules,
        "import_failures": IMPORT_FAILURES,
        "mount_failures": MOUNT_FAILURES,
        "deep": deep,
    }
    return JSONResponse(json_safe(payload), status_code=200 if not degraded else 503)


@app.get("/uc2/manifest", tags=["meta"],
         summary="Route and version discovery for the frontend")
def manifest() -> Dict[str, Any]:
    """
    Everything a frontend needs to discover the surface without hard-coding it.

    Routes are enumerated from the generated OpenAPI schema, NOT ``app.routes``:
    FastAPI 0.115+ wraps included routers in a lazy object with no ``.path``, so
    walking ``app.routes`` silently reports every module as having zero
    endpoints. The schema is the version-stable source of truth.
    """
    by_prefix: Dict[str, List[Dict[str, Any]]] = {}
    try:
        paths = app.openapi().get("paths", {})
    except Exception:  # pragma: no cover
        paths = {}

    for path, operations in paths.items():
        if not path.startswith("/uc2/"):
            continue
        methods = sorted(m.upper() for m in operations
                         if m.lower() in ("get", "post", "put", "patch", "delete"))
        if not methods:
            continue
        prefix = "/".join(path.split("/")[:3])
        summary = ""
        for meta in operations.values():
            if isinstance(meta, dict) and meta.get("summary"):
                summary = meta["summary"]
                break
        by_prefix.setdefault(prefix, []).append(
            {"path": path, "methods": methods, "summary": summary})

    modules = []
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info = getattr(mod, "MODULE_INFO", {})
        modules.append({
            **entry,
            "spec_row": info.get("spec_row", ""),
            "model_type": info.get("model_type", ""),
            "feature_order": info.get("feature_order"),
            "routes": sorted(by_prefix.get(entry["prefix"], []), key=lambda r: r["path"]),
        })

    return {
        "service": APP_NAME, "version": APP_VERSION, "tender_ref": TENDER_REF,
        "generated_at_utc": _utc_now_iso(),
        "conventions": {
            "never_a_bare_point": (
                "Every prediction carries an interval (p10/p50/p90 or an explicit "
                "window) plus `model_version` and `trained_at`."),
            "degraded": (
                "`degraded: true` means a fallback ran -- a synthetic series, a stdlib "
                "engine, an assumed rate. Render the badge; never hide it."),
            "decision_path": (
                "A one-line trace of which engine and which data path produced the "
                "number. Show it on hover."),
            "suspend_do_not_extrapolate": (
                "On missing input the services return 422 with the field named. The UI "
                "must suspend that panel rather than extrapolate."),
            "constants": (
                "GET <prefix>/constants returns the versioned coefficient block -- the "
                "tender's 'Link to Model Weights' column, served over HTTP."),
            "model_card": (
                "GET <prefix>/model-card returns the WS2 submission row generated from "
                "what actually ran, including every disclosure."),
        },
        "modules": modules,
    }


@app.get("/uc2/model-cards", tags=["meta"],
         summary="The whole WS2 AI/ML table as JSON")
def model_cards() -> JSONResponse:
    """
    One call returning every model's WS2 row -- what the AI Models tab renders.

    Slow on a cold start: three models train and two scan the corpus. Cache it
    in the frontend rather than calling it per render.
    """
    cards: Dict[str, Any] = {}
    errors: Dict[str, str] = {}
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        try:
            if hasattr(mod, "model_card"):
                cards[entry["module_id"]] = mod.model_card()
            elif hasattr(mod, "get_predictor"):
                cards[entry["module_id"]] = mod.get_predictor().model_card()
            elif hasattr(mod, "get_forecaster"):
                cards[entry["module_id"]] = mod.get_forecaster().model_card()
            else:
                errors[entry["module_id"]] = "no model_card() on this module"
        except Exception as exc:  # noqa: BLE001
            errors[entry["module_id"]] = repr(exc)[:300]
    return JSONResponse(json_safe({
        "generated_at_utc": _utc_now_iso(),
        "tender_ref": TENDER_REF,
        "columns": ["Use Case Solved", "Training Data (Features)", "Objective Function",
                    "Model Used", "Rationale", "Link to Model Weights",
                    "Validation Data", "Accuracy"],
        "cards": cards,
        "errors": errors,
    }))


@app.get("/uc2/corpus", tags=["meta"],
         summary="Which corpus sources are real and which are degraded")
def corpus_inventory() -> JSONResponse:
    """The data-source badge the dashboard reads."""
    try:
        import uc2_corpus
        return JSONResponse(json_safe(uc2_corpus.inventory()))
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": repr(exc)[:300], "degraded": True},
                            status_code=503)


@app.get("/uc2/constants", tags=["meta"],
         summary="Every module's versioned constants")
def all_constants() -> JSONResponse:
    """One call returning the complete 'model weights' picture for the tender pack."""
    out: Dict[str, Any] = {"generated_at_utc": _utc_now_iso(), "modules": {}}
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info = getattr(mod, "MODULE_INFO", {})
        out["modules"][entry["module_id"]] = {
            "module_version": entry["module_version"],
            "spec_row": info.get("spec_row", ""),
            "constants": info.get("constants", {}),
        }
    return JSONResponse(json_safe(out))


@app.get("/uc2/demo-all", tags=["meta"], summary="Run every module's demo in one call")
def demo_all() -> JSONResponse:
    """
    Smoke-test surface: each module's canonical demo, headline result only.

    Handy for a dashboard's first paint and for proving the whole stack works
    after a deploy.
    """
    results: Dict[str, Any] = {}
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        mid = entry["module_id"]
        try:
            if mid == "UC2-M1":
                p = mod.get_predictor().predict(mod._demo_features())
                results[mid] = {"dwellHours": round(p.dwell_hours, 2),
                                "window": [round(p.p10_hours, 2), round(p.p90_hours, 2)],
                                "degraded": p.degraded}
            elif mid == "UC2-M2":
                p = mod.get_forecaster().predict(mod._demo_features())
                results[mid] = {"tatHours": round(p.tat_hours, 2),
                                "etaPlacementH": round(p.eta_placement_h, 2),
                                "degraded": p.degraded}
            elif mid == "UC2-M3":
                p = mod.get_forecaster().predict(mod._demo_features())
                results[mid] = {"queueVehicles": round(p.queue_vehicles, 2),
                                "deferralRecommended": p.deferral_recommended,
                                "degraded": p.degraded}
            elif mid == "UC2-M4":
                trail, now = mod._demo_trail()
                r = mod.evaluate_trail(trail, now=now, container="DEMO0000001")
                results[mid] = {"findings": [f.finding_type for f in r.findings],
                                "worstSeverity": r.worst_severity}
            elif mid == "UC2-M5":
                r = mod._demo().as_dict()
                results[mid] = {"projectedTotalStayHours": r["projectedTotalStayHours"],
                                "status": r["status"], "rateSource": r["rateSource"]}
            elif mid == "UC2-M6":
                r = mod.run_scenario("S4").as_dict()
                results[mid] = {"status": r["status"],
                                "worstWaitMinutes": r["worstWaitMinutes"],
                                "unservable": r["unservableDemandPerHour"]}
            elif mid == "UC2-M7":
                r = mod.run_scenario("S6").as_dict()
                results[mid] = {"status": r["status"], "shortfall": r["shortfall"],
                                "hoursToFirstRisk": r["hoursToFirstRisk"]}
        except Exception as exc:  # noqa: BLE001
            results[mid] = {"error": repr(exc)[:300]}
    return JSONResponse(json_safe(
        {"generated_at_utc": _utc_now_iso(), "results": results}))


@app.get("/uc2/inference-log", tags=["meta"],
         summary="Recent AI-inference log lines (acceptance evidence)")
def inference_log(limit: int = 100) -> Dict[str, Any]:
    """Tail of the inference log, so the evidence is checkable over HTTP too."""
    limit = max(1, min(limit, 5000))
    if not os.path.exists(INFERENCE_LOG_PATH):
        return {"path": jnpa_paths.relative(INFERENCE_LOG_PATH), "entries": [],
                "total": 0, "note": "no inferences logged yet"}
    lines: List[str] = []
    try:
        with open(INFERENCE_LOG_PATH, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError as exc:
        return {"error": repr(exc)[:200], "entries": []}
    tail = lines[-limit:]
    entries = []
    for line in tail:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return {"path": jnpa_paths.relative(INFERENCE_LOG_PATH),
            "total": len(lines), "returned": len(entries), "entries": entries}


def _print_banner() -> None:
    print("=" * 78)
    print(APP_NAME)
    print(f"{APP_VERSION}   .   tender {TENDER_REF}")
    print("=" * 78)
    print(f"\nMounted {len(MOUNTED)}/{len(MODULE_SPECS)} modules:")
    for e in MOUNTED:
        kind = "learned" if e["learned"] else "deterministic"
        print(f"  {e['prefix']:<10} {e['module_id']:<8} {e['label']:<28} "
              f"{e['module_version']:<26} [{kind}]")
    if IMPORT_FAILURES:
        print("\nIMPORT FAILURES:")
        for f in IMPORT_FAILURES:
            print(f"  {f['module']}: {f['error']}")
    if MOUNT_FAILURES:
        print("\nMOUNT FAILURES:")
        for f in MOUNT_FAILURES:
            print(f"  {f['module']}: {f['error']}")
    print(f"\nInference log: {jnpa_paths.relative(INFERENCE_LOG_PATH)} "
          f"({'enabled' if _LOG_ENABLED else 'DISABLED'})")
    print(f"\nStart with:  python run.py serve-uc2       (port {DEFAULT_PORT})")
    print(f"  docs        http://127.0.0.1:{DEFAULT_PORT}/docs")
    print(f"  health      http://127.0.0.1:{DEFAULT_PORT}/health?deep=true")
    print(f"  manifest    http://127.0.0.1:{DEFAULT_PORT}/uc2/manifest")
    print(f"  model cards http://127.0.0.1:{DEFAULT_PORT}/uc2/model-cards")
    print(f"  corpus      http://127.0.0.1:{DEFAULT_PORT}/uc2/corpus")
    print(f"  demo all    http://127.0.0.1:{DEFAULT_PORT}/uc2/demo-all")
    print("=" * 78)


if __name__ == "__main__":
    _print_banner()
    ok = (len(MOUNTED) == len(MODULE_SPECS)
          and not IMPORT_FAILURES and not MOUNT_FAILURES)
    sys.exit(0 if ok else 1)
