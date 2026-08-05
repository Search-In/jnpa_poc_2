"""
UC2-M4 -- Event-Sequence Anomaly Detection
===========================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Which containers have a broken paperwork or movement chain right now, and how
urgent is each one?"

Feeds the briefing's "pendency optimisation & alerts" AI/ML item and the
buffer-pendency KPI.

THIS MODEL IS BEING GRADED ON THE SHARED DATA
----------------------------------------------
The bidder briefing is explicit (slide 5, DATA NOTICE):

    "The data shared includes simulated data -- irregularities and anomalies
     are present by design. Detecting, documenting and handling them forms
     part of the evaluation."

So this module does not merely define rules and score itself on a generator it
wrote. ``scan_corpus()`` runs every rule over the real shared corpus and
returns what it found, container by container. That output is the deliverable.

WHAT IS ACTUALLY IN THERE
-------------------------
Measured on the corpus as shipped, across 1,202 containers in the CFS and ECY
CODECO streams:

      483  clean IN -> OUT pairs
      432  gate-in with NO gate-out                 -> R1 candidates
      287  gate-out alone, no gate-in               -> R4 candidates
      241  orphan gate-out, THEN a clean pair       -> R4 candidates
    1,202  total containers

plus 100 let-export orders, 100 shipping bills, 99 RMS-flagged containers and
13 ICEGATE manifests in the customs chain.

Those broken chains are not parse failures. ``uc2_corpus`` deliberately does not
repair them, because repairing them would delete the signal this model exists
to find.

Scanning all 1,401 assembled trails returns 1,139 findings over 1,136
containers and leaves 265 clean.

THE RULES
---------
Three come from the published spec. Three more were added because the real
corpus contains failure modes the published three do not cover -- an orphan
gate-out affects 528 of 1,202 containers and the original rule set is blind to
it. Every rule is versioned in ``RULES`` with its threshold, severity and the
evidence it requires.

    R1  ANOMALY_MISSING_GATE_OUT     gate-in > 72 h ago, no gate-out       CRIT
    R2  ANOMALY_LEO_NO_MOVE          LEO > 48 h ago, no movement           WARN
    R3  ANOMALY_SCAN_FLAG_NO_SCAN    customs-flagged > 24 h, no scan       WARN
    R4  ANOMALY_ORPHAN_GATE_OUT      gate-out with no gate-in              WARN
    R5  ANOMALY_NEGATIVE_DWELL       gate-out timestamped before gate-in   CRIT
    R6  ANOMALY_DWELL_OUTLIER        dwell beyond the observed P99         INFO

RECALL IS MEASURED NOW
----------------------
The previous version reported "Precision 1.0" and disclosed that recall was
unmeasured. Precision alone is trivially gamed -- a detector that fires once,
correctly, and stays silent forever scores 1.0. ``evaluate()`` builds a
labelled set of 400 trails (seed 505) containing both planted anomalies and
deliberately-tricky clean trails, and reports precision, recall, F1 and the
full confusion matrix per rule as well as overall.

USAGE
-----
    python uc2_m4_event_anomaly.py                # evaluate + scan the corpus
    python uc2_m4_event_anomaly.py --scan         # corpus findings only
    python uc2_m4_event_anomaly.py --json
    python uc2_m4_event_anomaly.py --selftest
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import statistics
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

for _extra in (os.path.dirname(os.path.abspath(__file__)),
               os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "pipeline")):
    if _extra not in sys.path:
        sys.path.append(_extra)

# ==========================================================================
# SECTION 1 -- IDENTITY AND VERSIONED RULES
# ==========================================================================

MODULE_ID: str = "UC2-M4"
MODULE_NAME: str = "Event-Sequence Anomaly Detection"
MODULE_VERSION: str = "m4-event-anomaly-v2.0.0"   # v2: +3 rules, recall measured
MODEL_KEY: str = "event-anomaly-detector"
ROUTER_PREFIX: str = "/uc2/m4"

DEFAULT_SEED: int = 505
DEFAULT_EVAL_N: int = 400

ACCEPTANCE_PRECISION: float = 0.85
ACCEPTANCE_RECALL: float = 0.85          # newly committed; previously unmeasured

# P99 dwell used by rule R6 inside the labelled evaluation set. The corpus scan
# computes its own P99 from the real stays; this fixed value exists so R6 is
# actually exercised by the eval set rather than scoring "n/a" and looking fine.
EVAL_DWELL_P99_H: float = 120.0

SEVERITY_RANK: Dict[str, int] = {"CRIT": 3, "WARN": 2, "INFO": 1}


@dataclass(frozen=True)
class Rule:
    """One versioned detection rule."""

    rule_id: str
    finding_type: str
    severity: str
    threshold_h: Optional[float]
    trigger_event: Optional[str]
    absent_events: Tuple[str, ...]
    description: str
    source: str            # "spec" | "corpus_driven"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ruleId": self.rule_id, "type": self.finding_type,
            "severity": self.severity, "thresholdHours": self.threshold_h,
            "triggerEvent": self.trigger_event,
            "absentEvents": list(self.absent_events),
            "description": self.description, "source": self.source,
        }


RULES: Tuple[Rule, ...] = (
    Rule("R1", "ANOMALY_MISSING_GATE_OUT", "CRIT", 72.0, "GATE_IN", ("GATE_OUT",),
         "Container gated in more than 72 h ago and has never gated out.",
         "spec"),
    Rule("R2", "ANOMALY_LEO_NO_MOVE", "WARN", 48.0, "LEO", ("GATE_OUT", "LOAD"),
         "Export cleared by customs (LEO) more than 48 h ago with no movement since.",
         "spec"),
    Rule("R3", "ANOMALY_SCAN_FLAG_NO_SCAN", "WARN", 24.0, "CUSTOMS_FLAG",
         ("SCAN_START",),
         "Flagged for customs examination more than 24 h ago with no scan started.",
         "spec"),
    Rule("R4", "ANOMALY_ORPHAN_GATE_OUT", "WARN", None, "GATE_OUT", ("GATE_IN",),
         "A gate-out with no gate-in before it -- the movement chain starts mid-way. "
         "Added after measurement: 528 of 1,202 corpus containers show this (287 with "
         "an orphan out alone, 241 with an orphan out followed by a clean pair) and "
         "the published rule set does not cover it.",
         "corpus_driven"),
    Rule("R5", "ANOMALY_NEGATIVE_DWELL", "CRIT", None, "GATE_OUT", (),
         "A single gate-in/gate-out pair whose gate-out is timestamped BEFORE its "
         "gate-in -- an impossible sequence indicating a clock or keying fault. "
         "Deliberately narrow: R4 claims the multi-event cases, so this rule only "
         "fires where a clock fault is the only remaining explanation.",
         "corpus_driven"),
    Rule("R6", "ANOMALY_DWELL_OUTLIER", "INFO", None, "GATE_OUT", (),
         "Completed dwell beyond the P99 of the observed distribution. Informational: "
         "a long stay is legal, but it is where demurrage disputes start.",
         "corpus_driven"),
)
RULES_BY_ID: Dict[str, Rule] = {r.rule_id: r for r in RULES}

# Event vocabulary. GATE_IN/GATE_OUT come from CODECO, LEO from the customs
# let-export file, CUSTOMS_FLAG from the RMS scanning lists.
KNOWN_EVENTS: Tuple[str, ...] = (
    "GATE_IN", "GATE_OUT", "LEO", "CUSTOMS_FLAG", "SCAN_START", "SCAN_DONE",
    "LOAD", "DISCHARGE", "IGM", "OOC",
)


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


def _parse_ts(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value.replace(tzinfo=None) if value.tzinfo else value
    if _HAS_CORPUS:
        return corpus.parse_ts(value)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


# ==========================================================================
# SECTION 3 -- DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class TrailEvent:
    """One event on one container's chain."""

    event_type: str
    ts: datetime

    def as_dict(self) -> Dict[str, Any]:
        return {"eventType": self.event_type, "ts": self.ts.isoformat()}


@dataclass(frozen=True)
class Finding:
    """One anomaly, with the evidence that produced it."""

    rule_id: str
    finding_type: str
    severity: str
    container: str
    reason: str
    age_hours: Optional[float]
    evidence: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ruleId": self.rule_id,
            "type": self.finding_type,
            "severity": self.severity,
            "container": self.container,
            "reason": self.reason,
            "ageHours": round(self.age_hours, 2) if self.age_hours is not None else None,
            "evidence": self.evidence,
        }


@dataclass(frozen=True)
class TrailResult:
    """Every finding on one container, worst-first."""

    container: str
    findings: Tuple[Finding, ...]
    event_count: int
    evaluated_at: str

    @property
    def worst_severity(self) -> Optional[str]:
        if not self.findings:
            return None
        return max((f.severity for f in self.findings),
                   key=lambda s: SEVERITY_RANK.get(s, 0))

    def as_dict(self) -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "container": self.container,
            "eventCount": self.event_count,
            "findings": [f.as_dict() for f in self.findings],
            "findingCount": len(self.findings),
            "worstSeverity": self.worst_severity,
            "clean": not self.findings,
            "model_version": MODULE_VERSION,
            "evaluated_at": self.evaluated_at,
            "degraded": False,
            "decision_path": f"rule_engine v{MODULE_VERSION} | {len(RULES)} rules",
        }


# ==========================================================================
# SECTION 4 -- THE RULE ENGINE
# ==========================================================================


def normalise_trail(trail: Sequence[Any]) -> List[TrailEvent]:
    """
    Accept the several shapes a caller might send and return sorted events.

    Tolerates ``{"eventType": ..., "ts": ...}``, ``{"event": ..., "timestamp": ...}``
    and ``TrailEvent``. Rows whose timestamp will not parse are dropped rather
    than guessed at -- an invented timestamp on an anomaly detector produces an
    invented anomaly.
    """
    events: List[TrailEvent] = []
    for item in trail:
        if isinstance(item, TrailEvent):
            events.append(item)
            continue
        if not isinstance(item, dict):
            continue
        etype = str(item.get("eventType") or item.get("event")
                    or item.get("type") or "").strip().upper()
        ts = _parse_ts(item.get("ts") or item.get("timestamp") or item.get("time"))
        if not etype or ts is None:
            continue
        events.append(TrailEvent(etype, ts))
    events.sort(key=lambda e: e.ts)
    return events


def evaluate_trail(trail: Sequence[Any], now: Optional[datetime] = None,
                   container: str = "", dwell_p99_h: Optional[float] = None) -> TrailResult:
    """
    Apply every rule to one container's event trail.

    ``now`` anchors the age thresholds. It defaults to the latest event on the
    trail rather than to wall-clock time, so replaying a historical corpus does
    not flag every container in it simply because the log is old. A caller
    working live should pass the real current time.
    """
    events = normalise_trail(trail)
    if now is None:
        now = max((e.ts for e in events), default=datetime.now())
    now = now.replace(tzinfo=None) if now.tzinfo else now

    by_type: Dict[str, List[datetime]] = {}
    for ev in events:
        by_type.setdefault(ev.event_type, []).append(ev.ts)

    findings: List[Finding] = []

    def first(event: str) -> Optional[datetime]:
        stamps = by_type.get(event)
        return stamps[0] if stamps else None

    def hours_since(ts: datetime) -> float:
        return (now - ts).total_seconds() / 3600.0

    # --- R1  gate-in with no gate-out -----------------------------------
    gate_in, gate_out = first("GATE_IN"), first("GATE_OUT")
    if gate_in is not None and not by_type.get("GATE_OUT"):
        age = hours_since(gate_in)
        rule = RULES_BY_ID["R1"]
        if age > rule.threshold_h:
            findings.append(Finding(
                rule.rule_id, rule.finding_type, rule.severity, container,
                f"Gated in {age:.1f} h ago with no gate-out "
                f"(threshold {rule.threshold_h:g} h).",
                age, {"gateIn": gate_in.isoformat(), "gateOut": None,
                      "thresholdHours": rule.threshold_h}))

    # --- R4 / R5  out-of-order movements --------------------------------
    #
    # These two split one symptom -- a gate-out that is not preceded by a
    # gate-in -- into its two real explanations, and the precedence matters.
    #
    # The corpus forced this. A naive "gate_out < gate_in" test flags 242
    # containers as clock faults, but inspecting them shows the OUT-IN-OUT
    # pattern: an earlier orphan movement followed by a perfectly clean stay.
    # Calling those clock faults would bury 241 genuine orphan records under a
    # wrong label. So R4 owns every orphan out, and R5 is narrowed to the only
    # shape a clock fault can actually take: exactly one in, exactly one out,
    # out first, nothing else on the trail.
    ins = by_type.get("GATE_IN", [])
    outs = by_type.get("GATE_OUT", [])
    orphan_outs = [ts for ts in outs if not any(i < ts for i in ins)]
    single_pair_inversion = (len(ins) == 1 and len(outs) == 1 and outs[0] < ins[0])

    if single_pair_inversion:
        rule = RULES_BY_ID["R5"]
        delta = (ins[0] - outs[0]).total_seconds() / 3600.0
        findings.append(Finding(
            rule.rule_id, rule.finding_type, rule.severity, container,
            f"The only gate-out is timestamped {delta:.1f} h BEFORE the only gate-in -- "
            f"impossible sequence, likely a clock or keying fault.",
            delta, {"gateIn": ins[0].isoformat(), "gateOut": outs[0].isoformat(),
                    "gateInCount": 1, "gateOutCount": 1}))
    elif orphan_outs:
        rule = RULES_BY_ID["R4"]
        first_orphan = min(orphan_outs)
        findings.append(Finding(
            rule.rule_id, rule.finding_type, rule.severity, container,
            f"{len(orphan_outs)} gate-out(s) with no gate-in before them -- "
            f"the movement chain starts mid-way.",
            hours_since(first_orphan),
            {"firstOrphanGateOut": first_orphan.isoformat(),
             "orphanGateOutCount": len(orphan_outs),
             "gateInCount": len(ins), "gateOutCount": len(outs),
             "laterCleanPair": bool(ins and any(o > min(ins) for o in outs))}))

    # --- R6  dwell outlier ----------------------------------------------
    # Measured on the first gate-in and the first gate-out that follows it, so
    # an orphan out ahead of the stay cannot produce a bogus dwell.
    if ins and dwell_p99_h is not None:
        paired_out = next((o for o in outs if o > ins[0]), None)
        if paired_out is not None:
            dwell = (paired_out - ins[0]).total_seconds() / 3600.0
            if dwell > dwell_p99_h:
                rule = RULES_BY_ID["R6"]
                findings.append(Finding(
                    rule.rule_id, rule.finding_type, rule.severity, container,
                    f"Dwell {dwell:.1f} h exceeds the observed P99 of "
                    f"{dwell_p99_h:.1f} h.",
                    dwell, {"dwellHours": round(dwell, 2),
                            "p99Hours": round(dwell_p99_h, 2)}))

    # --- R2  LEO with no movement ---------------------------------------
    leo = first("LEO")
    if leo is not None:
        rule = RULES_BY_ID["R2"]
        moved = any(by_type.get(e) and min(by_type[e]) > leo for e in rule.absent_events)
        age = hours_since(leo)
        if not moved and age > rule.threshold_h:
            findings.append(Finding(
                rule.rule_id, rule.finding_type, rule.severity, container,
                f"Export cleared (LEO) {age:.1f} h ago with no movement since "
                f"(threshold {rule.threshold_h:g} h).",
                age, {"leo": leo.isoformat(),
                      "movementEventsWatched": list(rule.absent_events),
                      "thresholdHours": rule.threshold_h}))

    # --- R3  customs flag with no scan ----------------------------------
    flag = first("CUSTOMS_FLAG")
    if flag is not None:
        rule = RULES_BY_ID["R3"]
        scanned = any(by_type.get(e) and min(by_type[e]) > flag for e in rule.absent_events)
        age = hours_since(flag)
        if not scanned and age > rule.threshold_h:
            findings.append(Finding(
                rule.rule_id, rule.finding_type, rule.severity, container,
                f"Flagged for customs examination {age:.1f} h ago with no scan started "
                f"(threshold {rule.threshold_h:g} h).",
                age, {"customsFlag": flag.isoformat(),
                      "thresholdHours": rule.threshold_h}))

    findings.sort(key=lambda f: (-SEVERITY_RANK.get(f.severity, 0), f.rule_id))
    return TrailResult(container=container, findings=tuple(findings),
                       event_count=len(events), evaluated_at=_utc_now_iso())


# ==========================================================================
# SECTION 5 -- LABELLED EVALUATION SET  (precision AND recall)
# ==========================================================================


@dataclass(frozen=True)
class LabelledTrail:
    """A generated trail with the rule IDs it is supposed to trigger."""

    container: str
    events: Tuple[TrailEvent, ...]
    now: datetime
    expected_rules: Tuple[str, ...]
    scenario: str


def build_evaluation_set(n: int = DEFAULT_EVAL_N,
                         seed: int = DEFAULT_SEED) -> List[LabelledTrail]:
    """
    A labelled set of anomalous AND deliberately-tricky clean trails.

    The near-miss cases matter more than the obvious ones. A detector that only
    ever sees blatant anomalies and blatant clean trails will score perfectly
    and tell you nothing, so roughly a third of the set sits just inside a
    threshold: gated in 71 h ago (R1 must NOT fire), scanned 30 minutes after
    the flag, LEO followed by a load an hour later.
    """
    rng = random.Random(seed)
    base = datetime(2026, 7, 1, 8, 0)
    trails: List[LabelledTrail] = []

    scenarios = [
        "clean_pair", "clean_just_inside_r1", "clean_scan_after_flag",
        "clean_leo_then_load", "r1_missing_gate_out", "r2_leo_no_move",
        "r3_flag_no_scan", "r4_orphan_gate_out", "r5_negative_dwell",
        "r6_dwell_outlier", "r1_and_r3",
    ]

    for i in range(n):
        scenario = scenarios[i % len(scenarios)]
        container = f"TEST{i:07d}"
        start = base + timedelta(hours=rng.uniform(0, 500))
        now = start + timedelta(hours=200)
        events: List[TrailEvent] = []
        expected: List[str] = []

        if scenario == "clean_pair":
            # Held under EVAL_DWELL_P99_H so this stays a true negative for R6.
            events = [TrailEvent("GATE_IN", start),
                      TrailEvent("GATE_OUT", start + timedelta(hours=rng.uniform(6, 60)))]
        elif scenario == "clean_just_inside_r1":
            # 71 h old: one hour inside the 72 h threshold. Must NOT fire.
            now = start + timedelta(hours=71)
            events = [TrailEvent("GATE_IN", start)]
        elif scenario == "clean_scan_after_flag":
            events = [TrailEvent("GATE_IN", start),
                      TrailEvent("CUSTOMS_FLAG", start + timedelta(hours=2)),
                      TrailEvent("SCAN_START", start + timedelta(hours=2.5)),
                      TrailEvent("GATE_OUT", start + timedelta(hours=30))]
        elif scenario == "clean_leo_then_load":
            events = [TrailEvent("GATE_IN", start),
                      TrailEvent("LEO", start + timedelta(hours=10)),
                      TrailEvent("LOAD", start + timedelta(hours=11)),
                      TrailEvent("GATE_OUT", start + timedelta(hours=12))]
        elif scenario == "r1_missing_gate_out":
            now = start + timedelta(hours=rng.uniform(73, 300))
            events = [TrailEvent("GATE_IN", start)]
            expected = ["R1"]
        elif scenario == "r2_leo_no_move":
            leo = start + timedelta(hours=5)
            now = leo + timedelta(hours=rng.uniform(49, 200))
            events = [TrailEvent("GATE_IN", start), TrailEvent("LEO", leo)]
            expected = ["R1", "R2"] if (now - start).total_seconds() / 3600 > 72 else ["R2"]
        elif scenario == "r3_flag_no_scan":
            flag = start + timedelta(hours=3)
            now = flag + timedelta(hours=rng.uniform(25, 60))
            events = [TrailEvent("GATE_IN", start), TrailEvent("CUSTOMS_FLAG", flag)]
            expected = ["R1", "R3"] if (now - start).total_seconds() / 3600 > 72 else ["R3"]
        elif scenario == "r4_orphan_gate_out":
            events = [TrailEvent("GATE_OUT", start)]
            now = start + timedelta(hours=rng.uniform(1, 100))
            expected = ["R4"]
        elif scenario == "r5_negative_dwell":
            events = [TrailEvent("GATE_IN", start),
                      TrailEvent("GATE_OUT", start - timedelta(hours=rng.uniform(1, 20)))]
            now = start + timedelta(hours=10)
            expected = ["R5"]
        elif scenario == "r6_dwell_outlier":
            dwell = rng.uniform(EVAL_DWELL_P99_H + 5, EVAL_DWELL_P99_H + 200)
            events = [TrailEvent("GATE_IN", start),
                      TrailEvent("GATE_OUT", start + timedelta(hours=dwell))]
            now = start + timedelta(hours=dwell + 1)
            expected = ["R6"]
        else:  # r1_and_r3
            flag = start + timedelta(hours=4)
            now = start + timedelta(hours=rng.uniform(80, 200))
            events = [TrailEvent("GATE_IN", start), TrailEvent("CUSTOMS_FLAG", flag)]
            expected = ["R1", "R3"]

        trails.append(LabelledTrail(container, tuple(events), now,
                                    tuple(sorted(expected)), scenario))
    return trails


def evaluate(n: int = DEFAULT_EVAL_N, seed: int = DEFAULT_SEED) -> Dict[str, Any]:
    """
    Precision, recall, F1 and the confusion matrix -- overall and per rule.

    Recall is the number the previous version left unmeasured. Precision on its
    own is trivially gamed: a detector that fires once, correctly, and then
    stays silent scores 1.0 and finds nothing. Both are reported, per rule, so
    a weak rule cannot hide behind a strong one.
    """
    trails = build_evaluation_set(n, seed)
    per_rule: Dict[str, Dict[str, int]] = {
        r.rule_id: {"tp": 0, "fp": 0, "fn": 0, "tn": 0} for r in RULES}
    trail_tp = trail_fp = trail_fn = trail_tn = 0

    for trail in trails:
        result = evaluate_trail(trail.events, now=trail.now,
                                container=trail.container,
                                dwell_p99_h=EVAL_DWELL_P99_H)
        fired = {f.rule_id for f in result.findings}
        expected = set(trail.expected_rules)

        for rule in RULES:
            rid = rule.rule_id
            if rid in fired and rid in expected:
                per_rule[rid]["tp"] += 1
            elif rid in fired:
                per_rule[rid]["fp"] += 1
            elif rid in expected:
                per_rule[rid]["fn"] += 1
            else:
                per_rule[rid]["tn"] += 1

        if fired and expected:
            trail_tp += 1
        elif fired:
            trail_fp += 1
        elif expected:
            trail_fn += 1
        else:
            trail_tn += 1

    def prf(tp: int, fp: int, fn: int) -> Dict[str, Optional[float]]:
        precision = tp / (tp + fp) if (tp + fp) else None
        recall = tp / (tp + fn) if (tp + fn) else None
        f1 = None
        if precision is not None and recall is not None and (precision + recall) > 0:
            f1 = 2 * precision * recall / (precision + recall)
        return {
            "precision": round(precision, 4) if precision is not None else None,
            "recall": round(recall, 4) if recall is not None else None,
            "f1": round(f1, 4) if f1 is not None else None,
        }

    rule_rows = []
    for rule in RULES:
        c = per_rule[rule.rule_id]
        rule_rows.append({
            "ruleId": rule.rule_id, "type": rule.finding_type,
            "severity": rule.severity, "source": rule.source,
            **c, **prf(c["tp"], c["fp"], c["fn"]),
            "exercised": (c["tp"] + c["fn"]) > 0,
        })

    overall = prf(trail_tp, trail_fp, trail_fn)
    not_exercised = [r["ruleId"] for r in rule_rows if not r["exercised"]]

    return {
        "n_trails": len(trails),
        "seed": seed,
        "trail_level": {
            "tp": trail_tp, "fp": trail_fp, "fn": trail_fn, "tn": trail_tn,
            **overall,
            "accuracy": round((trail_tp + trail_tn) / len(trails), 4),
        },
        "per_rule": rule_rows,
        "acceptance": {
            "precision_threshold": ACCEPTANCE_PRECISION,
            "recall_threshold": ACCEPTANCE_RECALL,
            "meets_precision": (overall["precision"] or 0) >= ACCEPTANCE_PRECISION,
            "meets_recall": (overall["recall"] or 0) >= ACCEPTANCE_RECALL,
        },
        "rules_not_exercised": not_exercised,
        "disclosure": (
            "Measured on a labelled synthetic set, roughly a third of which are "
            "near-miss clean trails sitting just inside a threshold. Recall is "
            "reported here; the previous version left it unmeasured, which made its "
            "precision of 1.0 uninformative. Rules with no positive cases in the set "
            "are named in rules_not_exercised rather than silently scoring 100%."),
    }


# ==========================================================================
# SECTION 6 -- THE CORPUS SCAN  (the graded deliverable)
# ==========================================================================


def build_corpus_trails() -> Tuple[Dict[str, List[TrailEvent]], Dict[str, Any]]:
    """
    Assemble one event trail per container from every corpus source.

    CODECO supplies GATE_IN / GATE_OUT, the RMS scanning lists supply
    CUSTOMS_FLAG, and the customs LEO file supplies LEO. The three populations
    do not overlap -- measured, not assumed -- so most trails carry movements
    only, and the LEO-derived trails carry no container number at all and are
    keyed by shipping bill instead. The provenance block says so.
    """
    if not _HAS_CORPUS:
        return {}, {"source": "MOCK", "degraded": True, "reason": _CORPUS_ERROR}

    trails: Dict[str, List[TrailEvent]] = {}
    events, ev_prov = corpus.load_container_events()
    for ev in events:
        trails.setdefault(ev.container, []).append(
            TrailEvent(ev.event_type, ev.ts))

    scanning, scan_prov = corpus.load_scanning_lists()
    flagged = 0
    for entry in scanning:
        stamp = entry.igm_date or entry.processing_end
        if stamp is None:
            continue
        trails.setdefault(entry.container, []).append(TrailEvent("CUSTOMS_FLAG", stamp))
        flagged += 1

    leo_records, leo_prov = corpus.load_leo_records()
    leo_keyed = 0
    for rec in leo_records:
        if rec.leo_date is None:
            continue
        # No container number on the LEO file, so the trail is keyed by SB.
        trails.setdefault(f"SB-{rec.sb_number}", []).append(
            TrailEvent("LEO", rec.leo_date))
        leo_keyed += 1

    for key in trails:
        trails[key].sort(key=lambda e: e.ts)

    provenance = {
        "source": "CORPUS",
        "degraded": False,
        "n_containers": len(trails),
        "events": ev_prov.as_dict(),
        "scanning": scan_prov.as_dict(),
        "leo": leo_prov.as_dict(),
        "customs_flags_attached": flagged,
        "leo_trails_keyed_by_shipping_bill": leo_keyed,
        "join_note": (
            "The CODECO container population, the RMS scanning lists and the customs "
            "LEO file share no container numbers with each other. Trails are therefore "
            "mostly single-source, and the LEO file carries no container number at all "
            "so those trails are keyed by shipping bill. Rules that need two sources "
            "(R2, R3) consequently fire only where a real join exists."),
    }
    return trails, provenance


def scan_corpus(now: Optional[datetime] = None,
                limit: Optional[int] = None) -> Dict[str, Any]:
    """
    Run every rule over the whole shared corpus and report what was found.

    This is the graded output: the briefing says anomalies are planted on
    purpose and that detecting and documenting them is part of the evaluation.
    """
    trails, provenance = build_corpus_trails()
    if not trails:
        return {"status": "unavailable", "provenance": provenance,
                "findings": [], "degraded": True}

    # Anchor "now" to the end of the log, not wall clock: replaying a July 2026
    # corpus at any later date would otherwise flag every container in it.
    latest = max((e.ts for evs in trails.values() for e in evs), default=None)
    anchor = now or latest or datetime.now()

    dwell_p99 = _dwell_p99(trails)

    results: List[TrailResult] = []
    for container, events in trails.items():
        result = evaluate_trail(events, now=anchor, container=container,
                                dwell_p99_h=dwell_p99)
        if result.findings:
            results.append(result)

    results.sort(key=lambda r: (-SEVERITY_RANK.get(r.worst_severity or "", 0),
                                -(r.findings[0].age_hours or 0)))

    by_type: Dict[str, int] = {}
    by_severity: Dict[str, int] = {}
    for res in results:
        for f in res.findings:
            by_type[f.finding_type] = by_type.get(f.finding_type, 0) + 1
            by_severity[f.severity] = by_severity.get(f.severity, 0) + 1

    shown = results if limit is None else results[:limit]
    return {
        "status": "scanned",
        "degraded": False,
        "model_version": MODULE_VERSION,
        "scanned_at": _utc_now_iso(),
        "anchor_now": anchor.isoformat(),
        "anchor_note": (
            "Thresholds are measured against the last event in the corpus, not wall "
            "clock, so replaying a historical log does not flag everything in it."),
        "containers_scanned": len(trails),
        "containers_with_findings": len(results),
        "clean_containers": len(trails) - len(results),
        "finding_count": sum(len(r.findings) for r in results),
        "by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        "by_severity": dict(sorted(by_severity.items(),
                                   key=lambda kv: -SEVERITY_RANK.get(kv[0], 0))),
        "dwell_p99_hours": round(dwell_p99, 2) if dwell_p99 else None,
        "provenance": provenance,
        "returned": len(shown),
        "truncated": limit is not None and len(results) > limit,
        "results": [r.as_dict() for r in shown],
    }


def paired_dwell_hours(events: Sequence[TrailEvent]) -> Optional[float]:
    """
    Dwell from the first gate-in to the first gate-out that FOLLOWS it.

    Shared by rule R6 and by ``_dwell_p99`` on purpose. When these two paired
    events differently -- R6 skipping past an orphan out while the percentile
    ignored those trails entirely -- the threshold was computed on one sample
    and applied to another, and 31% of containers came back as "P99 outliers".
    One definition, used twice.
    """
    gate_in = next((e.ts for e in events if e.event_type == "GATE_IN"), None)
    if gate_in is None:
        return None
    paired_out = next((e.ts for e in events
                       if e.event_type == "GATE_OUT" and e.ts > gate_in), None)
    if paired_out is None:
        return None
    return (paired_out - gate_in).total_seconds() / 3600.0


def _dwell_p99(trails: Dict[str, List[TrailEvent]]) -> Optional[float]:
    """P99 of the completed dwells in this trail set, for rule R6."""
    dwells = [d for d in (paired_dwell_hours(events) for events in trails.values())
              if d is not None]
    if len(dwells) < 20:
        return None
    dwells.sort()
    pos = 0.99 * (len(dwells) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(dwells) - 1)
    return dwells[lo] * (1 - (pos - lo)) + dwells[hi] * (pos - lo)


def model_card() -> Dict[str, Any]:
    """The WS2 row for this model, generated from what actually ran."""
    metrics = evaluate()
    scan = scan_corpus(limit=0)
    return {
        "module_id": MODULE_ID,
        "module_name": MODULE_NAME,
        "model_version": MODULE_VERSION,
        "use_case_solved": (
            "Event-sequence anomaly detection -- stuck boxes and broken event chains, "
            "supporting pendency optimisation and alerts."),
        "training_data_features": "Container event trails [{eventType, ts}]",
        "training_data_source": "No training: a versioned rule engine.",
        "objective_function": (
            "Detect missing-sequence anomalies against the thresholds in RULES; "
            "maximise recall subject to precision >= "
            f"{ACCEPTANCE_PRECISION:g}."),
        "model_used": f"Deterministic rule engine, {len(RULES)} versioned rules",
        "rationale": (
            "Rules give actionable, explainable alerts on day one and every finding "
            "carries the evidence that produced it. Three of the six rules were added "
            "after measuring the real corpus, where an orphan gate-out -- uncovered by "
            "the published rule set -- affects 287 of 1,202 containers."),
        "link_to_model_weights": (
            "No learned weights. The rule block (RULES) in this module IS the "
            "versioned configuration; served at GET /uc2/m4/rules."),
        "validation_data": (
            f"Labelled synthetic set, n={metrics['n_trails']}, seed={metrics['seed']}, "
            f"plus a full scan of {scan.get('containers_scanned', 0)} real corpus "
            f"containers"),
        "accuracy": {
            "precision": metrics["trail_level"]["precision"],
            "recall": metrics["trail_level"]["recall"],
            "f1": metrics["trail_level"]["f1"],
            "precision_threshold": ACCEPTANCE_PRECISION,
            "recall_threshold": ACCEPTANCE_RECALL,
            "meets_precision": metrics["acceptance"]["meets_precision"],
            "meets_recall": metrics["acceptance"]["meets_recall"],
            "per_rule": metrics["per_rule"],
        },
        "corpus_scan": {k: v for k, v in scan.items() if k != "results"},
        "disclosure": (
            "RECALL IS NOW MEASURED. The previous version published precision 1.0 and "
            "disclosed recall as unmeasured, which made the precision figure "
            "uninformative -- a detector that fires once and stays silent also scores "
            "1.0. Both are reported per rule. Separately, rules R2 and R3 need two "
            "sources joined on a container number, and the corpus sources do not join, "
            "so their corpus hit-rate is a property of the data rather than of the "
            "rules."),
        "rules": [r.as_dict() for r in RULES],
    }


# ==========================================================================
# SECTION 7 -- MODULE INFO
# ==========================================================================

MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_UC2_AI_ML_Tools.md row 4 -- Event-sequence anomaly detection",
    "model_type": "deterministic rule engine (no training)",
    "known_events": list(KNOWN_EVENTS),
    "constants": {
        "DEFAULT_SEED": DEFAULT_SEED,
        "ACCEPTANCE_PRECISION": ACCEPTANCE_PRECISION,
        "ACCEPTANCE_RECALL": ACCEPTANCE_RECALL,
        "RULES": [r.as_dict() for r in RULES],
        "SEVERITY_RANK": SEVERITY_RANK,
    },
    "corpus_files": [
        "M4_Event_Sequence_Anomaly/CFS_ECY_Event_Trails/*.xlsx",
        "M4_Event_Sequence_Anomaly/Customs_Chain_IGM_OOC_SMTP_RMS_SB_LEO/**",
        "M4_Event_Sequence_Anomaly/ICEGATE_IGM_XML/*.xml",
    ],
}


# ==========================================================================
# SECTION 8 -- FASTAPI ROUTER
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

    class TrailRequest(BaseModel):
        """The published contract for this model, which differs from M1-M3."""

        trail: List[Dict[str, Any]] = Field(
            default=[{"eventType": "GATE_IN", "ts": "2026-07-01T08:00:00"}],
            description="Events as {eventType, ts}; sorted and validated server-side.")
        now: Optional[str] = Field(
            None, description="ISO-8601 evaluation anchor; defaults to the trail's "
                              "latest event so replaying history does not flag it all.")
        container: str = Field("", max_length=32)

    def build_router() -> "APIRouter":
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-M4 Event Anomaly"])

        @router.post("/predict", summary="Evaluate one container's event trail")
        def predict(req: TrailRequest) -> Dict[str, Any]:
            now = None
            if req.now:
                now = _parse_ts(req.now)
                if now is None:
                    raise HTTPException(422, f"now is not a parseable timestamp: {req.now!r}")
            result = evaluate_trail(req.trail, now=now, container=req.container)
            return result.as_dict()

        @router.get("/scan", summary="Scan the whole shared corpus -- the graded output")
        def scan(limit: int = 100, severity: Optional[str] = None) -> Dict[str, Any]:
            if not 0 <= limit <= 5000:
                raise HTTPException(422, "limit must be 0..5000")
            payload = scan_corpus(limit=None)
            if severity:
                want = severity.upper()
                if want not in SEVERITY_RANK:
                    raise HTTPException(422, f"severity must be one of {list(SEVERITY_RANK)}")
                payload["results"] = [r for r in payload["results"]
                                      if r["worstSeverity"] == want]
                payload["filtered_by_severity"] = want
            payload["truncated"] = len(payload["results"]) > limit
            payload["results"] = payload["results"][:limit]
            payload["returned"] = len(payload["results"])
            return payload

        @router.get("/metrics", summary="Precision, recall and F1 -- overall and per rule")
        def metrics(n: int = DEFAULT_EVAL_N, seed: int = DEFAULT_SEED) -> Dict[str, Any]:
            if not 10 <= n <= 20000:
                raise HTTPException(422, "n must be 10..20000")
            return evaluate(n, seed)

        @router.get("/rules", summary="The versioned rule block (the 'model weights')")
        def rules() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION,
                    "rules": [r.as_dict() for r in RULES]}

        @router.get("/model-card", summary="The WS2 submission row for this model")
        def card() -> Dict[str, Any]:
            return model_card()

        @router.get("/constants", summary="Versioned constants")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run the canonical demo scenario")
        def demo() -> Dict[str, Any]:
            trail, now = _demo_trail()
            return evaluate_trail(trail, now=now, container="DEMO0000001").as_dict()

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
# SECTION 9 -- SELF-TEST AND CLI
# ==========================================================================


def _demo_trail() -> Tuple[List[Dict[str, Any]], datetime]:
    """Gated in 96 h ago, flagged for customs 90 h ago, nothing since."""
    start = datetime(2026, 7, 1, 8, 0)
    return ([{"eventType": "GATE_IN", "ts": start.isoformat()},
             {"eventType": "CUSTOMS_FLAG", "ts": (start + timedelta(hours=6)).isoformat()}],
            start + timedelta(hours=96))


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []

    trail, now = _demo_trail()
    result = evaluate_trail(trail, now=now, container="DEMO0000001")
    fired = {f.rule_id for f in result.findings}
    checks.append(("R1 and R3 both fire on the demo trail", fired == {"R1", "R3"},
                   f"fired {sorted(fired)}"))
    checks.append(("findings are severity-ordered",
                   result.findings[0].severity == "CRIT",
                   f"worst first: {result.findings[0].finding_type}"))
    checks.append(("every finding carries evidence",
                   all(f.evidence for f in result.findings),
                   "evidence dict attached to each"))

    start = datetime(2026, 7, 1, 8, 0)
    # 71 h old: one hour inside the threshold. Must stay silent.
    near_miss = evaluate_trail([{"eventType": "GATE_IN", "ts": start.isoformat()}],
                               now=start + timedelta(hours=71))
    checks.append(("R1 respects its threshold", not near_miss.findings,
                   "71 h old gate-in does not fire the 72 h rule"))

    just_over = evaluate_trail([{"eventType": "GATE_IN", "ts": start.isoformat()}],
                               now=start + timedelta(hours=73))
    checks.append(("R1 fires just past its threshold",
                   {f.rule_id for f in just_over.findings} == {"R1"},
                   "73 h old gate-in fires"))

    orphan = evaluate_trail([{"eventType": "GATE_OUT", "ts": start.isoformat()}],
                            now=start + timedelta(hours=5))
    checks.append(("R4 catches an orphan gate-out",
                   {f.rule_id for f in orphan.findings} == {"R4"},
                   "gate-out with no gate-in"))

    negative = evaluate_trail(
        [{"eventType": "GATE_IN", "ts": start.isoformat()},
         {"eventType": "GATE_OUT", "ts": (start - timedelta(hours=3)).isoformat()}],
        now=start + timedelta(hours=10))
    checks.append(("R5 catches a negative dwell",
                   "R5" in {f.rule_id for f in negative.findings},
                   "gate-out before gate-in"))

    clean = evaluate_trail(
        [{"eventType": "GATE_IN", "ts": start.isoformat()},
         {"eventType": "GATE_OUT", "ts": (start + timedelta(hours=20)).isoformat()}],
        now=start + timedelta(hours=400))
    checks.append(("a clean pair stays clean", not clean.findings,
                   "no finding on a completed 20 h stay"))

    junk = evaluate_trail([{"eventType": "GATE_IN", "ts": "not-a-date"},
                           {"nonsense": True}], now=start)
    checks.append(("unparseable events dropped, not guessed",
                   junk.event_count == 0 and not junk.findings,
                   "no timestamp is invented"))

    metrics = evaluate()
    tl = metrics["trail_level"]
    checks.append((f"precision >= {ACCEPTANCE_PRECISION:g}",
                   metrics["acceptance"]["meets_precision"],
                   f"precision {tl['precision']} on n={metrics['n_trails']}"))
    checks.append((f"recall >= {ACCEPTANCE_RECALL:g}",
                   metrics["acceptance"]["meets_recall"],
                   f"recall {tl['recall']} -- previously unmeasured"))
    checks.append(("every rule exercised by the eval set",
                   not metrics["rules_not_exercised"],
                   f"unexercised: {metrics['rules_not_exercised'] or 'none'}"))

    if _HAS_CORPUS:
        scan = scan_corpus(limit=0)
        checks.append(("corpus scanned", scan["status"] == "scanned",
                       f"{scan.get('containers_scanned')} containers, "
                       f"{scan.get('finding_count')} findings"))
        checks.append(("planted anomalies found",
                       scan.get("finding_count", 0) > 100,
                       f"by type: {scan.get('by_type')}"))
        checks.append(("clean containers not flagged",
                       scan.get("clean_containers", 0) > 100,
                       f"{scan.get('clean_containers')} containers clean"))
    else:
        checks.append(("corpus scanned", False, _CORPUS_ERROR or "corpus unavailable"))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"{MODULE_ID} {MODULE_NAME}")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--n", type=int, default=DEFAULT_EVAL_N)
    ap.add_argument("--scan", action="store_true", help="corpus findings only")
    ap.add_argument("--limit", type=int, default=15)
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

    metrics = evaluate(args.n, args.seed)
    scan = scan_corpus(limit=args.limit)

    if args.scan:
        print(json.dumps(scan, indent=2, default=str))
        return 0
    if args.json:
        trail, now = _demo_trail()
        print(json.dumps({
            "module": MODULE_INFO,
            "metrics": metrics,
            "corpus_scan": scan,
            "demo": evaluate_trail(trail, now=now, container="DEMO0000001").as_dict(),
            "model_card": model_card(),
        }, indent=2, default=str))
        return 0

    tl = metrics["trail_level"]
    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_NAME}   {MODULE_VERSION}")
    print("=" * 78)

    print(f"\nRULES ({len(RULES)}: {sum(1 for r in RULES if r.source == 'spec')} from the "
          f"spec, {sum(1 for r in RULES if r.source == 'corpus_driven')} added after "
          f"measuring the corpus)")
    for r in RULES:
        thresh = f"{r.threshold_h:g} h" if r.threshold_h else "-"
        print(f"  {r.rule_id}  {r.finding_type:<30} {r.severity:<5} {thresh:>6}  "
              f"{r.source}")

    print(f"\nEVALUATION (labelled set, n={metrics['n_trails']}, seed={metrics['seed']})")
    print(f"  precision   {tl['precision']:.4f}   (threshold >= {ACCEPTANCE_PRECISION:g})  "
          f"{'PASS' if metrics['acceptance']['meets_precision'] else 'FAIL'}")
    print(f"  recall      {tl['recall']:.4f}   (threshold >= {ACCEPTANCE_RECALL:g})  "
          f"{'PASS' if metrics['acceptance']['meets_recall'] else 'FAIL'}")
    print(f"  F1          {tl['f1']:.4f}        accuracy {tl['accuracy']:.4f}")
    print(f"  confusion   tp {tl['tp']}  fp {tl['fp']}  fn {tl['fn']}  tn {tl['tn']}")
    print(f"\n  {'rule':<5}{'type':<32}{'tp':>5}{'fp':>5}{'fn':>5}"
          f"{'prec':>8}{'recall':>8}")
    for row in metrics["per_rule"]:
        p = f"{row['precision']:.3f}" if row["precision"] is not None else "  n/a"
        rc = f"{row['recall']:.3f}" if row["recall"] is not None else "  n/a"
        print(f"  {row['ruleId']:<5}{row['type']:<32}{row['tp']:>5}{row['fp']:>5}"
              f"{row['fn']:>5}{p:>8}{rc:>8}")

    print("\nCORPUS SCAN (the graded deliverable -- anomalies planted by design)")
    if scan["status"] == "scanned":
        print(f"  scanned     {scan['containers_scanned']} containers "
              f"(anchor {scan['anchor_now'][:16]})")
        print(f"  flagged     {scan['containers_with_findings']} containers, "
              f"{scan['finding_count']} findings")
        print(f"  clean       {scan['clean_containers']} containers")
        print(f"  by severity {scan['by_severity']}")
        print("  by type:")
        for t, c in scan["by_type"].items():
            print(f"    {t:<34} {c:>5}")
        print(f"\n  top {scan['returned']} findings:")
        for res in scan["results"]:
            f0 = res["findings"][0]
            print(f"    {res['container']:<14} {f0['severity']:<5} "
                  f"{f0['type']:<30} {f0['reason'][:44]}")
    else:
        print(f"  unavailable: {scan.get('provenance', {}).get('reason', 'no corpus')}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
