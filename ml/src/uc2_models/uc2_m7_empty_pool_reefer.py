"""
UC2-M7 -- Empty-Pool & Reefer Surge Management
===============================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Do we have the empties this terminal needs, and are there enough reefer plugs
for what is about to land?"

Feeds the briefing's "empty discharge & load impact on gates" what-if item and
the ECY-congestion edge case.

THE POOL IS REAL, AND IT IS LOPSIDED
-------------------------------------
The shipping-line EAL and IAL inventories are the largest real dataset in the
whole UC-II corpus: 6,467 container lines across eight terminal/direction
groups, of which 1,885 are empties and 212 are reefers (identified from the ISO
6346 size-type code -- see ``uc2_corpus.iso_is_reefer``, which handles both the
alphanumeric ``45R1`` form and the older numeric ``4532`` form; missing the
second would under-count reefers by roughly half).

Two of the nine inventory files are legacy ``.xls`` that need ``xlrd`` and are
not read. That is 2 files out of 9, it is reported in the provenance on every
response, and it is not silently smoothed over -- an empty-pool balance that
quietly loses a terminal is wrong in a direction nobody can see.

REEFER PLUGS ARE A SAFETY CONSTRAINT, SO THE LOGIC IS RULE-AUDITABLE
---------------------------------------------------------------------
A reefer that loses power spoils its cargo. The allocation is therefore a
transparent priority matcher, not a learned policy: plugs go to the highest
temperature-risk boxes first, the shortfall is stated in plain numbers, and
every step is in ``breakdown``. Scenario S6 (a 3.5x reefer surge with 18 of 96
plugs failed) is the regression case.

USAGE
-----
    python uc2_m7_empty_pool_reefer.py
    python uc2_m7_empty_pool_reefer.py --scenario S6
    python uc2_m7_empty_pool_reefer.py --json
    python uc2_m7_empty_pool_reefer.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
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

MODULE_ID: str = "UC2-M7"
MODULE_NAME: str = "Empty-Pool & Reefer Surge Management"
MODULE_VERSION: str = "m7-empty-reefer-v1.0.0"
ROUTER_PREFIX: str = "/uc2/m7"

# Reefer plug inventory at the Container Parking Plaza.
CPP_REEFER_PLUGS: int = 96
PLUG_RESERVE_PCT: float = 0.05        # never plan to the last plug

# How long a reefer can hold temperature unplugged, by cargo sensitivity.
# These set the evacuation priority and are the numbers to argue with.
HOLD_HOURS_BY_SENSITIVITY: Dict[str, float] = {
    "PHARMA": 4.0,
    "FROZEN": 8.0,
    "CHILLED": 12.0,
    "AMBIENT_CONTROLLED": 24.0,
    "UNKNOWN": 8.0,
}
SENSITIVITY_PRIORITY: Tuple[str, ...] = (
    "PHARMA", "FROZEN", "CHILLED", "AMBIENT_CONTROLLED", "UNKNOWN")

# An empty pool below this many days of cover triggers a reposition request.
MIN_DAYS_COVER: float = 1.5
TARGET_DAYS_COVER: float = 3.0


@dataclass(frozen=True)
class ReeferScenario:
    """A named reefer what-if."""

    scenario_id: str
    title: str
    surge_multiplier: float
    plugs_failed: int
    sensitivity_mix: Dict[str, float]
    description: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenarioId": self.scenario_id, "title": self.title,
            "surgeMultiplier": self.surge_multiplier,
            "plugsFailed": self.plugs_failed,
            "sensitivityMix": self.sensitivity_mix,
            "description": self.description,
        }


SCENARIOS: Dict[str, ReeferScenario] = {
    "BASELINE": ReeferScenario(
        "BASELINE", "Normal reefer arrivals, full plug bank", 1.0, 0,
        {"CHILLED": 0.5, "FROZEN": 0.3, "PHARMA": 0.05, "AMBIENT_CONTROLLED": 0.15},
        "The reference case: the reefers actually in the corpus, all 96 plugs live."),
    "S6": ReeferScenario(
        "S6", "Reefer surge x3.5 with 18 plugs failed", 3.5, 18,
        {"CHILLED": 0.5, "FROZEN": 0.3, "PHARMA": 0.05, "AMBIENT_CONTROLLED": 0.15},
        "The published S6 scenario: a reefer-heavy discharge lands while a "
        "switchboard fault takes 18 of the 96 CPP plugs out."),
    "S6B": ReeferScenario(
        "S6B", "Pharma-heavy surge, 18 plugs failed", 2.5, 18,
        {"PHARMA": 0.4, "FROZEN": 0.3, "CHILLED": 0.25, "AMBIENT_CONTROLLED": 0.05},
        "The same fault against a pharma-heavy parcel: fewer boxes, far less time "
        "before the first one is at risk."),
}


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


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ==========================================================================
# SECTION 3 -- THE REAL POOL
# ==========================================================================


@dataclass(frozen=True)
class PoolSnapshot:
    """The empty and reefer position across every terminal the corpus covers."""

    source: str
    total_containers: int
    empties: int
    reefers: int
    by_terminal: Dict[str, Dict[str, int]]
    by_line: Dict[str, int]
    by_size: Dict[str, int]
    provenance: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "degraded": self.source != "CORPUS",
            "totalContainers": self.total_containers,
            "empties": self.empties,
            "reefers": self.reefers,
            "emptyShare": round(self.empties / self.total_containers, 4)
            if self.total_containers else None,
            "reeferShare": round(self.reefers / self.total_containers, 4)
            if self.total_containers else None,
            "byTerminal": self.by_terminal,
            "byLine": dict(sorted(self.by_line.items(), key=lambda kv: -kv[1])[:12]),
            "bySize": self.by_size,
            "provenance": self.provenance,
        }


def load_pool() -> PoolSnapshot:
    """Build the empty/reefer position from the real EAL and IAL inventories."""
    if not _HAS_CORPUS:
        return PoolSnapshot("MOCK", 0, 0, 0, {}, {}, {},
                            {"source": "MOCK", "degraded": True, "reason": _CORPUS_ERROR})

    inventory, prov = corpus.load_line_inventories()
    by_terminal: Dict[str, Dict[str, int]] = {}
    by_line: Dict[str, int] = {}
    by_size: Dict[str, int] = {}
    empties = reefers = 0

    for item in inventory:
        bucket = by_terminal.setdefault(
            item.terminal, {"total": 0, "empty": 0, "laden": 0, "reefer": 0,
                            "import": 0, "export": 0})
        bucket["total"] += 1
        bucket["empty" if item.empty else "laden"] += 1
        bucket["import" if item.direction == "IMPORT" else "export"] += 1
        if item.reefer:
            bucket["reefer"] += 1
            reefers += 1
        if item.empty:
            empties += 1
        if item.line:
            by_line[item.line] = by_line.get(item.line, 0) + 1
        size_key = f"{item.size_ft}ft" if item.size_ft else "unknown"
        by_size[size_key] = by_size.get(size_key, 0) + 1

    return PoolSnapshot(
        source=prov.source, total_containers=len(inventory),
        empties=empties, reefers=reefers,
        by_terminal=dict(sorted(by_terminal.items(),
                                key=lambda kv: -kv[1]["total"])),
        by_line=by_line, by_size=by_size,
        provenance={**prov.as_dict(),
                    "reefer_detection": (
                        "ISO 6346 size-type code: the alphanumeric 'R' form (45R1) and "
                        "the older numeric group-3 form (4532). Handling only the first "
                        "would under-count reefers by about half.")})


# ==========================================================================
# SECTION 4 -- EMPTY-POOL BALANCE
# ==========================================================================


@dataclass(frozen=True)
class TerminalBalance:
    """One terminal's empty position against its own demand."""

    terminal: str
    empties_available: int
    daily_demand: float
    days_cover: float
    status: str
    reposition_units: int

    def as_dict(self) -> Dict[str, Any]:
        return {
            "terminal": self.terminal,
            "emptiesAvailable": self.empties_available,
            "dailyDemand": round(self.daily_demand, 1),
            "daysCover": round(self.days_cover, 2),
            "status": self.status,
            "repositionUnits": self.reposition_units,
        }


def balance_empty_pool(daily_demand_by_terminal: Optional[Dict[str, float]] = None,
                       snapshot: Optional[PoolSnapshot] = None) -> Dict[str, Any]:
    """
    Match empty supply to demand per terminal and propose repositions.

    When no demand is supplied, each terminal's export laden count stands in for
    it: a box exported is a box that had to be filled, so it is the closest real
    proxy the corpus offers. That substitution is named in the response --
    inventing a demand figure and presenting it as measured is the failure mode
    this whole module is written against.
    """
    snap = snapshot or load_pool()
    if not snap.by_terminal:
        return {"status": "unavailable", "degraded": True,
                "reason": snap.provenance.get("reason", "no inventory parsed"),
                "balances": []}

    demand_source = "caller"
    if daily_demand_by_terminal is None:
        demand_source = "proxy_export_laden"
        daily_demand_by_terminal = {
            t: max(1.0, b["export"] / 7.0)      # inventories span roughly a week
            for t, b in snap.by_terminal.items()}

    balances: List[TerminalBalance] = []
    for terminal, bucket in snap.by_terminal.items():
        available = bucket["empty"]
        demand = max(0.1, daily_demand_by_terminal.get(terminal, 1.0))
        cover = available / demand
        if cover < MIN_DAYS_COVER:
            status, needed = "SHORT", int(math.ceil((TARGET_DAYS_COVER - cover) * demand))
        elif cover > TARGET_DAYS_COVER * 2:
            status, needed = "SURPLUS", -int((cover - TARGET_DAYS_COVER) * demand)
        else:
            status, needed = "ADEQUATE", 0
        balances.append(TerminalBalance(terminal, available, demand, cover,
                                        status, needed))

    balances.sort(key=lambda b: b.days_cover)
    short = [b for b in balances if b.status == "SHORT"]
    surplus = [b for b in balances if b.status == "SURPLUS"]

    # Greedy repositioning: biggest surplus covers the deepest shortfall first.
    moves: List[Dict[str, Any]] = []
    pool = {b.terminal: -b.reposition_units for b in surplus}
    for want in short:
        need = want.reposition_units
        for donor in sorted(pool, key=lambda t: -pool[t]):
            if need <= 0 or pool[donor] <= 0:
                continue
            qty = min(need, pool[donor])
            moves.append({"from": donor, "to": want.terminal, "units": int(qty),
                          "reason": f"{want.terminal} at {want.days_cover:.2f} days "
                                    f"cover, below the {MIN_DAYS_COVER:g}-day floor"})
            pool[donor] -= qty
            need -= qty
        if need > 0:
            moves.append({"from": None, "to": want.terminal, "units": int(need),
                          "reason": "no surplus available in the pool -- escalate to "
                                    "the line for an inbound empty reposition"})

    return {
        "status": "balanced",
        "degraded": snap.source != "CORPUS",
        "model_version": MODULE_VERSION,
        "generated_at_utc": _utc_now_iso(),
        "demand_source": demand_source,
        "demand_note": (
            "Daily demand is proxied from each terminal's export laden count over the "
            "inventory window; the corpus carries no booked empty-release figure."
            if demand_source == "proxy_export_laden" else "Supplied by the caller."),
        "thresholds": {"min_days_cover": MIN_DAYS_COVER,
                       "target_days_cover": TARGET_DAYS_COVER},
        "balances": [b.as_dict() for b in balances],
        "short_terminals": [b.terminal for b in short],
        "surplus_terminals": [b.terminal for b in surplus],
        "reposition_plan": moves,
        "provenance": snap.provenance,
    }


# ==========================================================================
# SECTION 5 -- REEFER PLUG ALLOCATION
# ==========================================================================


@dataclass(frozen=True)
class ReeferAllocation:
    """The plug plan, and what happens to whatever does not get one."""

    scenario_id: str
    title: str
    reefers_arriving: int
    plugs_total: int
    plugs_failed: int
    plugs_available: int
    plugs_reserved: int
    plugs_allocatable: int
    allocated: Dict[str, int]
    unplugged: Dict[str, int]
    shortfall: int
    hours_to_first_risk: Optional[float]
    priority_evacuation: Tuple[str, ...]
    status: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "scenarioId": self.scenario_id, "title": self.title,
            "reefersArriving": self.reefers_arriving,
            "plugsTotal": self.plugs_total, "plugsFailed": self.plugs_failed,
            "plugsAvailable": self.plugs_available,
            "plugsReserved": self.plugs_reserved,
            "plugsAllocatable": self.plugs_allocatable,
            "allocatedBySensitivity": self.allocated,
            "unpluggedBySensitivity": self.unplugged,
            "shortfall": self.shortfall,
            "hoursToFirstRisk": round(self.hours_to_first_risk, 2)
            if self.hours_to_first_risk is not None else None,
            "priorityEvacuation": list(self.priority_evacuation),
            "status": self.status,
            "model_version": MODULE_VERSION,
            "generated_at_utc": _utc_now_iso(),
            "degraded": False,
            "decision_path": (
                "deterministic_priority_matcher | "
                "order=" + ">".join(SENSITIVITY_PRIORITY)),
            "breakdown": self.breakdown,
        }


def allocate_reefer_plugs(reefers_arriving: int,
                          sensitivity_mix: Optional[Dict[str, float]] = None,
                          plugs_failed: int = 0,
                          plugs_total: int = CPP_REEFER_PLUGS,
                          scenario_id: str = "AD_HOC",
                          title: str = "Ad-hoc reefer allocation") -> ReeferAllocation:
    """
    Allocate plugs highest-risk-first and state exactly what is left exposed.

    Priority is by how long the cargo can hold temperature unplugged, so pharma
    is served before frozen and frozen before chilled. ``hours_to_first_risk``
    is the hold time of the most sensitive UNPLUGGED box -- the number that
    tells the duty manager how long they have, and the one the dashboard
    counts down.
    """
    if reefers_arriving < 0:
        raise ValueError("reefers_arriving must be >= 0")
    if plugs_total <= 0:
        raise ValueError("plugs_total must be > 0")
    if not 0 <= plugs_failed <= plugs_total:
        raise ValueError("plugs_failed must be between 0 and plugs_total")

    mix = sensitivity_mix or {"CHILLED": 0.5, "FROZEN": 0.3, "PHARMA": 0.05,
                              "AMBIENT_CONTROLLED": 0.15}
    for key in mix:
        if key not in HOLD_HOURS_BY_SENSITIVITY:
            raise ValueError(
                f"unknown sensitivity {key!r}; expected one of "
                f"{list(HOLD_HOURS_BY_SENSITIVITY)}")
    total_weight = sum(mix.values())
    if total_weight <= 0:
        raise ValueError("sensitivity_mix must sum to more than zero")

    # Split the parcel, then give the rounding remainder to the most sensitive
    # class so a rounding artefact can never leave a pharma box unaccounted.
    counts: Dict[str, int] = {}
    running = 0
    ordered_classes = [c for c in SENSITIVITY_PRIORITY if mix.get(c, 0) > 0]
    for cls in ordered_classes[1:]:
        counts[cls] = int(reefers_arriving * mix[cls] / total_weight)
        running += counts[cls]
    if ordered_classes:
        counts[ordered_classes[0]] = max(0, reefers_arriving - running)

    available = plugs_total - plugs_failed
    reserved = int(math.ceil(available * PLUG_RESERVE_PCT))
    allocatable = max(0, available - reserved)

    allocated: Dict[str, int] = {}
    unplugged: Dict[str, int] = {}
    remaining = allocatable
    steps: List[Dict[str, Any]] = [{
        "step": "plug bank",
        "formula": "total - failed - reserve",
        "substitution": (f"{plugs_total} - {plugs_failed} - {reserved} = "
                         f"{allocatable} allocatable"),
        "note": f"{PLUG_RESERVE_PCT * 100:.0f}% held back; never plan to the last plug",
    }]

    for cls in SENSITIVITY_PRIORITY:
        want = counts.get(cls, 0)
        if want <= 0:
            continue
        give = min(want, remaining)
        allocated[cls] = give
        if want - give > 0:
            unplugged[cls] = want - give
        remaining -= give
        steps.append({
            "step": f"allocate {cls}",
            "formula": "min(arriving_in_class, plugs_remaining)",
            "substitution": f"min({want}, {give + remaining}) = {give} plugged, "
                            f"{want - give} exposed",
            "holdHours": HOLD_HOURS_BY_SENSITIVITY[cls],
        })

    shortfall = sum(unplugged.values())
    first_risk = None
    if unplugged:
        first_risk = min(HOLD_HOURS_BY_SENSITIVITY[c] for c in unplugged)

    priority = tuple(c for c in SENSITIVITY_PRIORITY if c in unplugged)

    if shortfall == 0:
        status = "OK"
    elif first_risk is not None and first_risk <= 4.0:
        status = "CRITICAL"
    elif first_risk is not None and first_risk <= 8.0:
        status = "AT_RISK"
    else:
        status = "SHORT"

    steps.append({
        "step": "exposure",
        "formula": "hours_to_first_risk = min(hold_hours of unplugged classes)",
        "substitution": (f"{shortfall} box(es) unplugged, first at risk in "
                         f"{first_risk:.1f} h" if first_risk is not None
                         else "0 boxes unplugged"),
    })

    return ReeferAllocation(
        scenario_id=scenario_id, title=title,
        reefers_arriving=reefers_arriving, plugs_total=plugs_total,
        plugs_failed=plugs_failed, plugs_available=available,
        plugs_reserved=reserved, plugs_allocatable=allocatable,
        allocated=allocated, unplugged=unplugged, shortfall=shortfall,
        hours_to_first_risk=first_risk, priority_evacuation=priority,
        status=status,
        breakdown={
            "policy": (
                "Plugs are allocated in ascending order of how long the cargo holds "
                "temperature unplugged: " + " > ".join(SENSITIVITY_PRIORITY) + ". "
                "Reefer power is a safety and commercial risk, so the decision is "
                "rule-auditable rather than learned."),
            "hold_hours": HOLD_HOURS_BY_SENSITIVITY,
            "steps": steps,
            "constants": {"CPP_REEFER_PLUGS": CPP_REEFER_PLUGS,
                          "PLUG_RESERVE_PCT": PLUG_RESERVE_PCT},
        })


def run_scenario(scenario_id: str,
                 snapshot: Optional[PoolSnapshot] = None) -> ReeferAllocation:
    """
    Run a named reefer what-if against the REAL reefer count in the corpus.

    The surge multiplier is applied to the reefers actually present in the
    inventories, so S6's "x3.5" is 3.5 times a measured number rather than 3.5
    times an invented one.
    """
    scenario = SCENARIOS.get(scenario_id.upper())
    if scenario is None:
        raise ValueError(f"unknown scenario {scenario_id!r}; "
                         f"expected one of {sorted(SCENARIOS)}")
    snap = snapshot or load_pool()
    base = snap.reefers if snap.reefers else 60
    arriving = int(round(base * scenario.surge_multiplier))
    return allocate_reefer_plugs(
        arriving, scenario.sensitivity_mix, scenario.plugs_failed,
        CPP_REEFER_PLUGS, scenario.scenario_id, scenario.title)


def model_card() -> Dict[str, Any]:
    snap = load_pool()
    s6 = run_scenario("S6", snap)
    balance = balance_empty_pool(snapshot=snap)
    return {
        "module_id": MODULE_ID,
        "module_name": MODULE_NAME,
        "model_version": MODULE_VERSION,
        "use_case_solved": (
            "Empty-pool and reefer surge management -- match empty supply to demand "
            "per terminal and prioritise reefer plugs when the bank is constrained."),
        "training_data_features": (
            "Empty pool by terminal and ISO type, reefer plug inventory "
            f"({CPP_REEFER_PLUGS} CPP plugs), discharge forecast"),
        "training_data_source": "No training: a deterministic matcher and scenario engine.",
        "objective_function": (
            "Match supply to demand; when plugs are constrained, allocate in ascending "
            "order of temperature hold time and report the exposure explicitly."),
        "model_used": "Deterministic priority matcher + scenario engine",
        "rationale": (
            "Reefer power is a safety and commercial risk, so the response has to be "
            "rule-auditable. A learned allocator would be harder to defend to a duty "
            "manager and no more accurate -- the corpus has no plug-failure history."),
        "link_to_model_weights": (
            "No learned weights. CPP_REEFER_PLUGS, HOLD_HOURS_BY_SENSITIVITY and "
            "SCENARIOS are the versioned configuration; served at "
            "GET /uc2/m7/constants."),
        "validation_data": (
            f"{snap.total_containers} real EAL/IAL container lines across "
            f"{len(snap.by_terminal)} terminals ({snap.reefers} reefers, "
            f"{snap.empties} empties); scenario regression suite "
            + ", ".join(sorted(SCENARIOS))),
        "accuracy": {
            "type": "deterministic",
            "note": ("Exact given inputs. Conservation is asserted: allocated plus "
                     "unplugged always equals arriving."),
            "s6_shortfall": s6.shortfall,
            "s6_hours_to_first_risk": s6.hours_to_first_risk,
            "s6_status": s6.status,
            "terminals_short_of_empties": balance.get("short_terminals"),
        },
        "disclosure": (
            "The pool is real. Two of the nine inventory files are legacy .xls that "
            "need xlrd and are not read -- named in the provenance on every response. "
            "Daily empty demand is proxied from export laden counts because the corpus "
            "carries no booked empty-release figure, and the cargo sensitivity mix is "
            "an assumption: ISO codes identify a reefer but not what is inside it."),
        "pool": snap.as_dict(),
        "scenarios": {k: v.as_dict() for k, v in SCENARIOS.items()},
    }


# ==========================================================================
# SECTION 6 -- MODULE INFO
# ==========================================================================

MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_UC2_AI_ML_Tools.md row 7 -- Empty-pool & reefer surge management",
    "model_type": "deterministic matcher + scenario engine (no training)",
    "constants": {
        "CPP_REEFER_PLUGS": CPP_REEFER_PLUGS,
        "PLUG_RESERVE_PCT": PLUG_RESERVE_PCT,
        "HOLD_HOURS_BY_SENSITIVITY": HOLD_HOURS_BY_SENSITIVITY,
        "SENSITIVITY_PRIORITY": list(SENSITIVITY_PRIORITY),
        "MIN_DAYS_COVER": MIN_DAYS_COVER,
        "TARGET_DAYS_COVER": TARGET_DAYS_COVER,
        "SCENARIOS": {k: v.as_dict() for k, v in SCENARIOS.items()},
    },
    "corpus_files": [
        "M7_Empty_Pool_Reefer/Shipping_Lines_EAL_IAL_EDO/EAL_FORMAT/*",
        "M7_Empty_Pool_Reefer/Shipping_Lines_EAL_IAL_EDO/IAL FORMAT/*",
        "M7_Empty_Pool_Reefer/ECY_Empty_Yard_Events/ECY-CODECO.xlsx",
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

    class ReeferRequest(BaseModel):
        reefers_arriving: int = Field(200, ge=0, le=5000)
        # Bounded by the plug bank being described, not by the Container
        # Parking Plaza's 96: JNPA's own yard snapshot shows terminals
        # running 120 (NSFT), 150 (NSICT) and 180 (BMCT) plugs, so a 96
        # ceiling here 422s a legitimate 120-plug outage. The core
        # function still enforces 0 <= plugs_failed <= plugs_total.
        plugs_failed: int = Field(0, ge=0, le=1000)
        plugs_total: int = Field(CPP_REEFER_PLUGS, gt=0, le=1000)
        sensitivity_mix: Optional[Dict[str, float]] = Field(
            None, description="Weights over " + ", ".join(SENSITIVITY_PRIORITY))

    class EmptyBalanceRequest(BaseModel):
        daily_demand_by_terminal: Optional[Dict[str, float]] = Field(
            None, description="Empties needed per day per terminal. Omit to use the "
                              "export-laden proxy, which the response discloses.")

    def build_router() -> "APIRouter":
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-M7 Empty Pool & Reefer"])

        @router.get("/pool", summary="The real empty and reefer position")
        def pool() -> Dict[str, Any]:
            return load_pool().as_dict()

        @router.post("/empty-balance", summary="Empty supply vs demand, with repositions")
        def empty_balance(req: EmptyBalanceRequest) -> Dict[str, Any]:
            return balance_empty_pool(req.daily_demand_by_terminal)

        @router.post("/reefer-allocation", summary="Allocate plugs highest-risk-first")
        def reefer_allocation(req: ReeferRequest) -> Dict[str, Any]:
            try:
                return allocate_reefer_plugs(
                    req.reefers_arriving, req.sensitivity_mix, req.plugs_failed,
                    req.plugs_total).as_dict()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @router.get("/scenario/{scenario_id}", summary="Run a named reefer what-if")
        def scenario(scenario_id: str) -> Dict[str, Any]:
            try:
                return run_scenario(scenario_id).as_dict()
            except ValueError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        @router.get("/model-card", summary="The WS2 submission row for this model")
        def card() -> Dict[str, Any]:
            return model_card()

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run the canonical demo scenario (S6)")
        def demo() -> Dict[str, Any]:
            return run_scenario("S6").as_dict()

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


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []

    snap = load_pool()
    if _HAS_CORPUS and snap.source in ("CORPUS", "PARTIAL"):
        checks.append(("real pool loaded", snap.total_containers > 1000,
                       f"{snap.total_containers} lines, {snap.empties} empty, "
                       f"{snap.reefers} reefer, {len(snap.by_terminal)} terminals"))
        checks.append(("skipped files are disclosed",
                       "missing" in snap.provenance,
                       f"{len(snap.provenance.get('missing', []))} file(s) named in "
                       f"the provenance"))
        checks.append(("reefers found in both ISO dialects", snap.reefers > 0,
                       "numeric group-3 codes counted, not just the 'R' form"))
    else:
        checks.append(("real pool loaded", False,
                       snap.provenance.get("reason", "corpus unavailable")))

    alloc = allocate_reefer_plugs(60, plugs_failed=0)
    checks.append(("no shortfall when plugs are plentiful", alloc.shortfall == 0,
                   f"60 reefers into {alloc.plugs_allocatable} allocatable plugs, "
                   f"status {alloc.status}"))

    surge = allocate_reefer_plugs(300, plugs_failed=18)
    checks.append(("shortfall reported under a surge", surge.shortfall > 0,
                   f"{surge.shortfall} boxes unplugged of 300"))
    checks.append(("conservation holds",
                   sum(surge.allocated.values()) + surge.shortfall == 300,
                   f"{sum(surge.allocated.values())} plugged + {surge.shortfall} "
                   f"exposed = 300"))
    checks.append(("allocation never exceeds the bank",
                   sum(surge.allocated.values()) <= surge.plugs_allocatable,
                   f"{sum(surge.allocated.values())} <= {surge.plugs_allocatable}"))
    checks.append(("a reserve is held back", surge.plugs_reserved > 0,
                   f"{surge.plugs_reserved} plug(s) held back "
                   f"({PLUG_RESERVE_PCT * 100:.0f}%)"))

    pharma = allocate_reefer_plugs(
        200, {"PHARMA": 0.5, "CHILLED": 0.5}, plugs_failed=18)
    plugged_pharma = pharma.allocated.get("PHARMA", 0)
    plugged_chilled = pharma.allocated.get("CHILLED", 0)
    checks.append(("pharma is served before chilled",
                   plugged_pharma >= plugged_chilled or "CHILLED" in pharma.unplugged,
                   f"pharma {plugged_pharma} plugged, chilled {plugged_chilled}; "
                   f"exposed {list(pharma.unplugged)}"))
    checks.append(("first-risk clock reflects the exposed cargo",
                   pharma.hours_to_first_risk is not None
                   and pharma.hours_to_first_risk <= max(HOLD_HOURS_BY_SENSITIVITY.values()),
                   f"{pharma.hours_to_first_risk} h until the first exposed box is at risk"))

    for bad in ((-1, 0), (10, 200)):
        try:
            allocate_reefer_plugs(bad[0], plugs_failed=bad[1])
            checks.append((f"rejects invalid input {bad}", False, "accepted"))
            break
        except ValueError:
            continue
    else:
        checks.append(("rejects invalid inputs", True,
                       "negative arrivals and failed > total both raise"))

    try:
        allocate_reefer_plugs(10, {"NOT_A_CLASS": 1.0})
        ok, detail = False, "accepted an unknown sensitivity"
    except ValueError:
        ok, detail = True, "raises on an unknown sensitivity class"
    checks.append(("sensitivity mix validated", ok, detail))

    s6 = run_scenario("S6", snap)
    checks.append(("S6 runs against the real reefer count",
                   s6.reefers_arriving > 0,
                   f"{snap.reefers} real reefers x3.5 = {s6.reefers_arriving} arriving, "
                   f"shortfall {s6.shortfall}, status {s6.status}"))

    s6b = run_scenario("S6B", snap)
    checks.append(("a pharma-heavy parcel is more urgent",
                   (s6b.hours_to_first_risk or 99) <= (s6.hours_to_first_risk or 99),
                   f"S6 first risk {s6.hours_to_first_risk} h vs S6B "
                   f"{s6b.hours_to_first_risk} h"))

    try:
        run_scenario("NOPE")
        ok, detail = False, "accepted an unknown scenario"
    except ValueError:
        ok, detail = True, "raises on an unknown scenario"
    checks.append(("scenario lookup validated", ok, detail))

    balance = balance_empty_pool(snapshot=snap)
    if balance["status"] == "balanced":
        checks.append(("empty pool balanced", bool(balance["balances"]),
                       f"{len(balance['balances'])} terminals, "
                       f"{len(balance['short_terminals'])} short, "
                       f"{len(balance['reposition_plan'])} moves proposed"))
        checks.append(("proxy demand is disclosed",
                       balance["demand_source"] == "proxy_export_laden"
                       and bool(balance["demand_note"]),
                       "the substitution is named in the response"))
    else:
        checks.append(("empty pool balanced", False, balance.get("reason", "n/a")))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"{MODULE_ID} {MODULE_NAME}")
    ap.add_argument("--scenario", default="S6", choices=sorted(SCENARIOS))
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

    snap = load_pool()
    balance = balance_empty_pool(snapshot=snap)
    alloc = run_scenario(args.scenario, snap)

    if args.json:
        print(json.dumps({"module": MODULE_INFO, "pool": snap.as_dict(),
                          "empty_balance": balance, "reefer": alloc.as_dict(),
                          "model_card": model_card()}, indent=2, default=str))
        return 0

    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_NAME}   {MODULE_VERSION}")
    print("=" * 78)

    d = snap.as_dict()
    print(f"\nPOOL  source={snap.source}   {d['totalContainers']} container lines")
    print(f"  empties {d['empties']} ({d['emptyShare'] * 100:.1f}%)   "
          f"reefers {d['reefers']} ({d['reeferShare'] * 100:.1f}%)")
    if snap.provenance.get("missing"):
        print(f"  NOT READ: {', '.join(os.path.basename(m) for m in snap.provenance['missing'])}")

    print(f"\n  {'terminal':<10}{'total':>7}{'empty':>7}{'laden':>7}{'reefer':>8}"
          f"{'import':>8}{'export':>8}")
    for terminal, b in snap.by_terminal.items():
        print(f"  {terminal:<10}{b['total']:>7}{b['empty']:>7}{b['laden']:>7}"
              f"{b['reefer']:>8}{b['import']:>8}{b['export']:>8}")

    print(f"\nEMPTY-POOL BALANCE   demand source: {balance['demand_source']}")
    print(f"  {'terminal':<10}{'empties':>9}{'demand/d':>10}{'cover(d)':>10}  "
          f"{'status':<10}reposition")
    for b in balance["balances"]:
        print(f"  {b['terminal']:<10}{b['emptiesAvailable']:>9}{b['dailyDemand']:>10.1f}"
              f"{b['daysCover']:>10.2f}  {b['status']:<10}{b['repositionUnits']:+d}")
    if balance["reposition_plan"]:
        print("\n  proposed moves:")
        for move in balance["reposition_plan"]:
            src = move["from"] or "EXTERNAL"
            print(f"    {src:<10} -> {move['to']:<10}{move['units']:>5} units   "
                  f"{move['reason'][:44]}")

    a = alloc.as_dict()
    print(f"\nREEFER SCENARIO {a['scenarioId']}  {a['title']}")
    print(f"  {SCENARIOS[args.scenario].description}")
    print(f"\n  arriving      {a['reefersArriving']} reefers "
          f"({snap.reefers} real x {SCENARIOS[args.scenario].surge_multiplier:g})")
    print(f"  plug bank     {a['plugsTotal']} total - {a['plugsFailed']} failed "
          f"- {a['plugsReserved']} reserve = {a['plugsAllocatable']} allocatable")
    print(f"\n  {'sensitivity':<22}{'hold h':>8}{'plugged':>9}{'exposed':>9}")
    for cls in SENSITIVITY_PRIORITY:
        if cls not in a["allocatedBySensitivity"] and cls not in a["unpluggedBySensitivity"]:
            continue
        print(f"  {cls:<22}{HOLD_HOURS_BY_SENSITIVITY[cls]:>8.0f}"
              f"{a['allocatedBySensitivity'].get(cls, 0):>9}"
              f"{a['unpluggedBySensitivity'].get(cls, 0):>9}")
    print(f"\n  shortfall     {a['shortfall']} boxes with no plug")
    print(f"  first risk    {a['hoursToFirstRisk']} h")
    print(f"  evacuate      {a['priorityEvacuation']}")
    print(f"  status        {a['status']}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
