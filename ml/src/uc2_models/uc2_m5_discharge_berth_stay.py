"""
UC2-M5 -- Discharge-Rate & Berth-Stay Tracking
===============================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Is this vessel working to plan, and if not, when will she actually finish?"

Feeds the briefing's "discharge rate" AI/ML item, the actual-vs-predicted KPI
and the berth-stay figure the Yard and Rail tabs plan against.

MEASUREMENT BEFORE PREDICTION
-----------------------------
This module is deliberately deterministic, and that is a design decision rather
than a shortfall. A discharge-rate model needs move-level productivity history
-- moves per crane per hour, per vessel class, per terminal -- and the shared
corpus contains none. What it does contain is enough to MEASURE:

    TOS File 02        5 vessel calls with both the plan (ETA/ETD) and the
                       outcome (ATA/ATD). Real schedule adherence.
    dsr_berth_stays    1,113 berth-stay rows already extracted from the 54 JNPA
                       Daily Status Reports by the UC-I pipeline. Real occupancy.
    EAL / IAL          6,467 container lines carrying a vessel visit, which
                       gives a real MOVE COUNT per call.

Honest tracked actuals are what a productivity regression would later be
trained on, so measuring them properly now is the useful thing to build. The
production upgrade path is named in the model card.

THE THREE OUTPUTS
-----------------
1. SCHEDULE ADHERENCE -- arrival delay (ATA-ETA), stay variance
   (actual - planned), and departure delay, per call and pooled.

2. DISCHARGE RATE -- moves / berth-hours where a real move count exists,
   otherwise the terminal's versioned crane-productivity assumption with the
   substitution flagged. The response always says which of the two produced
   the number.

3. BERTH-STAY RE-FORECAST -- given a call in progress and its observed
   progress, when will she finish? A rate-based projection with a documented
   remaining-work formula and an interval derived from the observed spread of
   real stay variance, not from an assumed distribution.

USAGE
-----
    python uc2_m5_discharge_berth_stay.py
    python uc2_m5_discharge_berth_stay.py --json
    python uc2_m5_discharge_berth_stay.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

for _extra in (os.path.dirname(os.path.abspath(__file__)),
               os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "pipeline")):
    if _extra not in sys.path:
        sys.path.append(_extra)

# ==========================================================================
# SECTION 1 -- IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC2-M5"
MODULE_NAME: str = "Discharge-Rate & Berth-Stay Tracking"
MODULE_VERSION: str = "m5-discharge-berth-v1.0.0"
ROUTER_PREFIX: str = "/uc2/m5"

# Crane productivity assumptions, used ONLY when a real move count is absent.
# Every figure served from these is flagged `rate_source: assumption`.
TERMINAL_CRANE_PRODUCTIVITY: Dict[str, float] = {   # moves per crane-hour
    "BMCT": 28.0, "NSICT": 25.0, "NSIGT": 26.0, "NSFT": 24.0,
    "GTI": 27.0, "GTIL": 27.0, "APMT": 29.0, "DEFAULT": 26.0,
}
DEFAULT_CRANES_PER_VESSEL: float = 3.0
BERTH_STAY_OVERHEAD_H: float = 2.4    # pilot on/off, lashing, gangway, survey

# Deviation bands used to badge a call on the dashboard.
ON_PLAN_TOLERANCE_H: float = 2.0
AT_RISK_TOLERANCE_H: float = 6.0

STATUS_ON_PLAN: str = "ON_PLAN"
STATUS_AT_RISK: str = "AT_RISK"
STATUS_DELAYED: str = "DELAYED"
STATUS_AHEAD: str = "AHEAD"


# ==========================================================================
# SECTION 2 -- OPTIONAL DEPENDENCIES
# ==========================================================================

_HAS_CORPUS, _CORPUS_ERROR = False, ""
try:
    import uc2_corpus as corpus
    _HAS_CORPUS = True
except Exception as exc:  # pragma: no cover
    _CORPUS_ERROR = repr(exc)[:200]
    corpus = None  # type: ignore

_HAS_PATHS = False
try:
    import jnpa_paths
    _HAS_PATHS = True
except Exception:  # pragma: no cover
    jnpa_paths = None  # type: ignore


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ==========================================================================
# SECTION 3 -- DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class CallTracking:
    """One vessel call measured against its own plan."""

    terminal: str
    via_no: str
    vessel_name: str
    planned_stay_h: Optional[float]
    actual_stay_h: Optional[float]
    arrival_delay_h: Optional[float]
    departure_delay_h: Optional[float]
    stay_variance_h: Optional[float]
    status: str
    moves: Optional[int]
    discharge_rate_moves_per_h: Optional[float]
    rate_source: str
    source: str

    def as_dict(self) -> Dict[str, Any]:
        def r(v: Optional[float], n: int = 2) -> Optional[float]:
            return round(v, n) if v is not None else None

        return {
            "terminal": self.terminal, "viaNo": self.via_no,
            "vesselName": self.vessel_name,
            "plannedStayHours": r(self.planned_stay_h),
            "actualStayHours": r(self.actual_stay_h),
            "arrivalDelayHours": r(self.arrival_delay_h),
            "departureDelayHours": r(self.departure_delay_h),
            "stayVarianceHours": r(self.stay_variance_h),
            "status": self.status,
            "moves": self.moves,
            "dischargeRateMovesPerHour": r(self.discharge_rate_moves_per_h),
            "rateSource": self.rate_source,
            "source": self.source,
        }


@dataclass(frozen=True)
class ReforecastResult:
    """A live re-forecast of when a working vessel will actually finish."""

    via_no: str
    terminal: str
    moves_total: int
    moves_done: int
    elapsed_h: float
    observed_rate_moves_per_h: float
    remaining_moves: int
    remaining_hours: float
    projected_total_stay_h: float
    planned_stay_h: Optional[float]
    variance_vs_plan_h: Optional[float]
    p10_remaining_h: float
    p90_remaining_h: float
    status: str
    rate_source: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "viaNo": self.via_no, "terminal": self.terminal,
            "movesTotal": self.moves_total, "movesDone": self.moves_done,
            "elapsedHours": round(self.elapsed_h, 2),
            "observedRateMovesPerHour": round(self.observed_rate_moves_per_h, 2),
            "remainingMoves": self.remaining_moves,
            "remainingHours": round(self.remaining_hours, 2),
            "remainingWindowHours": [round(self.p10_remaining_h, 2),
                                     round(self.p90_remaining_h, 2)],
            "projectedTotalStayHours": round(self.projected_total_stay_h, 2),
            "plannedStayHours": round(self.planned_stay_h, 2)
            if self.planned_stay_h is not None else None,
            "varianceVsPlanHours": round(self.variance_vs_plan_h, 2)
            if self.variance_vs_plan_h is not None else None,
            "status": self.status,
            "rateSource": self.rate_source,
            "breakdown": self.breakdown,
            "model_version": MODULE_VERSION,
            "degraded": self.rate_source != "observed",
            "decision_path": (
                f"deterministic_rate_projection | rate={self.rate_source} | "
                f"interval=observed_stay_variance_spread"),
        }


# ==========================================================================
# SECTION 4 -- REAL MOVE COUNTS AND STAY VARIANCE
# ==========================================================================


def moves_by_vessel_visit() -> Tuple[Dict[str, int], Dict[str, Any]]:
    """
    Real container counts per vessel visit, from the shipping-line inventories.

    Each EAL/IAL line names the vessel visit it belongs to, so counting them
    gives a genuine move count per call -- the one productivity input the
    corpus does supply. It does not join to the TOS calls (different terminals
    and periods), which the provenance says outright.
    """
    if not _HAS_CORPUS:
        return {}, {"source": "MOCK", "degraded": True, "reason": _CORPUS_ERROR}

    inventory, prov = corpus.load_line_inventories()
    counts: Dict[str, int] = {}
    for item in inventory:
        key = f"{item.terminal}/{item.direction}"
        counts[key] = counts.get(key, 0) + 1
    return counts, {
        **prov.as_dict(),
        "keyed_by": "terminal/direction",
        "note": (
            "Move counts are real but do not join to the TOS vessel calls: the "
            "inventories and the TOS extract cover different terminals and periods. "
            "They are reported as a terminal workload profile, not as a per-call rate."),
    }


def stay_variance_spread() -> Tuple[Optional[float], Dict[str, Any]]:
    """
    The observed spread of berth-stay variance, used to size the re-forecast band.

    Taken from ``dsr_berth_stays.csv`` -- 1,113 real berth-stay rows already
    extracted from the Daily Status Reports by the UC-I pipeline. Reusing that
    extraction rather than re-parsing 54 PDFs keeps one definition of a berth
    stay across both use cases.
    """
    if not _HAS_PATHS or not os.path.exists(jnpa_paths.DSR_BERTH_STAYS_CSV):
        return None, {"source": "MOCK", "degraded": True,
                      "reason": "dsr_berth_stays.csv not found; run `python run.py dsr`"}

    import csv as _csv

    stays: List[float] = []
    try:
        with open(jnpa_paths.DSR_BERTH_STAYS_CSV, "r", encoding="utf-8", newline="") as fh:
            for row in _csv.DictReader(fh):
                raw = (row.get("berth_stay_hours") or "").strip()
                if not raw:
                    continue
                try:
                    value = float(raw)
                except ValueError:
                    continue
                if 0 < value < 400:
                    stays.append(value)
    except OSError as exc:
        return None, {"source": "MOCK", "degraded": True, "reason": repr(exc)[:160]}

    if len(stays) < 20:
        return None, {"source": "PARTIAL", "degraded": True,
                      "reason": f"only {len(stays)} usable berth stays"}

    stays.sort()
    sd = statistics.pstdev(stays)
    return sd, {
        "source": "CORPUS", "degraded": False,
        "file": jnpa_paths.relative(jnpa_paths.DSR_BERTH_STAYS_CSV),
        "n_berth_stays": len(stays),
        "median_h": round(statistics.median(stays), 2),
        "mean_h": round(statistics.fmean(stays), 2),
        "sd_h": round(sd, 2),
        "p10_h": round(stays[int(0.10 * (len(stays) - 1))], 2),
        "p90_h": round(stays[int(0.90 * (len(stays) - 1))], 2),
    }


def classify(variance_h: Optional[float]) -> str:
    """Badge a call by how far its stay has drifted from plan."""
    if variance_h is None:
        return "UNKNOWN"
    if variance_h < -ON_PLAN_TOLERANCE_H:
        return STATUS_AHEAD
    if abs(variance_h) <= ON_PLAN_TOLERANCE_H:
        return STATUS_ON_PLAN
    if variance_h <= AT_RISK_TOLERANCE_H:
        return STATUS_AT_RISK
    return STATUS_DELAYED


# ==========================================================================
# SECTION 5 -- TRACKING AND RE-FORECAST
# ==========================================================================


def track_corpus_calls() -> Dict[str, Any]:
    """Measure every real TOS vessel call against its own plan."""
    if not _HAS_CORPUS:
        return {"status": "unavailable", "reason": _CORPUS_ERROR, "degraded": True,
                "calls": []}

    calls, prov = corpus.load_tos_vessel_calls()
    if not calls:
        return {"status": "unavailable", "reason": "no TOS vessel calls parsed",
                "degraded": True, "calls": [], "provenance": prov.as_dict()}

    tracked: List[CallTracking] = []
    for call in calls:
        planned = call.planned_stay_hours
        actual = call.actual_stay_hours
        variance = (actual - planned) if (planned is not None and actual is not None) else None
        departure_delay = None
        if call.etd and call.atd:
            departure_delay = (call.atd - call.etd).total_seconds() / 3600.0

        terminal_key = call.terminal.split("_")[0].upper()
        rate = TERMINAL_CRANE_PRODUCTIVITY.get(
            terminal_key, TERMINAL_CRANE_PRODUCTIVITY["DEFAULT"]) * DEFAULT_CRANES_PER_VESSEL

        tracked.append(CallTracking(
            terminal=call.terminal, via_no=call.via_no, vessel_name=call.vessel_name,
            planned_stay_h=planned, actual_stay_h=actual,
            arrival_delay_h=call.arrival_delay_hours,
            departure_delay_h=departure_delay,
            stay_variance_h=variance,
            status=classify(variance),
            moves=None,
            discharge_rate_moves_per_h=rate,
            rate_source="assumption",
            source="TOS File 02",
        ))

    variances = [t.stay_variance_h for t in tracked if t.stay_variance_h is not None]
    delays = [t.arrival_delay_h for t in tracked if t.arrival_delay_h is not None]
    by_status: Dict[str, int] = {}
    for t in tracked:
        by_status[t.status] = by_status.get(t.status, 0) + 1

    return {
        "status": "measured",
        "degraded": False,
        "model_version": MODULE_VERSION,
        "measured_at": _utc_now_iso(),
        "n_calls": len(tracked),
        "provenance": prov.as_dict(),
        "summary": {
            "stay_variance_h": {
                "mean": round(statistics.fmean(variances), 2) if variances else None,
                "median": round(statistics.median(variances), 2) if variances else None,
                "max": round(max(variances), 2) if variances else None,
                "min": round(min(variances), 2) if variances else None,
            },
            "arrival_delay_h": {
                "mean": round(statistics.fmean(delays), 2) if delays else None,
                "median": round(statistics.median(delays), 2) if delays else None,
            },
            "by_status": by_status,
        },
        "rate_disclosure": (
            "dischargeRateMovesPerHour on these calls comes from the versioned "
            "TERMINAL_CRANE_PRODUCTIVITY assumption, not from observation: the TOS "
            "extract carries no move count. Every such figure is flagged "
            "rateSource=assumption."),
        "calls": [t.as_dict() for t in tracked],
    }


def reforecast(via_no: str, terminal: str, moves_total: int, moves_done: int,
               elapsed_h: float, planned_stay_h: Optional[float] = None,
               cranes: float = DEFAULT_CRANES_PER_VESSEL) -> ReforecastResult:
    """
    Project completion from observed progress, with an auditable breakdown.

    Uses the OBSERVED rate (moves_done / elapsed_h) once enough work has been
    done to make it meaningful; below that it falls back to the terminal's
    crane assumption and says so in ``rate_source``. A rate computed from two
    moves in the first ten minutes would otherwise drive the whole projection.
    """
    if moves_total <= 0:
        raise ValueError("moves_total must be > 0")
    if not 0 <= moves_done <= moves_total:
        raise ValueError("moves_done must be between 0 and moves_total")
    if elapsed_h < 0:
        raise ValueError("elapsed_h must be >= 0")

    terminal_key = terminal.split("_")[0].upper()
    assumed_rate = TERMINAL_CRANE_PRODUCTIVITY.get(
        terminal_key, TERMINAL_CRANE_PRODUCTIVITY["DEFAULT"]) * cranes

    # "Enough work" = at least 30 minutes elapsed and 5% of the parcel done.
    observed_ok = elapsed_h >= 0.5 and moves_done >= max(1, int(0.05 * moves_total))
    rate = (moves_done / elapsed_h) if (observed_ok and elapsed_h > 0) else assumed_rate
    rate_source = "observed" if observed_ok else "assumption"
    rate = max(0.5, rate)

    remaining_moves = moves_total - moves_done
    remaining_h = remaining_moves / rate
    projected_total = elapsed_h + remaining_h + BERTH_STAY_OVERHEAD_H

    spread, spread_prov = stay_variance_spread()
    # Band from the real spread of berth stays, scaled by how much work is left.
    if spread is not None:
        half = spread * math.sqrt(max(0.05, remaining_moves / moves_total)) * 0.5
    else:
        half = remaining_h * 0.25
    p10 = max(0.0, remaining_h - half)
    p90 = remaining_h + half

    variance = (projected_total - planned_stay_h) if planned_stay_h is not None else None

    breakdown = {
        "steps": [
            {"step": "observed rate",
             "formula": "moves_done / elapsed_h",
             "substitution": f"{moves_done} / {elapsed_h:.2f} = "
                             f"{(moves_done / elapsed_h) if elapsed_h > 0 else 0:.2f} moves/h",
             "used": rate_source == "observed"},
            {"step": "assumed rate",
             "formula": "terminal_crane_productivity * cranes",
             "substitution": (
                 f"{TERMINAL_CRANE_PRODUCTIVITY.get(terminal_key, TERMINAL_CRANE_PRODUCTIVITY['DEFAULT'])}"
                 f" * {cranes:g} = {assumed_rate:.2f} moves/h"),
             "used": rate_source == "assumption"},
            {"step": "remaining work",
             "formula": "(moves_total - moves_done) / rate",
             "substitution": f"({moves_total} - {moves_done}) / {rate:.2f} = "
                             f"{remaining_h:.2f} h"},
            {"step": "projected total stay",
             "formula": "elapsed + remaining + berth_overhead",
             "substitution": f"{elapsed_h:.2f} + {remaining_h:.2f} + "
                             f"{BERTH_STAY_OVERHEAD_H:g} = {projected_total:.2f} h"},
        ],
        "rate_gate": (
            "The observed rate is only trusted after 0.5 h elapsed AND 5% of the parcel "
            "worked. Below that the terminal assumption is used, because a rate from a "
            "handful of moves in the first minutes would drive the whole projection."),
        "interval_source": spread_prov,
        "constants": {
            "TERMINAL_CRANE_PRODUCTIVITY": TERMINAL_CRANE_PRODUCTIVITY,
            "BERTH_STAY_OVERHEAD_H": BERTH_STAY_OVERHEAD_H,
            "cranes": cranes,
        },
    }

    return ReforecastResult(
        via_no=via_no, terminal=terminal, moves_total=moves_total,
        moves_done=moves_done, elapsed_h=elapsed_h,
        observed_rate_moves_per_h=rate, remaining_moves=remaining_moves,
        remaining_hours=remaining_h, projected_total_stay_h=projected_total,
        planned_stay_h=planned_stay_h, variance_vs_plan_h=variance,
        p10_remaining_h=p10, p90_remaining_h=p90,
        status=classify(variance), rate_source=rate_source, breakdown=breakdown)


def model_card() -> Dict[str, Any]:
    tracking = track_corpus_calls()
    moves, moves_prov = moves_by_vessel_visit()
    spread, spread_prov = stay_variance_spread()
    return {
        "module_id": MODULE_ID,
        "module_name": MODULE_NAME,
        "model_version": MODULE_VERSION,
        "use_case_solved": (
            "Discharge-rate and berth-stay tracking -- actual versus planned, with a "
            "berth-stay re-forecast when a call deviates."),
        "training_data_features": (
            "TOS plan/outcome timestamps (ETA/ETD/ATA/ATD); DSR berth stays; "
            "EAL/IAL move counts per vessel visit"),
        "training_data_source": "No training: deterministic tracking and projection.",
        "objective_function": (
            "Report actual versus planned rate and stay; re-forecast completion on "
            "deviation using the observed rate once it is trustworthy."),
        "model_used": "Deterministic tracking + rate-based re-forecast heuristics",
        "rationale": (
            "Measurement precedes prediction. The corpus has no move-level productivity "
            "history, so a crane-productivity regression would be fitted to nothing. "
            "Honest tracked actuals are exactly the training base that regression needs."),
        "link_to_model_weights": (
            "No learned weights. TERMINAL_CRANE_PRODUCTIVITY and BERTH_STAY_OVERHEAD_H "
            "are the versioned configuration; served at GET /uc2/m5/constants."),
        "validation_data": (
            f"{tracking.get('n_calls', 0)} real TOS vessel calls with plan and outcome; "
            f"{spread_prov.get('n_berth_stays', 0)} DSR berth stays; "
            f"{sum(moves.values())} inventory lines across "
            f"{len(moves)} terminal/direction groups"),
        "accuracy": {
            "type": "deterministic",
            "note": (
                "Exact given inputs. There is no residual to report because this module "
                "measures rather than predicts; the re-forecast interval is derived from "
                "the observed spread of real berth stays, not from an assumed "
                "distribution."),
            "observed_stay_variance": tracking.get("summary", {}).get("stay_variance_h"),
            "berth_stay_spread_h": round(spread, 2) if spread is not None else None,
        },
        "disclosure": (
            "Discharge RATE is an assumption wherever a real move count is missing, and "
            "every such figure carries rateSource=assumption. The move counts that do "
            "exist come from the shipping-line inventories and do not join to the TOS "
            "calls, so they are reported as a terminal workload profile rather than a "
            "per-call productivity."),
        "production_upgrade": {
            "component": "Deterministic rate assumption",
            "replacement": "Crane-productivity regression per vessel class and terminal",
            "trigger": "Move-level TOS productivity feed with >= 3 months of history",
        },
        "provenance": {
            "tos_calls": tracking.get("provenance"),
            "moves": moves_prov,
            "berth_stays": spread_prov,
        },
    }


# ==========================================================================
# SECTION 6 -- MODULE INFO
# ==========================================================================

MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_UC2_AI_ML_Tools.md row 5 -- Discharge-rate & berth-stay tracking",
    "model_type": "deterministic tracking + re-forecast (no training)",
    "constants": {
        "TERMINAL_CRANE_PRODUCTIVITY": TERMINAL_CRANE_PRODUCTIVITY,
        "DEFAULT_CRANES_PER_VESSEL": DEFAULT_CRANES_PER_VESSEL,
        "BERTH_STAY_OVERHEAD_H": BERTH_STAY_OVERHEAD_H,
        "ON_PLAN_TOLERANCE_H": ON_PLAN_TOLERANCE_H,
        "AT_RISK_TOLERANCE_H": AT_RISK_TOLERANCE_H,
    },
    "corpus_files": [
        "M5_Discharge_Rate_Berth_Stay/TOS_Performance/TOS File 02.xlsx",
        "M5_Discharge_Rate_Berth_Stay/Berthing_Reports/**/*.pdf",
        "data/reference/dsr_berth_stays.csv (extracted by the UC-I pipeline)",
    ],
}


# ==========================================================================
# SECTION 7 -- FASTAPI ROUTER
# ==========================================================================

_HAS_FASTAPI = False
try:
    from fastapi import APIRouter, HTTPException
    from pydantic import BaseModel, Field

    _HAS_FASTAPI = True
except Exception:  # pragma: no cover
    APIRouter = None  # type: ignore
    HTTPException = None  # type: ignore
    BaseModel = object  # type: ignore

    def Field(default=None, **_kw):  # type: ignore
        return default


if _HAS_FASTAPI:

    class ReforecastRequest(BaseModel):
        via_no: str = Field("Q2806", max_length=32)
        terminal: str = Field("BMCT", max_length=32)
        moves_total: int = Field(1200, gt=0, le=20000)
        moves_done: int = Field(400, ge=0, le=20000)
        elapsed_h: float = Field(6.0, ge=0, le=500)
        planned_stay_h: Optional[float] = Field(None, gt=0, le=500)
        cranes: float = Field(DEFAULT_CRANES_PER_VESSEL, gt=0, le=12)

    def build_router() -> "APIRouter":
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-M5 Discharge & Berth Stay"])

        @router.get("/tracking", summary="Every real vessel call measured against plan")
        def tracking() -> Dict[str, Any]:
            return track_corpus_calls()

        @router.post("/reforecast", summary="Re-forecast completion from observed progress")
        def do_reforecast(req: ReforecastRequest) -> Dict[str, Any]:
            try:
                return reforecast(req.via_no, req.terminal, req.moves_total,
                                  req.moves_done, req.elapsed_h,
                                  req.planned_stay_h, req.cranes).as_dict()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @router.get("/moves", summary="Real move counts per terminal and direction")
        def moves() -> Dict[str, Any]:
            counts, prov = moves_by_vessel_visit()
            return {"counts": counts, "total": sum(counts.values()), "provenance": prov}

        @router.get("/berth-stays", summary="Observed berth-stay distribution")
        def berth_stays() -> Dict[str, Any]:
            spread, prov = stay_variance_spread()
            return {"sd_hours": round(spread, 3) if spread is not None else None,
                    "provenance": prov}

        @router.get("/model-card", summary="The WS2 submission row for this model")
        def card() -> Dict[str, Any]:
            return model_card()

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run the canonical demo scenario")
        def demo() -> Dict[str, Any]:
            return _demo().as_dict()

        @router.get("/health", summary="Module health and identity")
        def health() -> Dict[str, Any]:
            checks = _self_test()
            return {
                "status": "ok" if all(ok for _, ok, _ in checks) else "degraded",
                "module": MODULE_INFO,
                "checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks],
            }

        return router

else:  # pragma: no cover

    def build_router():  # type: ignore
        raise RuntimeError("FastAPI is not installed. pip install -r requirements.txt")


# ==========================================================================
# SECTION 8 -- SELF-TEST AND CLI
# ==========================================================================


def _demo() -> ReforecastResult:
    """A BMCT call a third of the way through a 1,200-move parcel, running slow."""
    return reforecast(via_no="Q2806", terminal="BMCT", moves_total=1200,
                      moves_done=400, elapsed_h=8.0, planned_stay_h=24.0)


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []

    result = _demo()
    checks.append(("re-forecast uses the observed rate",
                   result.rate_source == "observed",
                   f"{result.observed_rate_moves_per_h:.1f} moves/h from 400 in 8 h"))
    checks.append(("remaining work is consistent",
                   result.remaining_moves == 800,
                   f"1200 - 400 = {result.remaining_moves}"))
    checks.append(("interval brackets the point",
                   result.p10_remaining_h <= result.remaining_hours <= result.p90_remaining_h,
                   f"[{result.p10_remaining_h:.2f}, {result.p90_remaining_h:.2f}] "
                   f"around {result.remaining_hours:.2f} h"))
    checks.append(("breakdown substitutes real numbers",
                   all("=" in s["substitution"] for s in result.breakdown["steps"]),
                   f"{len(result.breakdown['steps'])} auditable steps"))
    checks.append(("exactly one rate step is marked used",
                   sum(1 for s in result.breakdown["steps"]
                       if s.get("used") is True) == 1,
                   "observed and assumed rates are both shown, one is used"))

    early = reforecast("Q0001", "BMCT", 1200, 2, 0.1)
    checks.append(("early progress falls back to the assumption",
                   early.rate_source == "assumption",
                   "2 moves in 6 minutes does not set the projection"))

    slow = reforecast("Q0002", "BMCT", 1000, 200, 10.0, planned_stay_h=20.0)
    fast = reforecast("Q0003", "BMCT", 1000, 600, 10.0, planned_stay_h=20.0)
    checks.append(("slower work projects a longer stay",
                   slow.projected_total_stay_h > fast.projected_total_stay_h,
                   f"20 moves/h -> {slow.projected_total_stay_h:.1f} h vs "
                   f"60 moves/h -> {fast.projected_total_stay_h:.1f} h"))
    checks.append(("status reflects the variance",
                   slow.status == STATUS_DELAYED and fast.status in
                   (STATUS_ON_PLAN, STATUS_AHEAD, STATUS_AT_RISK),
                   f"slow={slow.status}, fast={fast.status}"))

    for bad in ((0, 0, 1.0), (100, 200, 1.0), (100, 10, -1.0)):
        try:
            reforecast("X", "BMCT", bad[0], bad[1], bad[2])
            checks.append((f"rejects invalid input {bad}", False, "accepted"))
            break
        except ValueError:
            continue
    else:
        checks.append(("rejects invalid inputs", True,
                       "zero parcel, done > total and negative elapsed all raise"))

    checks.append(("classify bands", (
        classify(0.0) == STATUS_ON_PLAN and classify(4.0) == STATUS_AT_RISK
        and classify(10.0) == STATUS_DELAYED and classify(-5.0) == STATUS_AHEAD
        and classify(None) == "UNKNOWN"),
        f"+-{ON_PLAN_TOLERANCE_H:g} on plan, <= {AT_RISK_TOLERANCE_H:g} at risk"))

    tracking = track_corpus_calls()
    if _HAS_CORPUS and tracking["status"] == "measured":
        checks.append(("real calls tracked", tracking["n_calls"] > 0,
                       f"{tracking['n_calls']} TOS calls, "
                       f"statuses {tracking['summary']['by_status']}"))
        checks.append(("assumed rates are flagged",
                       all(c["rateSource"] == "assumption" for c in tracking["calls"]),
                       "no assumed rate is presented as observed"))
    else:
        checks.append(("real calls tracked", False,
                       tracking.get("reason", "corpus unavailable")))

    spread, prov = stay_variance_spread()
    checks.append(("berth-stay spread available", spread is not None,
                   f"{prov.get('n_berth_stays', 0)} DSR stays, sd "
                   f"{prov.get('sd_h', 'n/a')} h" if spread is not None
                   else prov.get("reason", "unavailable")))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"{MODULE_ID} {MODULE_NAME}")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        checks = _self_test()
        for name, ok, detail in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:<42} {detail}")
        failed = [c for c in checks if not c[1]]
        print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if failed else 0

    tracking = track_corpus_calls()
    counts, moves_prov = moves_by_vessel_visit()
    spread, spread_prov = stay_variance_spread()
    demo = _demo()

    if args.json:
        print(json.dumps({
            "module": MODULE_INFO, "tracking": tracking,
            "moves": {"counts": counts, "provenance": moves_prov},
            "berth_stays": spread_prov,
            "demo": demo.as_dict(), "model_card": model_card(),
        }, indent=2, default=str))
        return 0

    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_NAME}   {MODULE_VERSION}")
    print("=" * 78)

    print("\nSCHEDULE ADHERENCE (real TOS vessel calls, plan vs outcome)")
    if tracking["status"] == "measured":
        print(f"  {'terminal':<10}{'via':<8}{'vessel':<18}{'plan':>7}{'actual':>8}"
              f"{'var':>7}{'arr.dly':>9}  status")
        for c in tracking["calls"]:
            print(f"  {c['terminal']:<10}{c['viaNo']:<8}{c['vesselName'][:17]:<18}"
                  f"{c['plannedStayHours']:>7.1f}{c['actualStayHours']:>8.1f}"
                  f"{c['stayVarianceHours']:>7.1f}{c['arrivalDelayHours']:>9.1f}  "
                  f"{c['status']}")
        s = tracking["summary"]
        print(f"\n  stay variance   mean {s['stay_variance_h']['mean']:.2f} h, "
              f"median {s['stay_variance_h']['median']:.2f} h, "
              f"range {s['stay_variance_h']['min']:.2f} to "
              f"{s['stay_variance_h']['max']:.2f} h")
        print(f"  arrival delay   mean {s['arrival_delay_h']['mean']:.2f} h, "
              f"median {s['arrival_delay_h']['median']:.2f} h")
        print(f"  status mix      {s['by_status']}")
    else:
        print(f"  unavailable: {tracking.get('reason')}")

    print("\nBERTH-STAY DISTRIBUTION (from the extracted Daily Status Reports)")
    if spread is not None:
        print(f"  n {spread_prov['n_berth_stays']}   median {spread_prov['median_h']} h   "
              f"mean {spread_prov['mean_h']} h   sd {spread_prov['sd_h']} h   "
              f"P10-P90 {spread_prov['p10_h']}-{spread_prov['p90_h']} h")
    else:
        print(f"  unavailable: {spread_prov.get('reason')}")

    print("\nMOVE COUNTS (real, from the shipping-line inventories)")
    for key, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {key:<20}{count:>7} containers")
    print(f"  {'TOTAL':<20}{sum(counts.values()):>7}")
    if moves_prov.get("note"):
        print(f"  note: {moves_prov['note'][:100]}")

    d = demo.as_dict()
    print(f"\nDEMO RE-FORECAST  {d['viaNo']} at {d['terminal']}: "
          f"{d['movesDone']}/{d['movesTotal']} moves in {d['elapsedHours']:.1f} h")
    print(f"  observed rate   {d['observedRateMovesPerHour']:.2f} moves/h "
          f"({d['rateSource']})")
    print(f"  remaining       {d['remainingHours']:.2f} h  "
          f"window {d['remainingWindowHours']}")
    print(f"  projected stay  {d['projectedTotalStayHours']:.2f} h vs plan "
          f"{d['plannedStayHours']:.1f} h  -> variance "
          f"{d['varianceVsPlanHours']:+.2f} h  [{d['status']}]")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
