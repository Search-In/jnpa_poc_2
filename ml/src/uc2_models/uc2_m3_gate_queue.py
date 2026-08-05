"""
UC2-M3 -- Gate Queue Forecast
=============================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"How many trucks will be queued at this gate next hour, and should we defer
some of them?"

Feeds the briefing's "lane planning" AI/ML item, the Gate queue wait-time and
Avg. gate transaction-time KPIs, and the Gate tab's queue curve.

THE LEAKAGE FIX -- READ THIS FIRST
-----------------------------------
The previous version of this model was disclosed as defective:

    "RMSE 0.323 <= 3.5 -- split is shuffled on a time series (leaks):
     re-split chronologically, re-measure, re-disclose (P1)"

The defect is real and it is fixed. A lag-1 / lag-2 autoregressor scored under
a shuffled split is being tested against neighbours it has already memorised --
hour t-1 and hour t+1 sit in training while hour t is in test, and the queue
barely moves in an hour. That is not a valid protocol whatever it scores.

But the re-measurement did not confirm the assumption behind the disclosure,
and the finding is reported rather than smoothed over. ``measure_leakage()``
runs the identical model under all three protocols on the real series:

    rolling-origin (5 expanding folds)   RMSE 0.909   <- SERVED
    single chronological tail (80/20)    RMSE 0.235   <- REJECTED, degenerate
    shuffled 80/20                       RMSE 1.173   <- REJECTED on principle

Shuffling did not flatter the score here; it scored worse. And the obvious
fix -- one chronological tail -- turns out to be the misleading one on this
data: the last 245 steps of the log are a quiet fortnight with a flat zero
queue, so a tail split scores 0.235 with an undefined R2 and measures the
calendar rather than the model.

So both alternatives are rejected on principle, not on their numbers, and the
published metric is pooled across rolling-origin folds. All three are served at
``GET /uc2/m3/leakage`` so a reviewer can check the reasoning instead of taking
it on trust.

THE SERIES IS REAL
------------------
Unlike the previous version this model does not train on an invented series.
The CFS and ECY CODECO logs carry 1,929 real gate movements across 607 hours
(25 days), averaging 1.6 arrivals an hour and peaking at 10.

What the corpus does NOT record is a queue length -- no gate log anywhere in it
counts waiting trucks. So the queue is DERIVED from the real arrivals by a
single-server backlog recursion:

    queue[t] = max(0, queue[t-1] + arrivals[t] - SERVICE_CAPACITY_PER_HOUR)

with the capacity named and versioned. That makes the target a documented
transform of real data rather than a fiction, and it keeps the forecasting
problem honest: ``queue[t-1]`` is handed to the model, so the only thing left
to learn is ``arrivals[t]``, which is genuinely stochastic.

THE CROSS-TWIN FEATURE
----------------------
The published contract's fifth feature is ``uc3_truck_inflow``, supplied by the
caller from UC-III's camera counts -- this service has no data client of its
own and must not invent one. For training, the previous hour's arrivals at the
*other* facility stand in for it: a real, independently-measured road-side
signal. That substitution is named in ``FEATURE_NOTES`` and surfaced in every
response, because a cross-twin feature that quietly feeds on itself would be
the same leakage bug in a different costume.

INPUT CONTRACT
--------------
Five floats, in this order:

    queue_lag1          queue length one step ago (vehicles)
    queue_lag2          queue length two steps ago (vehicles)
    hour_sin            sin(2*pi*hour/24)
    hour_cos            cos(2*pi*hour/24)
    uc3_truck_inflow    trucks approaching, from UC-III

``POST /uc2/m3/predict-one`` accepts ``hour`` directly and derives sin/cos, so
a UI never has to compute trigonometry to ask a question.

OUTPUT CONTRACT
---------------
    queueVehicles (>= 0), p10/p50/p90, deferralRecommended (queue > 8),
    estimatedWaitMinutes, model_version, trained_at, degraded, decision_path.

USAGE
-----
    python uc2_m3_gate_queue.py
    python uc2_m3_gate_queue.py --leakage      # the P1 before/after evidence
    python uc2_m3_gate_queue.py --json
    python uc2_m3_gate_queue.py --selftest
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
from typing import Any, Dict, List, Optional, Sequence, Tuple

for _extra in (os.path.dirname(os.path.abspath(__file__)),
               os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "pipeline")):
    if _extra not in sys.path:
        sys.path.append(_extra)

# ==========================================================================
# SECTION 1 -- IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC2-M3"
MODULE_NAME: str = "Gate Queue Forecast"
MODULE_VERSION: str = "m3-gate-queue-v2.0.0"     # v2: chronological split (P1 fix)
MODEL_KEY: str = "gate-queue-forecaster"
ROUTER_PREFIX: str = "/uc2/m3"

DEFAULT_SEED: int = 202
DEFAULT_TEST_FRACTION: float = 0.2
DEFAULT_SYNTHETIC_STEPS: int = 2000

ACCEPTANCE_RMSE: float = 3.5              # our committed threshold, in vehicles
DEFERRAL_THRESHOLD: int = 8               # queue above this triggers a deferral

# Gate service model. The corpus records arrivals but never a queue length, so
# the queue is derived from arrivals through this capacity. Change it and every
# queue number changes -- which is why it is a named constant and is echoed in
# every response's provenance rather than buried in a helper.
SERVICE_CAPACITY_PER_HOUR: float = 3.0
AVG_TRANSACTION_MINUTES: float = 60.0 / SERVICE_CAPACITY_PER_HOUR

GATES: Tuple[str, ...] = ("CFS", "ECY")

FEATURE_NAMES: Tuple[str, ...] = (
    "queue_lag1", "queue_lag2", "hour_sin", "hour_cos", "uc3_truck_inflow",
)

FEATURE_NOTES: Dict[str, str] = {
    "queue_lag1": "Derived queue one hour ago; see SERVICE_CAPACITY_PER_HOUR.",
    "queue_lag2": "Derived queue two hours ago.",
    "hour_sin": "sin(2*pi*hour/24) -- time of day as a smooth cycle.",
    "hour_cos": "cos(2*pi*hour/24).",
    "uc3_truck_inflow": (
        "Supplied by the caller from UC-III camera counts. This service has no data "
        "client and will not invent one. In training it is stood in for by the "
        "previous hour's arrivals at the other facility -- a real, independently "
        "measured road-side signal, never the target's own history."),
}


# ==========================================================================
# SECTION 2 -- OPTIONAL DEPENDENCIES
# ==========================================================================

_HAS_KIT, _KIT_ERROR = False, ""
try:
    import uc2_learn as kit
    _HAS_KIT = True
except Exception as exc:  # pragma: no cover
    _KIT_ERROR = repr(exc)[:200]
    kit = None  # type: ignore

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
# SECTION 3 -- DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class QueueStep:
    """One hour of one gate: what arrived, what queued, what UC-III saw."""

    ts: datetime
    gate: str
    arrivals: int
    queue: float
    queue_lag1: float
    queue_lag2: float
    uc3_truck_inflow: float

    @property
    def hour_sin(self) -> float:
        return math.sin(2 * math.pi * self.ts.hour / 24.0)

    @property
    def hour_cos(self) -> float:
        return math.cos(2 * math.pi * self.ts.hour / 24.0)

    def as_vector(self) -> List[float]:
        return [self.queue_lag1, self.queue_lag2, self.hour_sin, self.hour_cos,
                self.uc3_truck_inflow]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "ts": self.ts.isoformat(), "gate": self.gate,
            "arrivals": self.arrivals, "queue": round(self.queue, 2),
            "queueLag1": round(self.queue_lag1, 2),
            "queueLag2": round(self.queue_lag2, 2),
            "uc3TruckInflow": round(self.uc3_truck_inflow, 2),
        }


@dataclass(frozen=True)
class QueueFeatures:
    """The five-feature information set for one forecast step."""

    queue_lag1: float
    queue_lag2: float
    hour_sin: float
    hour_cos: float
    uc3_truck_inflow: float

    def validate(self) -> "QueueFeatures":
        if self.queue_lag1 < 0 or self.queue_lag2 < 0:
            raise ValueError("queue lags must be >= 0 vehicles")
        for name in ("hour_sin", "hour_cos"):
            v = getattr(self, name)
            if not -1.0001 <= v <= 1.0001:
                raise ValueError(f"{name} must be in [-1, 1]")
        if self.uc3_truck_inflow < 0:
            raise ValueError("uc3_truck_inflow must be >= 0")
        return self

    def as_vector(self) -> List[float]:
        return [self.queue_lag1, self.queue_lag2, self.hour_sin, self.hour_cos,
                self.uc3_truck_inflow]

    @staticmethod
    def from_vector(vec: Sequence[float]) -> "QueueFeatures":
        if len(vec) != len(FEATURE_NAMES):
            raise ValueError(
                f"expected {len(FEATURE_NAMES)} features in the order "
                f"{list(FEATURE_NAMES)}, got {len(vec)}")
        return QueueFeatures(*[float(v) for v in vec]).validate()

    @staticmethod
    def from_hour(queue_lag1: float, queue_lag2: float, hour: int,
                  uc3_truck_inflow: float) -> "QueueFeatures":
        """Build from a plain clock hour so a UI never computes trigonometry."""
        if not 0 <= hour <= 23:
            raise ValueError("hour must be 0..23")
        return QueueFeatures(
            queue_lag1, queue_lag2,
            math.sin(2 * math.pi * hour / 24.0),
            math.cos(2 * math.pi * hour / 24.0),
            uc3_truck_inflow).validate()

    @property
    def hour_of_day(self) -> int:
        """Recover the clock hour from the sin/cos pair, for display."""
        angle = math.atan2(self.hour_sin, self.hour_cos)
        return int(round((angle % (2 * math.pi)) * 24 / (2 * math.pi))) % 24

    def as_dict(self) -> Dict[str, Any]:
        return {
            "queue_lag1": round(self.queue_lag1, 3),
            "queue_lag2": round(self.queue_lag2, 3),
            "hour_sin": round(self.hour_sin, 4),
            "hour_cos": round(self.hour_cos, 4),
            "hour_of_day": self.hour_of_day,
            "uc3_truck_inflow": round(self.uc3_truck_inflow, 3),
        }


@dataclass(frozen=True)
class QueuePrediction:
    """A queue forecast with its interval and its deferral advice."""

    queue_vehicles: float
    p10: float
    p50: float
    p90: float
    deferral_recommended: bool
    estimated_wait_minutes: float
    engine: str
    degraded: bool
    decision_path: str
    breakdown: Dict[str, Any]
    features: QueueFeatures
    model_version: str = MODULE_VERSION
    trained_at: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "queueVehicles": round(self.queue_vehicles, 2),
            "p10": round(self.p10, 2), "p50": round(self.p50, 2),
            "p90": round(self.p90, 2),
            "deferralRecommended": self.deferral_recommended,
            "deferralThreshold": DEFERRAL_THRESHOLD,
            "estimatedWaitMinutes": round(self.estimated_wait_minutes, 1),
            "engine": self.engine,
            "degraded": self.degraded,
            "decision_path": self.decision_path,
            "model_version": self.model_version,
            "trained_at": self.trained_at,
            "features": self.features.as_dict(),
            "breakdown": self.breakdown,
        }


# ==========================================================================
# SECTION 4 -- THE REAL SERIES
# ==========================================================================


@dataclass(frozen=True)
class SeriesInfo:
    """Provenance and shape of the series the model was trained on."""

    source: str
    gates: Tuple[str, ...]
    n_steps: int
    n_hours: int
    span: Optional[Tuple[str, str]]
    arrivals_total: int
    stats: Dict[str, float]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "degraded": self.source != "CORPUS",
            "synthetic": self.source == "SYNTHETIC",
            "gates": list(self.gates),
            "n_steps": self.n_steps,
            "n_hours_per_gate": self.n_hours,
            "span_utc": list(self.span) if self.span else None,
            "arrivals_total": self.arrivals_total,
            "stats": {k: round(v, 3) for k, v in self.stats.items()},
            "queue_derivation": (
                "queue[t] = max(0, queue[t-1] + arrivals[t] - "
                f"{SERVICE_CAPACITY_PER_HOUR:g}). The corpus records gate arrivals but "
                "no queue length anywhere, so the target is a documented transform of "
                "real movements, not an observation."),
        }


def build_real_series(
    capacity_per_hour: float = SERVICE_CAPACITY_PER_HOUR,
) -> Tuple[List[QueueStep], SeriesInfo]:
    """
    Hourly arrivals and derived queue per gate, from the real CODECO logs.

    Both facilities are bucketed onto the same hourly grid so each can act as
    the other's ``uc3_truck_inflow`` stand-in. Empty hours are kept as zeros --
    dropping them would compress the timeline and make the lag features lie
    about how far apart two observations are.
    """
    if not _HAS_CORPUS:
        return [], SeriesInfo("MOCK", (), 0, 0, None, 0, {})

    events, _prov = corpus.load_container_events()
    if not events:
        return [], SeriesInfo("MOCK", (), 0, 0, None, 0, {})

    start = min(e.ts for e in events).replace(minute=0, second=0, microsecond=0)
    end = max(e.ts for e in events).replace(minute=0, second=0, microsecond=0)
    n_hours = int((end - start).total_seconds() // 3600) + 1

    gates = tuple(sorted({e.facility for e in events}))
    counts: Dict[str, List[int]] = {g: [0] * n_hours for g in gates}
    for ev in events:
        idx = int((ev.ts.replace(minute=0, second=0, microsecond=0)
                   - start).total_seconds() // 3600)
        if 0 <= idx < n_hours:
            counts[ev.facility][idx] += 1

    steps: List[QueueStep] = []
    for gate in gates:
        others = [g for g in gates if g != gate]
        queue, lag1, lag2 = 0.0, 0.0, 0.0
        for i in range(n_hours):
            arrivals = counts[gate][i]
            queue = max(0.0, lag1 + arrivals - capacity_per_hour)
            # Cross-twin stand-in: last hour at the other gate(s), never this one.
            inflow = float(sum(counts[g][i - 1] for g in others)) if i > 0 else 0.0
            steps.append(QueueStep(
                ts=start + timedelta(hours=i), gate=gate, arrivals=arrivals,
                queue=queue, queue_lag1=lag1, queue_lag2=lag2,
                uc3_truck_inflow=inflow))
            lag2, lag1 = lag1, queue

    steps.sort(key=lambda s: (s.ts, s.gate))
    queues = [s.queue for s in steps]
    ordered = sorted(queues)
    info = SeriesInfo(
        source="CORPUS", gates=gates, n_steps=len(steps), n_hours=n_hours,
        span=(start.isoformat(), end.isoformat()),
        arrivals_total=sum(s.arrivals for s in steps),
        stats={
            "arrivals_per_hour_mean": statistics.fmean([s.arrivals for s in steps]),
            "arrivals_per_hour_max": float(max(s.arrivals for s in steps)),
            "queue_mean": statistics.fmean(queues),
            "queue_median": statistics.median(queues),
            "queue_p90": ordered[int(0.9 * (len(ordered) - 1))],
            "queue_max": float(max(queues)),
            "hours_above_deferral_threshold": float(
                sum(1 for q in queues if q > DEFERRAL_THRESHOLD)),
            "service_capacity_per_hour": capacity_per_hour,
        },
    )
    return steps, info


def build_synthetic_series(
    n_steps: int = DEFAULT_SYNTHETIC_STEPS,
    seed: int = DEFAULT_SEED,
    capacity_per_hour: float = SERVICE_CAPACITY_PER_HOUR,
) -> Tuple[List[QueueStep], SeriesInfo]:
    """
    The fallback series, used only when the corpus is absent.

    Arrivals follow a Poisson-like draw with a diurnal shape; the same backlog
    recursion then derives the queue. Badged ``SYNTHETIC`` so a dashboard
    renders the degraded state instead of implying live data.
    """
    rng = random.Random(seed)
    start = datetime(2026, 7, 1, 0, 0)
    steps: List[QueueStep] = []
    queue, lag1, lag2, prev_arrivals = 0.0, 0.0, 0.0, 0

    for i in range(n_steps):
        ts = start + timedelta(hours=i)
        # Diurnal shape peaking mid-morning and again in the evening.
        rate = 1.6 * (1.0 + 0.45 * math.sin(2 * math.pi * (ts.hour - 4) / 24.0))
        arrivals = max(0, int(round(rng.gauss(rate, 1.3))))
        queue = max(0.0, lag1 + arrivals - capacity_per_hour)
        steps.append(QueueStep(ts=ts, gate="SYNTH", arrivals=arrivals, queue=queue,
                               queue_lag1=lag1, queue_lag2=lag2,
                               uc3_truck_inflow=float(prev_arrivals)))
        lag2, lag1, prev_arrivals = lag1, queue, arrivals

    queues = [s.queue for s in steps]
    ordered = sorted(queues)
    info = SeriesInfo(
        source="SYNTHETIC", gates=("SYNTH",), n_steps=len(steps), n_hours=n_steps,
        span=(start.isoformat(), steps[-1].ts.isoformat()),
        arrivals_total=sum(s.arrivals for s in steps),
        stats={
            "arrivals_per_hour_mean": statistics.fmean([s.arrivals for s in steps]),
            "arrivals_per_hour_max": float(max(s.arrivals for s in steps)),
            "queue_mean": statistics.fmean(queues),
            "queue_median": statistics.median(queues),
            "queue_p90": ordered[int(0.9 * (len(ordered) - 1))],
            "queue_max": float(max(queues)),
            "hours_above_deferral_threshold": float(
                sum(1 for q in queues if q > DEFERRAL_THRESHOLD)),
            "service_capacity_per_hour": capacity_per_hour,
        },
    )
    return steps, info


def load_series() -> Tuple[List[QueueStep], SeriesInfo]:
    """The real series when the corpus is present, the synthetic one otherwise."""
    steps, info = build_real_series()
    if steps:
        return steps, info
    return build_synthetic_series()


# ==========================================================================
# SECTION 5 -- THE LEAKAGE MEASUREMENT (the P1 evidence)
# ==========================================================================


def measure_leakage(steps: Sequence[QueueStep], seed: int = DEFAULT_SEED) -> Dict[str, Any]:
    """
    Score the identical model under all three protocols and report all three.

    This is the disclosed P1 item turned into a measurement rather than a
    claim. The two rejected protocols are reproduced on purpose, and neither is
    ever used to serve a prediction.

    WHAT IT ACTUALLY FOUND, which is not what the disclosure predicted. The P1
    note assumed shuffling had flattered the old RMSE 0.323. On this real
    derived series it had not: the shuffled protocol scores WORSE than the
    rolling-origin one. The reason is that the single chronological tail --
    the obvious "fix" -- is degenerate here. The last 245 steps of the log are
    a quiet fortnight with a flat zero queue, so a tail split scores RMSE
    ~0.235 with an undefined R2 and tells you nothing.

    Both rejected protocols are therefore rejected on principle, not on their
    numbers: a shuffled split is invalid for an autoregressive series whatever
    it happens to score, and a lone tail split makes the metric hostage to what
    the port happened to be doing in the last week of the log. Rolling-origin
    keeps the no-peeking guarantee and averages over several regimes.
    """
    if not _HAS_KIT:
        return {"status": "unavailable", "reason": _KIT_ERROR}
    if len(steps) < 50:
        return {"status": "unavailable", "reason": f"only {len(steps)} steps"}

    x_all = [s.as_vector() for s in steps]
    y_all = [s.queue for s in steps]

    # (a) rolling-origin -- the honest protocol, and the one that ships.
    pooled = _rolling_origin_evaluate(steps, seed)

    # (b) single chronological tail -- leak-free, but degenerate on this series.
    tail_split = kit.chronological_split(steps, key=lambda s: (s.ts, s.gate),
                                         test_fraction=DEFAULT_TEST_FRACTION,
                                         ordering_field="hour_bucket")
    tail = kit.Regressor(seed, FEATURE_NAMES).fit(
        [s.as_vector() for s in tail_split.train], [s.queue for s in tail_split.train],
        [s.as_vector() for s in tail_split.test], [s.queue for s in tail_split.test])
    tail_targets = [s.queue for s in tail_split.test]
    tail_flat = len(set(round(v, 6) for v in tail_targets)) <= 1

    # (c) shuffled -- the old protocol, reproduced only to be compared.
    idx = list(range(len(steps)))
    random.Random(seed).shuffle(idx)
    cut = int(len(idx) * (1.0 - DEFAULT_TEST_FRACTION))
    tr, te = idx[:cut], idx[cut:]
    shuffled = kit.Regressor(seed, FEATURE_NAMES).fit(
        [x_all[i] for i in tr], [y_all[i] for i in tr],
        [x_all[i] for i in te], [y_all[i] for i in te])

    c_rmse = pooled["pooled"]["rmse"]
    s_rmse = shuffled.metrics.rmse

    def _r2(model: Any) -> Optional[float]:
        return round(model.metrics.r2, 4) if model.metrics.r2 is not None else None

    return {
        "status": "measured",
        "chronological": {
            "rmse": round(c_rmse, 4),
            "mae": pooled["pooled"]["mae"],
            "r2": pooled["pooled"]["r2"],
            "n_test": pooled["pooled"]["n"],
            "policy": f"rolling-origin, {pooled['n_folds']} expanding-window folds",
            "verdict": "SERVED",
        },
        "chronological_tail_for_comparison_only": {
            "rmse": round(tail.metrics.rmse, 4),
            "mae": round(tail.metrics.mae, 4),
            "r2": _r2(tail),
            "n_test": tail.metrics.n,
            "policy": "single 80/20 chronological tail -- leak-free but window-dependent",
            "test_slice_has_target_variance": not tail_flat,
            "verdict": (
                "REJECTED: the test slice is flat (a quiet period), so the score "
                "measures the calendar, not the model" if tail_flat
                else "leak-free; rolling-origin preferred for stability"),
        },
        "shuffled_for_comparison_only": {
            "rmse": round(s_rmse, 4), "mae": round(shuffled.metrics.mae, 4),
            "r2": _r2(shuffled),
            "n_test": shuffled.metrics.n,
            "policy": "random split -- invalid for an autoregressive series",
            "verdict": "REJECTED on principle regardless of its score",
        },
        "shuffled_vs_served_ratio": round(s_rmse / c_rmse, 3) if c_rmse > 1e-9 else None,
        "shuffled_understated_rmse_by": round(c_rmse - s_rmse, 4),
        "shuffling_flattered_the_score": s_rmse < c_rmse,
        "served_metric": "chronological",
        "per_fold": pooled["folds"],
        "degenerate_folds": pooled["degenerate_folds"],
        "explanation": (
            "A shuffled split puts hour t-1 and hour t+1 in training while hour t is in "
            "test, so with lag features the model has effectively already seen the "
            "answer. That makes it invalid here whatever it scores -- and on this series "
            "it does not even flatter the result, which is worth stating plainly rather "
            "than repeating the assumption. The single chronological tail is leak-free "
            "but lands on a flat, quiet fortnight and reports a meaninglessly low error. "
            "Rolling-origin is what the model card, /metrics and every response carry."),
    }


def _rolling_origin_evaluate(steps: Sequence[QueueStep], seed: int,
                             n_folds: int = 5) -> Dict[str, Any]:
    """
    Score the model across expanding-window folds and pool the predictions.

    WHY NOT A SINGLE TAIL SPLIT. On the real series the last 20% is 245
    consecutive steps with a zero queue -- a genuinely quiet fortnight at the
    end of the log. Scored there alone the model reports RMSE 0.235 and an
    undefined R2, which flatters it for a reason that has nothing to do with
    the model. Folds whose test slice has no target variance are counted and
    named in ``degenerate_folds`` rather than dropped.
    """
    splits = kit.rolling_origin_splits(steps, key=lambda s: (s.ts, s.gate),
                                       n_folds=n_folds, min_train_fraction=0.5,
                                       ordering_field="hour_bucket")
    all_true: List[float] = []
    all_pred: List[float] = []
    folds: List[Dict[str, Any]] = []
    degenerate: List[int] = []

    for i, split in enumerate(splits):
        model = kit.Regressor(seed, FEATURE_NAMES).fit(
            [s.as_vector() for s in split.train], [s.queue for s in split.train])
        y_true = [s.queue for s in split.test]
        y_pred = [max(0.0, v) for v in
                  model.predict([s.as_vector() for s in split.test])]
        all_true.extend(y_true)
        all_pred.extend(y_pred)

        metrics = kit.regression_metrics(y_true, y_pred)
        flat = len(set(round(v, 6) for v in y_true)) <= 1
        if flat:
            degenerate.append(i)
        folds.append({
            "fold": i,
            "n_train": len(split.train), "n_test": len(split.test),
            "test_starts": str(split.boundary),
            "rmse": round(metrics.rmse, 4), "mae": round(metrics.mae, 4),
            "r2": round(metrics.r2, 4) if metrics.r2 is not None else None,
            "target_variance_in_test": not flat,
        })

    pooled_metrics = kit.regression_metrics(all_true, all_pred)
    return {
        "n_folds": len(splits),
        "folds": folds,
        "degenerate_folds": degenerate,
        "pooled": pooled_metrics.as_dict(),
        "pooled_true": all_true,
        "pooled_pred": all_pred,
    }


# ==========================================================================
# SECTION 6 -- THE FORECASTER
# ==========================================================================


class GateQueueForecaster:
    """Chronologically-split autoregressor over the derived gate queue."""

    def __init__(self, seed: int = DEFAULT_SEED) -> None:
        self.seed = seed
        self.steps: List[QueueStep] = []
        self.series_info: Optional[SeriesInfo] = None
        self.model: Any = None
        self.bands: Any = None
        self.metrics_obj: Any = None
        self.rolling: Dict[str, Any] = {}
        self.split_info: Dict[str, Any] = {}
        self.metrics: Dict[str, Any] = {}
        self.importance: List[Dict[str, Any]] = []
        self.leakage: Dict[str, Any] = {}
        self.trained_at: str = ""

    def fit(self) -> "GateQueueForecaster":
        if not _HAS_KIT:
            raise RuntimeError(f"uc2_learn unavailable: {_KIT_ERROR}")

        self.steps, self.series_info = load_series()
        if len(self.steps) < 50:
            raise RuntimeError(f"series too short to train: {len(self.steps)} steps")

        # (1) The published metric: rolling-origin folds pooled together.
        rolling = _rolling_origin_evaluate(self.steps, self.seed)
        self.rolling = {k: v for k, v in rolling.items()
                        if k not in ("pooled_true", "pooled_pred")}
        self.metrics_obj = kit.regression_metrics(rolling["pooled_true"],
                                                  rolling["pooled_pred"])
        self.bands = kit.residual_bands(rolling["pooled_true"], rolling["pooled_pred"])

        # (2) The served model: refit on the whole series, since at inference
        #     time every observation is legitimately in the past.
        split = kit.chronological_split(self.steps, key=lambda s: (s.ts, s.gate),
                                        test_fraction=DEFAULT_TEST_FRACTION,
                                        ordering_field="hour_bucket")
        self.model = kit.Regressor(self.seed, FEATURE_NAMES).fit(
            [s.as_vector() for s in self.steps], [s.queue for s in self.steps])
        self.split_info = {
            **split.as_dict(),
            "policy": "rolling-origin (expanding window)",
            "n_folds": rolling["n_folds"],
            "serving_model_trained_on": "the full series",
            "note": (
                "Metrics come from the rolling-origin folds, each trained only on its own "
                "past. The served model is then refit on everything, because at inference "
                "time every recorded hour really is in the past. A single tail split is "
                "reported too but is degenerate on this series -- see degenerate_folds."),
        }
        self.importance = kit.permutation_importance(
            self.model, [s.as_vector() for s in self.steps],
            [s.queue for s in self.steps], seed=self.seed)

        # Persistence is the baseline that matters for a queue: "next hour looks
        # like this hour". Beating a median is trivial here and would flatter.
        persistence_rmse = math.sqrt(statistics.fmean(
            [(s.queue - s.queue_lag1) ** 2 for s in self.steps]))
        self.leakage = measure_leakage(self.steps, self.seed)

        self.metrics = {
            "held_out_rolling_origin": self.metrics_obj.as_dict(),
            "n_folds": rolling["n_folds"],
            "per_fold": rolling["folds"],
            "degenerate_folds": rolling["degenerate_folds"],
            "persistence_baseline_rmse": round(persistence_rmse, 4),
            "beats_persistence": self.metrics_obj.rmse < persistence_rmse,
            "acceptance_threshold_rmse": ACCEPTANCE_RMSE,
            "meets_threshold": self.metrics_obj.rmse <= ACCEPTANCE_RMSE,
            "leakage_check": self.leakage,
            "bands": self.bands.as_dict(),
        }
        self.trained_at = _utc_now_iso()
        return self

    def _ensure_fitted(self) -> None:
        if self.model is None:
            self.fit()

    def predict(self, features: QueueFeatures) -> QueuePrediction:
        features.validate()
        self._ensure_fitted()

        point = max(0.0, self.model.predict_one(features.as_vector()))
        bands = self.bands
        p10, p90 = bands.band(point, floor=0.0) if bands else (point * 0.6, point * 1.6)
        wait = point * AVG_TRANSACTION_MINUTES / max(1.0, SERVICE_CAPACITY_PER_HOUR)

        degraded = bool(self.model.degraded
                        or (self.series_info and self.series_info.source != "CORPUS"))
        path = (f"engine={self.model.engine}"
                f" | series={self.series_info.source if self.series_info else 'NONE'}"
                f" | split=chronological"
                f" | uc3_truck_inflow=caller_supplied")

        return QueuePrediction(
            queue_vehicles=point, p10=p10, p50=point, p90=p90,
            deferral_recommended=point > DEFERRAL_THRESHOLD,
            estimated_wait_minutes=wait,
            engine=self.model.engine,
            degraded=degraded,
            decision_path=path,
            breakdown={
                "rule": f"deferralRecommended = queue > {DEFERRAL_THRESHOLD}",
                "queue_vs_threshold": round(point - DEFERRAL_THRESHOLD, 2),
                "wait_formula": (
                    f"queue * {AVG_TRANSACTION_MINUTES:g} min / "
                    f"{SERVICE_CAPACITY_PER_HOUR:g} lanes"),
                "service_capacity_per_hour": SERVICE_CAPACITY_PER_HOUR,
                "interval_method": "empirical held-out residual quantiles (P10/P90)",
                "feature_notes": FEATURE_NOTES,
            },
            features=features,
            trained_at=self.trained_at,
        )

    def predict_many(self, rows: Sequence[Sequence[float]]) -> List[QueuePrediction]:
        return [self.predict(QueueFeatures.from_vector(r)) for r in rows]

    def forecast_curve(self, gate: str, hours: int = 12,
                       uc3_truck_inflow: Optional[float] = None) -> Dict[str, Any]:
        """
        Roll the model forward from the gate's last observed state.

        This is what the Gate tab's queue curve renders. Each step feeds its own
        output back in as the next lag, so the uncertainty compounds -- the
        response says so and widens the band accordingly rather than presenting
        hour 12 with the same confidence as hour 1.
        """
        self._ensure_fitted()
        gate_steps = [s for s in self.steps if s.gate == gate]
        if not gate_steps:
            available = sorted({s.gate for s in self.steps})
            raise ValueError(f"unknown gate {gate!r}; available: {available}")

        last = gate_steps[-1]
        inflow = (uc3_truck_inflow if uc3_truck_inflow is not None
                  else last.uc3_truck_inflow)
        lag1, lag2 = last.queue, last.queue_lag1
        ts = last.ts
        points: List[Dict[str, Any]] = []

        for step in range(1, hours + 1):
            ts = ts + timedelta(hours=1)
            features = QueueFeatures.from_hour(lag1, lag2, ts.hour, inflow)
            pred = self.predict(features)
            # Compounding: each fed-back step adds ~sqrt(step) to the band.
            widen = math.sqrt(step)
            payload = pred.as_dict()
            payload["ts"] = ts.isoformat()
            payload["stepAhead"] = step
            payload["p10"] = round(max(0.0, pred.p50 - (pred.p50 - pred.p10) * widen), 2)
            payload["p90"] = round(pred.p50 + (pred.p90 - pred.p50) * widen, 2)
            points.append(payload)
            lag2, lag1 = lag1, pred.queue_vehicles

        deferral_windows = [p["ts"] for p in points if p["deferralRecommended"]]
        return {
            "moduleId": MODULE_ID,
            "gate": gate,
            "anchoredAt": last.ts.isoformat(),
            "anchorQueue": round(last.queue, 2),
            "horizonHours": hours,
            "uc3TruckInflowUsed": round(inflow, 2),
            "uc3TruckInflowSource": ("caller" if uc3_truck_inflow is not None
                                     else "last observed cross-gate arrivals"),
            "points": points,
            "deferralWindows": deferral_windows,
            "bandNote": (
                "Bands widen by sqrt(step) because each step is fed its own previous "
                "output as the lag feature. Hour 12 is not as certain as hour 1."),
            "model_version": MODULE_VERSION,
            "trained_at": self.trained_at,
            "degraded": bool(self.series_info and self.series_info.source != "CORPUS"),
        }

    def model_card(self) -> Dict[str, Any]:
        self._ensure_fitted()
        info = self.series_info
        return {
            "module_id": MODULE_ID,
            "module_name": MODULE_NAME,
            "model_version": MODULE_VERSION,
            "trained_at": self.trained_at,
            "use_case_solved": (
                "Gate queue forecast -- next-interval queue length per gate and a "
                "deferral recommendation, supporting lane planning."),
            "training_data_features": list(FEATURE_NAMES),
            "training_data_source": (
                f"{info.n_steps} hourly steps derived from {info.arrivals_total} real "
                f"CODECO gate movements across {info.n_hours} hours"
                if info and info.source == "CORPUS"
                else "Seeded synthetic autoregressive series (corpus unavailable)"),
            "objective_function": (
                "Minimise RMSE of next-step queue length; post-process recommends "
                f"deferral when queue > {DEFERRAL_THRESHOLD} and converts queue to an "
                "estimated wait in minutes."),
            "model_used": f"{self.model.engine} autoregressor",
            "rationale": (
                "The cross-twin uc3_truck_inflow feature demonstrates UC-II <-> UC-III "
                "interdependency. The split is chronological, which is the correction to "
                "the previously disclosed leakage defect."),
            "link_to_model_weights": kit.bundle_paths(MODEL_KEY)["model"],
            "validation_data": (
                f"Pooled across {self.rolling.get('n_folds', 0)} rolling-origin "
                f"folds, n={self.metrics_obj.n} held-out steps"),
            "accuracy": {
                "rmse": round(self.metrics_obj.rmse, 4),
                "mae": round(self.metrics_obj.mae, 4),
                "r2": round(self.metrics_obj.r2, 4)
                if self.metrics_obj.r2 is not None else None,
                "acceptance_threshold_rmse": ACCEPTANCE_RMSE,
                "meets_threshold": self.metrics_obj.rmse <= ACCEPTANCE_RMSE,
                "persistence_baseline_rmse": self.metrics["persistence_baseline_rmse"],
                "beats_persistence": self.metrics["beats_persistence"],
                "split_policy": "rolling-origin (expanding window)",
                "degenerate_folds": self.metrics["degenerate_folds"],
            },
            "disclosure": (
                "PREVIOUSLY DISCLOSED DEFECT, NOW FIXED. The earlier version shuffled a "
                "time series and published RMSE 0.323, which was leakage. This version "
                "splits chronologically and publishes the higher, honest number. Both "
                "figures are in metrics.leakage_check so the size of the correction is "
                "visible. Separately: the corpus records gate arrivals but no queue "
                "length, so the target is derived through a named service capacity."),
            "series": info.as_dict() if info else None,
            "split": self.split_info,
            "feature_importance": self.importance,
            "feature_notes": FEATURE_NOTES,
            "engine_report": self.model.report.as_dict(),
            "seed": self.seed,
            "reproduce": f"python uc2_m3_gate_queue.py --seed {self.seed} --json",
        }

    def export(self) -> Dict[str, Any]:
        self._ensure_fitted()
        return kit.save_bundle(MODEL_KEY, self.model,
                               {"metrics": self.metrics,
                                "series": self.series_info.as_dict() if self.series_info
                                else None},
                               self.model_card())


_FORECASTER: Optional[GateQueueForecaster] = None


def get_forecaster() -> GateQueueForecaster:
    global _FORECASTER
    if _FORECASTER is None:
        _FORECASTER = GateQueueForecaster().fit()
    return _FORECASTER


# ==========================================================================
# SECTION 7 -- MODULE INFO
# ==========================================================================

MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_UC2_AI_ML_Tools.md row 3 -- Gate queue forecast",
    "model_type": "learned autoregressor (chronologically split)",
    "feature_order": list(FEATURE_NAMES),
    "feature_notes": FEATURE_NOTES,
    "gates": list(GATES),
    "constants": {
        "DEFAULT_SEED": DEFAULT_SEED,
        "ACCEPTANCE_RMSE": ACCEPTANCE_RMSE,
        "DEFERRAL_THRESHOLD": DEFERRAL_THRESHOLD,
        "SERVICE_CAPACITY_PER_HOUR": SERVICE_CAPACITY_PER_HOUR,
        "AVG_TRANSACTION_MINUTES": AVG_TRANSACTION_MINUTES,
    },
    "corpus_files": [
        "M1_Container_Dwell_Prediction/CFS_ECY_Container_Events_and_LDB_Benchmark/*.xlsx",
        "M3_Gate_Queue_Forecast/Gate_Documents_Form13_EIR_PIN/**/*.json",
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

    class InstancesRequest(BaseModel):
        instances: List[List[float]] = Field(
            default=[[4.0, 3.0, 0.5, 0.866, 6.0]],
            description="Rows of " + ", ".join(FEATURE_NAMES))

    class NamedRequest(BaseModel):
        queue_lag1: float = Field(4.0, ge=0, le=500)
        queue_lag2: float = Field(3.0, ge=0, le=500)
        hour: int = Field(9, ge=0, le=23, description="Clock hour; sin/cos derived here.")
        uc3_truck_inflow: float = Field(
            6.0, ge=0, le=500,
            description="Trucks approaching, supplied by the caller from UC-III.")

        def to_features(self) -> QueueFeatures:
            return QueueFeatures.from_hour(self.queue_lag1, self.queue_lag2,
                                           self.hour, self.uc3_truck_inflow)

    def build_router() -> "APIRouter":
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-M3 Gate Queue"])

        @router.post("/predict", summary="Batch queue forecast (positional contract)")
        def predict(req: InstancesRequest) -> Dict[str, Any]:
            try:
                preds = get_forecaster().predict_many(req.instances)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            return {
                "predictions": [round(p.queue_vehicles, 2) for p in preds],
                "detail": [p.as_dict() for p in preds],
                "model_version": MODULE_VERSION,
                "trained_at": get_forecaster().trained_at,
                "generated_at_utc": _utc_now_iso(),
            }

        @router.post("/predict-one", summary="Single queue forecast (named fields)")
        def predict_one(req: NamedRequest) -> Dict[str, Any]:
            try:
                return get_forecaster().predict(req.to_features()).as_dict()
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from exc

        @router.get("/forecast/{gate}", summary="Rolling queue curve for the Gate tab")
        def forecast(gate: str, hours: int = 12,
                     uc3_truck_inflow: Optional[float] = None) -> Dict[str, Any]:
            if not 1 <= hours <= 72:
                raise HTTPException(422, "hours must be 1..72")
            try:
                return get_forecaster().forecast_curve(gate.upper(), hours,
                                                       uc3_truck_inflow)
            except ValueError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc

        @router.get("/series", summary="The derived queue series and its provenance")
        def series(gate: Optional[str] = None, limit: int = 200) -> Dict[str, Any]:
            f = get_forecaster()
            steps = f.steps if gate is None else [s for s in f.steps
                                                  if s.gate == gate.upper()]
            return {
                "info": f.series_info.as_dict() if f.series_info else None,
                "n_returned": min(limit, len(steps)),
                "n_total": len(steps),
                "steps": [s.as_dict() for s in steps[-limit:]],
            }

        @router.get("/leakage", summary="Chronological vs shuffled -- the P1 evidence")
        def leakage() -> Dict[str, Any]:
            return get_forecaster().leakage

        @router.get("/metrics", summary="Held-out metrics under the chronological split")
        def metrics() -> Dict[str, Any]:
            f = get_forecaster()
            return {
                "module_id": MODULE_ID, "model_version": MODULE_VERSION,
                "trained_at": f.trained_at, "metrics": f.metrics,
                "feature_importance": f.importance, "split": f.split_info,
                "series": f.series_info.as_dict() if f.series_info else None,
            }

        @router.get("/model-card", summary="The WS2 submission row for this model")
        def model_card() -> Dict[str, Any]:
            return get_forecaster().model_card()

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run the canonical demo scenario")
        def demo() -> Dict[str, Any]:
            return get_forecaster().predict(_demo_features()).as_dict()

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


def _demo_features() -> QueueFeatures:
    """A busy 09:00 gate with a building queue and heavy UC-III inflow."""
    return QueueFeatures.from_hour(queue_lag1=9.0, queue_lag2=6.0, hour=9,
                                   uc3_truck_inflow=8.0)


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []
    checks.append(("shared learning kit importable", _HAS_KIT, _KIT_ERROR or "uc2_learn"))
    if not _HAS_KIT:
        return checks

    f = _demo_features()
    checks.append(("hour recovered from sin/cos", f.hour_of_day == 9,
                   f"hour_of_day={f.hour_of_day} from sin/cos"))

    try:
        QueueFeatures.from_vector([1.0, 2.0])
        ok, detail = False, "accepted a 2-float vector"
    except ValueError:
        ok, detail = True, "raises on the wrong feature count"
    checks.append(("positional contract validated", ok, detail))

    try:
        QueueFeatures(-1.0, 0.0, 0.0, 1.0, 0.0).validate()
        ok, detail = False, "accepted a negative queue"
    except ValueError:
        ok, detail = True, "raises on a negative queue lag"
    checks.append(("feature ranges validated", ok, detail))

    forecaster = get_forecaster()
    info = forecaster.series_info
    checks.append(("series loaded", info is not None and info.n_steps >= 50,
                   f"{info.source}: {info.n_steps} steps over {info.n_hours} hours"))

    if _HAS_CORPUS and info and info.source == "CORPUS":
        checks.append(("series is real", info.arrivals_total > 1000,
                       f"{info.arrivals_total} real CODECO movements, "
                       f"{len(info.gates)} gates"))
        checks.append(("queue derivation is documented",
                       "SERVICE_CAPACITY" in info.as_dict()["queue_derivation"].upper()
                       or "max(0" in info.as_dict()["queue_derivation"],
                       "recursion published in the response"))
    else:
        checks.append(("series is real", False,
                       "UC-II corpus unavailable -- synthetic series badged SYNTHETIC"))

    checks.append(("split never shuffles",
                   forecaster.split_info.get("policy", "").startswith("rolling-origin")
                   and forecaster.split_info.get("shuffled") is False,
                   f"{forecaster.split_info.get('policy')}, "
                   f"{forecaster.split_info.get('n_folds')} folds"))

    rmse = forecaster.metrics_obj.rmse
    checks.append((f"RMSE <= {ACCEPTANCE_RMSE:g} vehicles", rmse <= ACCEPTANCE_RMSE,
                   f"RMSE {rmse:.3f} under the chronological split"))
    checks.append(("beats a persistence baseline", forecaster.metrics["beats_persistence"],
                   f"{rmse:.3f} vs persistence "
                   f"{forecaster.metrics['persistence_baseline_rmse']:.3f}"))

    leak = forecaster.leakage
    if leak.get("status") == "measured":
        checks.append(("all three split protocols measured",
                       all(k in leak for k in ("chronological",
                                               "chronological_tail_for_comparison_only",
                                               "shuffled_for_comparison_only")),
                       f"rolling-origin {leak['chronological']['rmse']:.3f} | tail "
                       f"{leak['chronological_tail_for_comparison_only']['rmse']:.3f} | "
                       f"shuffled {leak['shuffled_for_comparison_only']['rmse']:.3f}"))
        checks.append(("served metric is the rolling-origin one",
                       leak["served_metric"] == "chronological",
                       "the two rejected protocols are published but never served"))
        checks.append(("degenerate tail split is flagged, not hidden",
                       leak["chronological_tail_for_comparison_only"].get(
                           "test_slice_has_target_variance") is not None,
                       leak["chronological_tail_for_comparison_only"]["verdict"][:58]))
    else:
        checks.append(("leakage measured", False, leak.get("reason", "unavailable")))

    pred = forecaster.predict(_demo_features())
    checks.append(("queue is non-negative", pred.queue_vehicles >= 0,
                   f"{pred.queue_vehicles:.2f} vehicles"))
    checks.append(("interval brackets the point", pred.p10 <= pred.p50 <= pred.p90,
                   f"[{pred.p10:.2f}, {pred.p90:.2f}]"))
    checks.append(("deferral rule matches the threshold",
                   pred.deferral_recommended == (pred.queue_vehicles > DEFERRAL_THRESHOLD),
                   f"queue {pred.queue_vehicles:.2f} vs threshold {DEFERRAL_THRESHOLD}"))

    if info and info.gates:
        curve = forecaster.forecast_curve(info.gates[0], hours=6)
        widening = (curve["points"][-1]["p90"] - curve["points"][-1]["p50"]
                    >= curve["points"][0]["p90"] - curve["points"][0]["p50"])
        checks.append(("forecast curve widens with horizon", widening,
                       f"6 steps on gate {info.gates[0]}, band grows by sqrt(step)"))

        try:
            forecaster.forecast_curve("NO_SUCH_GATE")
            ok, detail = False, "accepted an unknown gate"
        except ValueError:
            ok, detail = True, "raises on an unknown gate"
        checks.append(("unknown gate rejected", ok, detail))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=f"{MODULE_ID} {MODULE_NAME}")
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--gate", default=None, help="gate for the forecast curve")
    ap.add_argument("--hours", type=int, default=12)
    ap.add_argument("--leakage", action="store_true",
                    help="chronological vs shuffled evidence only")
    ap.add_argument("--export", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        checks = _self_test()
        for name, ok, detail in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:<40} {detail}")
        failed = [c for c in checks if not c[1]]
        print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if failed else 0

    forecaster = GateQueueForecaster(seed=args.seed).fit()
    info = forecaster.series_info
    gate = args.gate or (info.gates[0] if info and info.gates else None)

    if args.export:
        print(json.dumps({"exported": forecaster.export()}, indent=2))
        return 0
    if args.leakage:
        print(json.dumps(forecaster.leakage, indent=2))
        return 0

    curve = forecaster.forecast_curve(gate, args.hours) if gate else None
    if args.json:
        print(json.dumps({
            "module": MODULE_INFO,
            "series": info.as_dict() if info else None,
            "metrics": forecaster.metrics,
            "leakage": forecaster.leakage,
            "demo": forecaster.predict(_demo_features()).as_dict(),
            "forecast_curve": curve,
            "model_card": forecaster.model_card(),
        }, indent=2, default=str))
        return 0

    m = forecaster.metrics_obj
    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_NAME}   {MODULE_VERSION}")
    print("=" * 78)
    print(f"\nSERIES        source={info.source}   gates={', '.join(info.gates)}")
    print(f"  steps       {info.n_steps} hourly buckets over {info.n_hours} hours")
    if info.span:
        print(f"  span        {info.span[0][:16]} -> {info.span[1][:16]}")
    s = info.stats
    print(f"  arrivals    {info.arrivals_total} total, mean "
          f"{s['arrivals_per_hour_mean']:.2f}/h, peak {s['arrivals_per_hour_max']:.0f}/h")
    print(f"  queue       mean {s['queue_mean']:.2f}  median {s['queue_median']:.2f}  "
          f"p90 {s['queue_p90']:.2f}  max {s['queue_max']:.0f} vehicles")
    print(f"  derived at  capacity {s['service_capacity_per_hour']:.0f} trucks/h; "
          f"{s['hours_above_deferral_threshold']:.0f} hours above the "
          f"deferral threshold of {DEFERRAL_THRESHOLD}")

    print(f"\nMETRICS (rolling-origin, {forecaster.metrics['n_folds']} folds, "
          f"seed {args.seed})")
    print(f"  engine      {forecaster.model.engine}")
    print(f"  RMSE        {m.rmse:.3f} vehicles   (threshold <= {ACCEPTANCE_RMSE:g})  "
          f"{'PASS' if m.rmse <= ACCEPTANCE_RMSE else 'FAIL'}")
    r2_text = f"{m.r2:.4f}" if m.r2 is not None else "n/a (flat test slice)"
    print(f"  MAE         {m.mae:.3f}        R2  {r2_text}")
    print(f"  persistence {forecaster.metrics['persistence_baseline_rmse']:.3f} RMSE  "
          f"-> model {'beats' if forecaster.metrics['beats_persistence'] else 'LOSES TO'} it")

    leak = forecaster.leakage
    if leak.get("status") == "measured":
        tail = leak["chronological_tail_for_comparison_only"]
        shuf = leak["shuffled_for_comparison_only"]
        print("\nP1 SPLIT PROTOCOL (the disclosed defect, re-measured)")
        print(f"  rolling-origin RMSE {leak['chronological']['rmse']:.4f}   <- SERVED")
        print(f"  chrono. tail   RMSE {tail['rmse']:.4f}   <- {tail['verdict'][:44]}")
        print(f"  shuffled 80/20 RMSE {shuf['rmse']:.4f}   <- {shuf['verdict'][:44]}")
        if leak["shuffling_flattered_the_score"]:
            print(f"  shuffling understated the error by "
                  f"{-leak['shuffled_understated_rmse_by']:.4f} vehicles")
        else:
            print("  NOTE: shuffling did NOT flatter the score on this series -- it")
            print("        scored worse. It is rejected because it is invalid for an")
            print("        autoregressive series, not because of its number.")
    print("\nFEATURE IMPORTANCE (permutation, MAE increase when shuffled)")
    for imp in forecaster.importance:
        print(f"  {imp['feature']:<20} +{imp['mae_increase']:.3f}")

    if curve:
        print(f"\nFORECAST CURVE  gate {gate}, {args.hours} h from "
              f"{curve['anchoredAt'][:16]} (anchor queue {curve['anchorQueue']:.1f})")
        print(f"  {'hour':<18}{'queue':>8}{'p10':>8}{'p90':>8}  {'wait':>7}  defer")
        for p in curve["points"]:
            print(f"  {p['ts'][11:16]:<18}{p['queueVehicles']:>8.2f}{p['p10']:>8.2f}"
                  f"{p['p90']:>8.2f}  {p['estimatedWaitMinutes']:>5.0f}m  "
                  f"{'YES' if p['deferralRecommended'] else '-'}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
