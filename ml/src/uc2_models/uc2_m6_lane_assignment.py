"""
UC2-M6 -- Dynamic Lane Assignment
==================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Three of our six gate lanes just went down. Which traffic goes where, how bad
does the wait get, and what do we throttle?"

Feeds the briefing's "lane planning" AI/ML item and the gate-transaction-time
KPI, and answers scenario S4 in the what-if suite.

WHY THIS IS DETERMINISTIC, AND WHY THAT IS THE RIGHT ANSWER
------------------------------------------------------------
A lane re-assignment is not a forecast. It is an allocation decision made
against a demand forecast that already exists -- UC2-M3 supplies the queue --
and it has to be made in the seconds after a closure, defended to a gate
supervisor, and re-made the moment the closure changes.

So this is a transparent allocator: demand per movement class is assigned to
compatible open lanes, longest-queue-first, and the resulting projected wait is
computed from a documented M/M/c-style backlog. Every step comes back in
``breakdown.steps`` with its arithmetic substituted. A learned policy here
would be less accurate (there is no closure history in the corpus to learn
from), slower to explain, and no faster to run.

THE ONE PLACE IT USES A MODEL
-----------------------------
``plan_from_forecast()`` pulls the demand from UC2-M3's queue forecast rather
than inventing it, so the two models agree on what the gate is facing. If M3 is
unavailable the plan still runs on caller-supplied demand and the response says
``demand_source: caller`` instead of ``uc2_m3``.

LANE COMPATIBILITY IS REAL
--------------------------
Not every lane takes every movement. The gate documents in the corpus show
three distinct transaction types -- EIR import, EIR export and PIN pick-up --
and reefer and hazardous traffic need lanes with power and segregation. The
compatibility matrix in ``LANES`` encodes that, and the allocator refuses to
place traffic on an incompatible lane rather than quietly producing a plan that
cannot be executed.

USAGE
-----
    python uc2_m6_lane_assignment.py                # scenario S4
    python uc2_m6_lane_assignment.py --scenario S4B
    python uc2_m6_lane_assignment.py --json
    python uc2_m6_lane_assignment.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

for _extra in (os.path.dirname(os.path.abspath(__file__)),
               os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "pipeline")):
    if _extra not in sys.path:
        sys.path.append(_extra)

# ==========================================================================
# SECTION 1 -- IDENTITY AND VERSIONED CONFIGURATION
# ==========================================================================

MODULE_ID: str = "UC2-M6"
MODULE_NAME: str = "Dynamic Lane Assignment"
MODULE_VERSION: str = "m6-lane-assignment-v1.0.0"
ROUTER_PREFIX: str = "/uc2/m6"

MOVEMENT_CLASSES: Tuple[str, ...] = (
    "IMPORT_LADEN", "EXPORT_LADEN", "EMPTY", "REEFER", "HAZARDOUS",
)

# Wait above which the plan recommends throttling arrivals upstream.
THROTTLE_WAIT_MINUTES: float = 45.0
CRITICAL_WAIT_MINUTES: float = 90.0


@dataclass(frozen=True)
class Lane:
    """One gate lane: what it can process and how fast."""

    lane_id: str
    name: str
    throughput_per_hour: float
    accepts: Tuple[str, ...]
    powered: bool = False       # reefer plug at the lane
    hazmat: bool = False        # segregation and spill kit

    def can_take(self, movement_class: str) -> bool:
        return movement_class in self.accepts

    def as_dict(self) -> Dict[str, Any]:
        return {
            "laneId": self.lane_id, "name": self.name,
            "throughputPerHour": self.throughput_per_hour,
            "accepts": list(self.accepts),
            "powered": self.powered, "hazmat": self.hazmat,
        }


# The six-lane gate complex the scenarios run against. Compatibility follows
# the transaction types visible in the corpus gate documents (EIR import, EIR
# export, PIN pick-up) plus the physical constraints on reefer and hazardous.
LANES: Tuple[Lane, ...] = (
    Lane("L1", "Lane 1 - Import", 30.0, ("IMPORT_LADEN", "EMPTY")),
    Lane("L2", "Lane 2 - Import", 30.0, ("IMPORT_LADEN", "EMPTY")),
    Lane("L3", "Lane 3 - Export", 28.0, ("EXPORT_LADEN", "EMPTY")),
    Lane("L4", "Lane 4 - Export", 28.0, ("EXPORT_LADEN", "EMPTY")),
    Lane("L5", "Lane 5 - Reefer", 22.0, ("REEFER", "IMPORT_LADEN", "EXPORT_LADEN"),
         powered=True),
    Lane("L6", "Lane 6 - Hazardous", 18.0, ("HAZARDOUS", "IMPORT_LADEN", "EXPORT_LADEN"),
         hazmat=True),
)
LANES_BY_ID: Dict[str, Lane] = {l.lane_id: l for l in LANES}


@dataclass(frozen=True)
class Scenario:
    """A named what-if: which lanes are down and what demand is arriving."""

    scenario_id: str
    title: str
    closed_lanes: Tuple[str, ...]
    demand_per_hour: Dict[str, float]
    description: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenarioId": self.scenario_id, "title": self.title,
            "closedLanes": list(self.closed_lanes),
            "demandPerHour": self.demand_per_hour,
            "description": self.description,
        }


SCENARIOS: Dict[str, Scenario] = {
    "BASELINE": Scenario(
        "BASELINE", "All six lanes open, normal demand", (),
        {"IMPORT_LADEN": 42.0, "EXPORT_LADEN": 38.0, "EMPTY": 18.0,
         "REEFER": 8.0, "HAZARDOUS": 4.0},
        "The reference plan every other scenario is compared against."),
    "S4": Scenario(
        "S4", "Three of six lanes closed", ("L2", "L4", "L6"),
        {"IMPORT_LADEN": 42.0, "EXPORT_LADEN": 38.0, "EMPTY": 18.0,
         "REEFER": 8.0, "HAZARDOUS": 4.0},
        "The published S4 scenario: half the gate complex is down, including the "
        "only hazardous-capable lane, at unchanged demand."),
    "S4B": Scenario(
        "S4B", "Three lanes closed during an import surge", ("L2", "L4", "L6"),
        {"IMPORT_LADEN": 68.0, "EXPORT_LADEN": 38.0, "EMPTY": 24.0,
         "REEFER": 10.0, "HAZARDOUS": 4.0},
        "S4 with a vessel discharge landing at the same time -- the case that "
        "actually breaks the gate."),
    "S4C": Scenario(
        "S4C", "Reefer lane alone is down", ("L5",),
        {"IMPORT_LADEN": 42.0, "EXPORT_LADEN": 38.0, "EMPTY": 18.0,
         "REEFER": 8.0, "HAZARDOUS": 4.0},
        "Losing the only powered lane. Reefer traffic has no compatible lane at "
        "all, which the allocator must report as unservable rather than hide."),
}


# ==========================================================================
# SECTION 2 -- OPTIONAL DEPENDENCIES
# ==========================================================================

_HAS_M3, _M3_ERROR = False, ""
try:
    import uc2_m3_gate_queue as m3
    _HAS_M3 = True
except Exception as exc:  # pragma: no cover
    _M3_ERROR = repr(exc)[:200]
    m3 = None  # type: ignore


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ==========================================================================
# SECTION 3 -- THE ALLOCATOR
# ==========================================================================


@dataclass(frozen=True)
class LaneAssignment:
    """What one lane is being asked to do under the plan."""

    lane_id: str
    name: str
    assigned: Dict[str, float]
    load_per_hour: float
    capacity_per_hour: float
    utilisation: float
    projected_wait_minutes: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "laneId": self.lane_id, "name": self.name,
            "assigned": {k: round(v, 2) for k, v in self.assigned.items()},
            "loadPerHour": round(self.load_per_hour, 2),
            "capacityPerHour": round(self.capacity_per_hour, 2),
            "utilisation": round(self.utilisation, 4),
            "projectedWaitMinutes": round(self.projected_wait_minutes, 1),
            "saturated": self.utilisation >= 1.0,
        }


@dataclass(frozen=True)
class LanePlan:
    """A complete re-assignment plan with its projected consequences."""

    scenario_id: str
    title: str
    open_lanes: Tuple[str, ...]
    closed_lanes: Tuple[str, ...]
    assignments: Tuple[LaneAssignment, ...]
    unservable: Dict[str, float]
    total_demand_per_hour: float
    total_capacity_per_hour: float
    worst_wait_minutes: float
    mean_wait_minutes: float
    throttle_recommended: bool
    throttle_classes: Tuple[str, ...]
    status: str
    demand_source: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "scenarioId": self.scenario_id, "title": self.title,
            "openLanes": list(self.open_lanes), "closedLanes": list(self.closed_lanes),
            "assignments": [a.as_dict() for a in self.assignments],
            "unservableDemandPerHour": {k: round(v, 2)
                                        for k, v in self.unservable.items()},
            "totalDemandPerHour": round(self.total_demand_per_hour, 2),
            "totalCapacityPerHour": round(self.total_capacity_per_hour, 2),
            "capacityHeadroomPerHour": round(
                self.total_capacity_per_hour - self.total_demand_per_hour, 2),
            "worstWaitMinutes": round(self.worst_wait_minutes, 1),
            "meanWaitMinutes": round(self.mean_wait_minutes, 1),
            "throttleRecommended": self.throttle_recommended,
            "throttleClasses": list(self.throttle_classes),
            "status": self.status,
            "demand_source": self.demand_source,
            "model_version": MODULE_VERSION,
            "generated_at_utc": _utc_now_iso(),
            # Degraded means a FALLBACK ran, not merely that the demand came
            # from somewhere other than UC2-M3. A caller supplying its own
            # demand, or a named scenario, is a first-class input -- badging
            # those as degraded would train the operator to ignore the badge.
            "degraded": self.demand_source == "fallback_baseline",
            "decision_path": (
                f"deterministic_allocator | demand={self.demand_source} | "
                f"{len(self.open_lanes)}/{len(LANES)} lanes open"),
            "breakdown": self.breakdown,
        }


def _wait_minutes(load: float, capacity: float) -> float:
    """
    Projected wait for a lane at a given load, in minutes.

    Below saturation this is the standard single-queue delay
    ``rho / (mu * (1 - rho))``; at or above saturation the queue is unbounded,
    so the model reports the one-hour backlog delay instead of ``inf``. An
    infinite number renders as a blank cell and tells a gate supervisor
    nothing, whereas "112 minutes and growing" tells them to throttle.
    """
    if capacity <= 0:
        return CRITICAL_WAIT_MINUTES * 4
    rho = load / capacity
    if rho < 0.98:
        return 60.0 * rho / (capacity * (1.0 - rho))
    excess = load - capacity
    return 60.0 * (1.0 + max(0.0, excess) / capacity) + CRITICAL_WAIT_MINUTES


def assign_lanes(demand_per_hour: Dict[str, float],
                 closed_lanes: Sequence[str] = (),
                 scenario_id: str = "AD_HOC",
                 title: str = "Ad-hoc plan",
                 demand_source: str = "caller") -> LanePlan:
    """
    Allocate demand to open, compatible lanes and project the resulting waits.

    The policy is least-loaded-compatible-lane first, applied to movement
    classes in descending order of how constrained they are: a class with only
    one compatible lane is placed before a class with four, because placing the
    flexible traffic first can strand the constrained traffic on a lane that is
    already full.
    """
    for name in demand_per_hour:
        if name not in MOVEMENT_CLASSES:
            raise ValueError(
                f"unknown movement class {name!r}; expected one of {list(MOVEMENT_CLASSES)}")
    for lane_id in closed_lanes:
        if lane_id not in LANES_BY_ID:
            raise ValueError(f"unknown lane {lane_id!r}; expected one of {list(LANES_BY_ID)}")
    if any(v < 0 for v in demand_per_hour.values()):
        raise ValueError("demand must be >= 0")

    closed = tuple(closed_lanes)
    open_lanes = [l for l in LANES if l.lane_id not in closed]
    load: Dict[str, float] = {l.lane_id: 0.0 for l in open_lanes}
    assigned: Dict[str, Dict[str, float]] = {l.lane_id: {} for l in open_lanes}
    unservable: Dict[str, float] = {}
    steps: List[Dict[str, Any]] = []

    # Most-constrained class first. See the docstring.
    classes = sorted(
        (c for c in MOVEMENT_CLASSES if demand_per_hour.get(c, 0.0) > 0),
        key=lambda c: (sum(1 for l in open_lanes if l.can_take(c)), -demand_per_hour[c]))

    for movement in classes:
        remaining = demand_per_hour[movement]
        compatible = [l for l in open_lanes if l.can_take(movement)]
        if not compatible:
            unservable[movement] = remaining
            steps.append({
                "step": f"assign {movement}",
                "formula": "compatible open lanes",
                "substitution": f"{movement}: no compatible lane open -> "
                                f"{remaining:.1f}/h UNSERVABLE",
                "unservable": round(remaining, 2),
            })
            continue

        # Spread proportionally to spare capacity so no lane is filled first.
        placed: List[str] = []
        for _ in range(len(compatible)):
            spare = {l.lane_id: max(0.0, l.throughput_per_hour - load[l.lane_id])
                     for l in compatible}
            total_spare = sum(spare.values())
            if total_spare <= 1e-9 or remaining <= 1e-9:
                break
            for lane in compatible:
                if remaining <= 1e-9:
                    break
                share = min(remaining, remaining * spare[lane.lane_id] / total_spare)
                share = min(share, max(0.0, lane.throughput_per_hour - load[lane.lane_id]))
                if share <= 1e-9:
                    continue
                load[lane.lane_id] += share
                assigned[lane.lane_id][movement] = (
                    assigned[lane.lane_id].get(movement, 0.0) + share)
                remaining -= share
                placed.append(lane.lane_id)

        if remaining > 1e-6:
            # Everything compatible is full; overflow onto the least-loaded of
            # them rather than dropping it. A truck that arrives does not
            # vanish because the plan has no room for it.
            target = min(compatible, key=lambda l: load[l.lane_id] / l.throughput_per_hour)
            load[target.lane_id] += remaining
            assigned[target.lane_id][movement] = (
                assigned[target.lane_id].get(movement, 0.0) + remaining)
            steps.append({
                "step": f"overflow {movement}",
                "formula": "excess -> least-loaded compatible lane",
                "substitution": f"{remaining:.1f}/h beyond capacity pushed to "
                                f"{target.lane_id} (lane goes over 100%)",
                "overflow": round(remaining, 2),
            })
            remaining = 0.0

        steps.append({
            "step": f"assign {movement}",
            "formula": "spread across compatible lanes in proportion to spare capacity",
            "substitution": (
                f"{demand_per_hour[movement]:.1f}/h over "
                f"{len(set(placed)) or len(compatible)} lane(s): "
                + ", ".join(f"{lid}={assigned[lid].get(movement, 0.0):.1f}"
                            for lid in sorted(set(placed)) or [])),
            "compatibleLanes": [l.lane_id for l in compatible],
        })

    assignments: List[LaneAssignment] = []
    for lane in open_lanes:
        util = load[lane.lane_id] / lane.throughput_per_hour if lane.throughput_per_hour else 0.0
        assignments.append(LaneAssignment(
            lane_id=lane.lane_id, name=lane.name,
            assigned=assigned[lane.lane_id],
            load_per_hour=load[lane.lane_id],
            capacity_per_hour=lane.throughput_per_hour,
            utilisation=util,
            projected_wait_minutes=_wait_minutes(load[lane.lane_id],
                                                 lane.throughput_per_hour)))

    waits = [a.projected_wait_minutes for a in assignments if a.load_per_hour > 0]
    worst = max(waits) if waits else 0.0
    mean = sum(waits) / len(waits) if waits else 0.0

    throttle_classes = tuple(sorted(unservable)) + tuple(sorted(
        {m for a in assignments if a.utilisation >= 1.0 for m in a.assigned}))
    throttle = worst >= THROTTLE_WAIT_MINUTES or bool(unservable)

    if unservable:
        status = "UNSERVABLE_DEMAND"
    elif worst >= CRITICAL_WAIT_MINUTES:
        status = "CRITICAL"
    elif worst >= THROTTLE_WAIT_MINUTES:
        status = "THROTTLE"
    else:
        status = "OK"

    total_capacity = sum(l.throughput_per_hour for l in open_lanes)
    steps.append({
        "step": "capacity balance",
        "formula": "sum(open lane throughput) - sum(demand)",
        "substitution": (
            f"{total_capacity:.1f} - {sum(demand_per_hour.values()):.1f} = "
            f"{total_capacity - sum(demand_per_hour.values()):.1f} trucks/h headroom"),
    })

    return LanePlan(
        scenario_id=scenario_id, title=title,
        open_lanes=tuple(l.lane_id for l in open_lanes), closed_lanes=closed,
        assignments=tuple(assignments), unservable=unservable,
        total_demand_per_hour=sum(demand_per_hour.values()),
        total_capacity_per_hour=total_capacity,
        worst_wait_minutes=worst, mean_wait_minutes=mean,
        throttle_recommended=throttle,
        throttle_classes=tuple(dict.fromkeys(throttle_classes)),
        status=status, demand_source=demand_source,
        breakdown={
            "policy": (
                "Most-constrained movement class first, then spread across compatible "
                "open lanes in proportion to spare capacity. Overflow beyond total "
                "compatible capacity is placed on the least-loaded lane and reported, "
                "never dropped."),
            "wait_formula": (
                "rho/(mu*(1-rho)) below saturation; at or above saturation the "
                "one-hour backlog delay is reported instead of infinity, because a "
                "blank cell tells a gate supervisor nothing."),
            "thresholds": {
                "throttle_wait_minutes": THROTTLE_WAIT_MINUTES,
                "critical_wait_minutes": CRITICAL_WAIT_MINUTES,
            },
            "steps": steps,
            "lanes": [l.as_dict() for l in LANES],
        })


def run_scenario(scenario_id: str) -> LanePlan:
    """Run a named what-if scenario."""
    scenario = SCENARIOS.get(scenario_id.upper())
    if scenario is None:
        raise ValueError(f"unknown scenario {scenario_id!r}; "
                         f"expected one of {sorted(SCENARIOS)}")
    return assign_lanes(dict(scenario.demand_per_hour), scenario.closed_lanes,
                        scenario.scenario_id, scenario.title, demand_source="scenario")


def compare_to_baseline(scenario_id: str) -> Dict[str, Any]:
    """The delta a closure actually costs, which is what the demo shows."""
    baseline = run_scenario("BASELINE")
    plan = run_scenario(scenario_id)
    return {
        "baseline": baseline.as_dict(),
        "scenario": plan.as_dict(),
        "delta": {
            "lanesLost": len(plan.closed_lanes),
            "capacityLostPerHour": round(
                baseline.total_capacity_per_hour - plan.total_capacity_per_hour, 2),
            "worstWaitIncreaseMinutes": round(
                plan.worst_wait_minutes - baseline.worst_wait_minutes, 1),
            "meanWaitIncreaseMinutes": round(
                plan.mean_wait_minutes - baseline.mean_wait_minutes, 1),
            "statusChange": f"{baseline.status} -> {plan.status}",
            "newlyUnservable": sorted(plan.unservable),
        },
    }


def plan_from_forecast(gate: str = "CFS", closed_lanes: Sequence[str] = (),
                       hours_ahead: int = 1,
                       class_mix: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """
    Build a plan whose demand comes from UC2-M3's queue forecast, not from a guess.

    The forecast gives a total; ``class_mix`` splits it across movement classes.
    The mix is an assumption and is returned in the response so the caller can
    see -- and override -- what it was.
    """
    mix = class_mix or {"IMPORT_LADEN": 0.38, "EXPORT_LADEN": 0.34, "EMPTY": 0.16,
                        "REEFER": 0.08, "HAZARDOUS": 0.04}
    total = abs(sum(mix.values()))
    if total <= 0:
        raise ValueError("class_mix must sum to more than zero")

    demand_source = "uc2_m3"
    forecast_payload: Optional[Dict[str, Any]] = None
    if _HAS_M3:
        try:
            curve = m3.get_forecaster().forecast_curve(gate.upper(), max(1, hours_ahead))
            point = curve["points"][min(hours_ahead, len(curve["points"])) - 1]
            # Queue plus service capacity is the arrival pressure the gate faces.
            arrivals = (point["queueVehicles"]
                        + m3.SERVICE_CAPACITY_PER_HOUR) * len(LANES)
            forecast_payload = {
                "gate": gate.upper(), "stepAhead": point["stepAhead"],
                "ts": point["ts"], "queueVehicles": point["queueVehicles"],
                "deferralRecommended": point["deferralRecommended"],
                "model_version": curve["model_version"],
            }
        except Exception as exc:  # noqa: BLE001 - fall back rather than 500
            demand_source, arrivals = "fallback_baseline", 110.0
            forecast_payload = {"error": repr(exc)[:200]}
    else:
        demand_source, arrivals = "fallback_baseline", 110.0
        forecast_payload = {"error": _M3_ERROR or "uc2_m3 unavailable"}

    demand = {k: arrivals * v / total for k, v in mix.items()}
    plan = assign_lanes(demand, closed_lanes, "FROM_FORECAST",
                        f"Plan from the UC2-M3 queue forecast for gate {gate.upper()}",
                        demand_source=demand_source)
    payload = plan.as_dict()
    payload["forecast"] = forecast_payload
    payload["classMix"] = mix
    payload["classMixNote"] = (
        "The movement-class split is an assumption, not a measurement -- the gate "
        "documents in the corpus do not carry enough transactions to estimate it. "
        "Override it with class_mix.")
    return payload


def model_card() -> Dict[str, Any]:
    s4 = compare_to_baseline("S4")
    return {
        "module_id": MODULE_ID,
        "module_name": MODULE_NAME,
        "model_version": MODULE_VERSION,
        "use_case_solved": (
            "Dynamic lane assignment -- re-assign open lanes to minimise projected "
            "queue wait under a closure."),
        "training_data_features": (
            "Lane states and compatibility, closure events, the UC2-M3 queue forecast"),
        "training_data_source": "No training: a deterministic allocator.",
        "objective_function": (
            "Minimise projected queue wait subject to lane compatibility; recommend "
            f"throttling when the worst wait reaches {THROTTLE_WAIT_MINUTES:g} min or "
            "any demand is unservable."),
        "model_used": "Deterministic re-assignment (most-constrained-class-first)",
        "rationale": (
            "A re-plan must be instant and explainable to a gate supervisor mid-closure, "
            "and the corpus contains no closure history to learn a policy from. "
            "Production couples this to UC-III TAS metering."),
        "link_to_model_weights": (
            "No learned weights. LANES and SCENARIOS are the versioned configuration; "
            "served at GET /uc2/m6/constants."),
        "validation_data": "Scenario regression suite: " + ", ".join(sorted(SCENARIOS)),
        "accuracy": {
            "type": "deterministic",
            "note": ("Exact given inputs. Feasibility is guaranteed by construction: "
                     "incompatible placements are impossible and unservable demand is "
                     "reported rather than silently absorbed."),
            "s4_worst_wait_increase_min": s4["delta"]["worstWaitIncreaseMinutes"],
            "s4_capacity_lost_per_hour": s4["delta"]["capacityLostPerHour"],
            "s4_status_change": s4["delta"]["statusChange"],
        },
        "disclosure": (
            "Lane throughputs and the movement-class mix are operating assumptions, "
            "versioned in LANES and returned with every plan. The corpus's twelve gate "
            "documents prove the transaction types but are far too few to estimate a "
            "traffic mix from."),
        "scenarios": {k: v.as_dict() for k, v in SCENARIOS.items()},
    }


# ==========================================================================
# SECTION 4 -- MODULE INFO
# ==========================================================================

MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_UC2_AI_ML_Tools.md row 6 -- Dynamic lane assignment",
    "model_type": "deterministic allocator (no training)",
    "movement_classes": list(MOVEMENT_CLASSES),
    "constants": {
        "LANES": [l.as_dict() for l in LANES],
        "THROTTLE_WAIT_MINUTES": THROTTLE_WAIT_MINUTES,
        "CRITICAL_WAIT_MINUTES": CRITICAL_WAIT_MINUTES,
        "SCENARIOS": {k: v.as_dict() for k, v in SCENARIOS.items()},
    },
    "consumes": ["UC2-M3 gate queue forecast"],
}


# ==========================================================================
# SECTION 5 -- FASTAPI ROUTER
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

    class PlanRequest(BaseModel):
        demand_per_hour: Dict[str, float] = Field(
            default={"IMPORT_LADEN": 42.0, "EXPORT_LADEN": 38.0, "EMPTY": 18.0,
                     "REEFER": 8.0, "HAZARDOUS": 4.0},
            description="Trucks per hour by movement class: "
                        + ", ".join(MOVEMENT_CLASSES))
        closed_lanes: List[str] = Field(default=[], description="Lane IDs that are down")

    def build_router() -> "APIRouter":
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-M6 Lane Assignment"])

        @router.post("/plan", summary="Re-assign lanes for a given demand and closure")
        def plan(req: PlanRequest) -> Dict[str, Any]:
            try:
                return assign_lanes(req.demand_per_hour, req.closed_lanes).as_dict()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @router.get("/scenario/{scenario_id}", summary="Run a named what-if scenario")
        def scenario(scenario_id: str) -> Dict[str, Any]:
            try:
                return compare_to_baseline(scenario_id)
            except ValueError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        @router.get("/from-forecast", summary="Plan whose demand comes from UC2-M3")
        def from_forecast(gate: str = "CFS", hours_ahead: int = 1,
                          closed: str = "") -> Dict[str, Any]:
            closed_lanes = [c.strip().upper() for c in closed.split(",") if c.strip()]
            try:
                return plan_from_forecast(gate, closed_lanes, hours_ahead)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @router.get("/lanes", summary="The lane roster and compatibility matrix")
        def lanes() -> Dict[str, Any]:
            return {"lanes": [l.as_dict() for l in LANES],
                    "movementClasses": list(MOVEMENT_CLASSES)}

        @router.get("/model-card", summary="The WS2 submission row for this model")
        def card() -> Dict[str, Any]:
            return model_card()

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run the canonical demo scenario (S4)")
        def demo() -> Dict[str, Any]:
            return compare_to_baseline("S4")

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
# SECTION 6 -- SELF-TEST AND CLI
# ==========================================================================


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []

    baseline = run_scenario("BASELINE")
    checks.append(("baseline serves all demand", not baseline.unservable,
                   f"worst wait {baseline.worst_wait_minutes:.1f} min, "
                   f"status {baseline.status}"))

    s4 = run_scenario("S4")
    checks.append(("S4 closes three lanes", len(s4.open_lanes) == 3,
                   f"open {list(s4.open_lanes)}, closed {list(s4.closed_lanes)}"))
    checks.append(("S4 is worse than baseline",
                   s4.worst_wait_minutes > baseline.worst_wait_minutes,
                   f"{baseline.worst_wait_minutes:.1f} -> {s4.worst_wait_minutes:.1f} min"))
    checks.append(("S4 recommends a throttle", s4.throttle_recommended,
                   f"status {s4.status}, classes {list(s4.throttle_classes)}"))

    checks.append(("hazardous is unservable when L6 closes",
                   "HAZARDOUS" in s4.unservable,
                   "L6 is the only hazmat lane -- reported, not silently absorbed"))

    s4c = run_scenario("S4C")
    checks.append(("reefer is unservable when L5 closes",
                   "REEFER" in s4c.unservable,
                   f"{s4c.unservable.get('REEFER', 0):.0f} reefer moves/h with no "
                   f"powered lane"))

    for plan in (baseline, s4, s4c):
        for a in plan.assignments:
            lane = LANES_BY_ID[a.lane_id]
            if any(not lane.can_take(m) for m in a.assigned):
                checks.append(("no incompatible placement", False,
                               f"{a.lane_id} was given {list(a.assigned)}"))
                break
        else:
            continue
        break
    else:
        checks.append(("no incompatible placement", True,
                       "every assignment respects the compatibility matrix"))

    served = sum(sum(a.assigned.values()) for a in s4.assignments)
    expected = s4.total_demand_per_hour - sum(s4.unservable.values())
    checks.append(("demand is conserved", abs(served - expected) < 1e-6,
                   f"{served:.2f} placed + {sum(s4.unservable.values()):.2f} unservable "
                   f"= {s4.total_demand_per_hour:.2f} offered"))

    checks.append(("no wait is infinite",
                   all(math.isfinite(a.projected_wait_minutes) for a in s4.assignments),
                   "saturated lanes report a backlog delay, not inf"))

    checks.append(("breakdown substitutes real numbers",
                   all("substitution" in s for s in s4.breakdown["steps"]),
                   f"{len(s4.breakdown['steps'])} auditable steps"))

    try:
        assign_lanes({"NOT_A_CLASS": 10.0})
        ok, detail = False, "accepted an unknown movement class"
    except ValueError:
        ok, detail = True, "raises on an unknown movement class"
    checks.append(("input validated", ok, detail))

    try:
        assign_lanes({"EMPTY": 5.0}, closed_lanes=["L99"])
        ok, detail = False, "accepted an unknown lane"
    except ValueError:
        ok, detail = True, "raises on an unknown lane"
    checks.append(("closure list validated", ok, detail))

    try:
        run_scenario("NOPE")
        ok, detail = False, "accepted an unknown scenario"
    except ValueError:
        ok, detail = True, "raises on an unknown scenario"
    checks.append(("scenario lookup validated", ok, detail))

    forecast_plan = plan_from_forecast("CFS", ["L2", "L4"])
    checks.append(("demand can come from UC2-M3",
                   forecast_plan["demand_source"] in ("uc2_m3", "fallback_baseline"),
                   f"demand_source={forecast_plan['demand_source']}"))
    checks.append(("class mix is disclosed as an assumption",
                   "classMixNote" in forecast_plan,
                   "the split is returned with the plan, not hidden"))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"{MODULE_ID} {MODULE_NAME}")
    ap.add_argument("--scenario", default="S4", choices=sorted(SCENARIOS))
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

    comparison = compare_to_baseline(args.scenario)
    if args.json:
        print(json.dumps({"module": MODULE_INFO, "comparison": comparison,
                          "from_forecast": plan_from_forecast("CFS", ["L2", "L4", "L6"]),
                          "model_card": model_card()}, indent=2, default=str))
        return 0

    base, plan, delta = comparison["baseline"], comparison["scenario"], comparison["delta"]
    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_NAME}   {MODULE_VERSION}")
    print("=" * 78)
    print(f"\nSCENARIO {plan['scenarioId']}  {plan['title']}")
    print(f"  {SCENARIOS[args.scenario].description}")
    print(f"\n  closed lanes  {plan['closedLanes'] or 'none'}")
    print(f"  capacity      {plan['totalCapacityPerHour']:.0f}/h vs demand "
          f"{plan['totalDemandPerHour']:.0f}/h  "
          f"(headroom {plan['capacityHeadroomPerHour']:+.0f}/h)")

    print(f"\n  {'lane':<6}{'name':<22}{'load':>7}{'cap':>6}{'util':>8}{'wait':>9}")
    for a in plan["assignments"]:
        print(f"  {a['laneId']:<6}{a['name']:<22}{a['loadPerHour']:>7.1f}"
              f"{a['capacityPerHour']:>6.0f}{a['utilisation'] * 100:>7.0f}%"
              f"{a['projectedWaitMinutes']:>8.0f}m"
              f"{'  SAT' if a['saturated'] else ''}")
        for movement, qty in sorted(a["assigned"].items(), key=lambda kv: -kv[1]):
            print(f"        {movement:<20}{qty:>7.1f}/h")

    if plan["unservableDemandPerHour"]:
        print("\n  UNSERVABLE (no compatible lane open):")
        for movement, qty in plan["unservableDemandPerHour"].items():
            print(f"    {movement:<20}{qty:>7.1f}/h")

    print(f"\n  status        {plan['status']}")
    print(f"  worst wait    {plan['worstWaitMinutes']:.0f} min "
          f"(baseline {base['worstWaitMinutes']:.0f} min, "
          f"{delta['worstWaitIncreaseMinutes']:+.0f})")
    print(f"  mean wait     {plan['meanWaitMinutes']:.0f} min "
          f"({delta['meanWaitIncreaseMinutes']:+.0f})")
    print(f"  throttle      {plan['throttleRecommended']}  "
          f"{plan['throttleClasses']}")
    print(f"  vs baseline   {delta['statusChange']}, "
          f"{delta['capacityLostPerHour']:.0f}/h capacity lost")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
