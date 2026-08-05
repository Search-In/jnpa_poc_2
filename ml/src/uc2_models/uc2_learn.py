"""
uc2_learn -- the small learning kit the three UC-II regressors share.
=====================================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

WHY A SHARED FILE AND NOT THREE COPIES
--------------------------------------
UC-I deliberately duplicates its DUKC core into four modules and pays for that
choice with a fingerprint gate at import time. That trade is right for a
safety-of-navigation formula that must run in isolation. It is the wrong trade
here: the dwell, rake-TAT and gate-queue models need the *same* split rule, the
*same* metric definitions and the *same* engine fallback chain, and three
copies of a train/test split is exactly how one model quietly ends up shuffling
a time series while the other two do not.

So this is one file, imported by all three. It has no dependency of its own --
scikit-learn is optional and the fallback is stdlib.

THE FOUR THINGS IT GUARANTEES
-----------------------------
1. CHRONOLOGICAL SPLIT, ALWAYS.
   ``chronological_split()`` sorts by an ordering key and cuts at a time
   percentile. It asserts ``max(train key) <= min(test key)`` before returning.
   There is no shuffled-split function in this file to reach for by accident.

   This is the fix for the leakage disclosed in the short spec against the gate
   queue forecaster ("split is shuffled on a time series (leaks)"): a lag-1 /
   lag-2 autoregressor evaluated on a shuffled split scores against neighbours
   it has already memorised. Re-measured chronologically the number is worse
   and true, and that is the number the model card carries.

2. AN ENGINE FALLBACK CHAIN THAT REPORTS ITSELF.
   HistGradientBoosting -> GradientBoosting -> RandomForest -> ridge. Each skip
   records *why* in ``engine_trace``, so the served response can say which
   engine produced the number and what was unavailable. The ridge tail is pure
   stdlib, so a bare CPython install still trains and still serves.

3. INTERVALS, NEVER BARE POINTS.
   ``ResidualBands`` derives P10/P50/P90 from held-out residual quantiles, not
   from an assumed Gaussian. The UI contract in the spec forbids returning a
   bare point prediction; this is what makes honouring it cheap.

4. METRICS THAT MATCH THE MODEL CARD.
   ``regression_metrics()`` is the only definition of MAE / RMSE / MAPE / R2 in
   UC-II. If it changes, every model card changes with it.

USAGE
-----
    python uc2_learn.py            # self-test on a known-answer problem
"""

from __future__ import annotations

import json
import math
import os
import random
import statistics
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

MODULE_ID: str = "UC2-LEARN"
MODULE_VERSION: str = "uc2-learn-v1.0.0"

# Seeds are fixed by the acceptance criteria: every metric must be reproducible.
SEED_DWELL: int = 101
SEED_GATE: int = 202
SEED_RAKE: int = 303
SEED_LANE: int = 404
SEED_ANOMALY: int = 505

DEFAULT_TEST_FRACTION: float = 0.2


# ==========================================================================
# SECTION 1 -- SPLITTING
# ==========================================================================


@dataclass(frozen=True)
class Split:
    """A chronological train/test split with the boundary it was cut at."""

    train: Tuple[Any, ...]
    test: Tuple[Any, ...]
    boundary: Any
    test_fraction: float
    ordering_field: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "policy": "chronological",
            "ordering_field": self.ordering_field,
            "boundary": str(self.boundary),
            "n_train": len(self.train),
            "n_test": len(self.test),
            "test_fraction": round(self.test_fraction, 4),
            "shuffled": False,
            "note": (
                "Cut at a time percentile, never shuffled. Asserted post-condition: "
                "every training row is ordered at or before every test row."
            ),
        }


def chronological_split(
    rows: Sequence[Any],
    key: Callable[[Any], Any],
    test_fraction: float = DEFAULT_TEST_FRACTION,
    ordering_field: str = "timestamp",
) -> Split:
    """
    Sort by ``key`` and cut the last ``test_fraction`` off as the test set.

    Raises ``ValueError`` when there is not enough data to leave both sides
    non-empty -- an empty test set silently reported as "MAE 0.0" is worse than
    a failure the caller has to handle.
    """
    if not 0.0 < test_fraction < 1.0:
        raise ValueError(f"test_fraction must be in (0, 1), got {test_fraction}")
    ordered = sorted(rows, key=key)
    n = len(ordered)
    cut = int(round(n * (1.0 - test_fraction)))
    cut = max(1, min(cut, n - 1)) if n >= 2 else 0
    if n < 2 or cut <= 0 or cut >= n:
        raise ValueError(f"need at least 2 rows to split chronologically, got {n}")

    train, test = tuple(ordered[:cut]), tuple(ordered[cut:])
    assert key(train[-1]) <= key(test[0]), "chronological split post-condition violated"
    return Split(train, test, key(test[0]), len(test) / n, ordering_field)


def rolling_origin_splits(
    rows: Sequence[Any],
    key: Callable[[Any], Any],
    n_folds: int = 5,
    min_train_fraction: float = 0.5,
    ordering_field: str = "timestamp",
) -> List[Split]:
    """
    Expanding-window folds: train on everything before each fold, test on it.

    WHY THIS EXISTS. A single chronological tail split is leak-free but it is
    hostage to whatever happened in the last 20% of the window. On the real
    JNPA gate series that tail is a completely quiet period -- 245 consecutive
    steps with a zero queue -- so a lone tail split reports RMSE 0.235 and an
    undefined R2, and the number says nothing about the model.

    Rolling-origin evaluation keeps the no-peeking guarantee (every fold trains
    only on its own past) while scoring across several regimes instead of one.
    Folds whose test slice has no target variance are still returned; the
    caller is expected to report them rather than quietly drop them.
    """
    if n_folds < 1:
        raise ValueError("n_folds must be >= 1")
    if not 0.0 < min_train_fraction < 1.0:
        raise ValueError("min_train_fraction must be in (0, 1)")

    ordered = sorted(rows, key=key)
    n = len(ordered)
    initial = int(round(n * min_train_fraction))
    remaining = n - initial
    if remaining < n_folds:
        raise ValueError(
            f"need at least {n_folds} rows after the initial window; "
            f"have {remaining} of {n}")

    fold_size = remaining // n_folds
    splits: List[Split] = []
    for i in range(n_folds):
        start = initial + i * fold_size
        stop = n if i == n_folds - 1 else start + fold_size
        train, test = tuple(ordered[:start]), tuple(ordered[start:stop])
        if not train or not test:
            continue
        assert key(train[-1]) <= key(test[0]), "rolling-origin post-condition violated"
        splits.append(Split(train, test, key(test[0]), len(test) / n, ordering_field))
    return splits


# ==========================================================================
# SECTION 2 -- METRICS
# ==========================================================================


@dataclass(frozen=True)
class Metrics:
    """Held-out regression metrics. One definition, used by every model card."""

    n: int
    mae: float
    rmse: float
    mape_pct: Optional[float]
    r2: Optional[float]
    median_abs_error: float
    p90_abs_error: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n": self.n,
            "mae": round(self.mae, 4),
            "rmse": round(self.rmse, 4),
            "mape_pct": round(self.mape_pct, 2) if self.mape_pct is not None else None,
            "r2": round(self.r2, 4) if self.r2 is not None else None,
            "median_abs_error": round(self.median_abs_error, 4),
            "p90_abs_error": round(self.p90_abs_error, 4),
        }


def regression_metrics(y_true: Sequence[float], y_pred: Sequence[float]) -> Metrics:
    """
    MAE / RMSE / MAPE / R2 over a held-out set.

    MAPE is ``None`` rather than ``inf`` when any target is zero: a queue length
    of zero is a legitimate observation and dividing by it would poison the
    headline number the dashboard renders.
    """
    if len(y_true) != len(y_pred):
        raise ValueError("y_true and y_pred length mismatch")
    if not y_true:
        raise ValueError("cannot compute metrics over an empty set")

    errs = [abs(a - b) for a, b in zip(y_true, y_pred)]
    sq = [(a - b) ** 2 for a, b in zip(y_true, y_pred)]
    mae = statistics.fmean(errs)
    rmse = math.sqrt(statistics.fmean(sq))

    mape: Optional[float] = None
    if all(abs(v) > 1e-9 for v in y_true):
        mape = 100.0 * statistics.fmean(
            [abs(a - b) / abs(a) for a, b in zip(y_true, y_pred)])

    r2: Optional[float] = None
    if len(y_true) >= 2:
        mean_y = statistics.fmean(y_true)
        ss_tot = sum((v - mean_y) ** 2 for v in y_true)
        if ss_tot > 1e-12:
            r2 = 1.0 - sum(sq) / ss_tot

    ordered = sorted(errs)
    return Metrics(
        n=len(y_true),
        mae=mae,
        rmse=rmse,
        mape_pct=mape,
        r2=r2,
        median_abs_error=statistics.median(ordered),
        p90_abs_error=quantile(ordered, 0.90),
    )


def quantile(sorted_values: Sequence[float], q: float) -> float:
    """Linear-interpolated quantile of an already-sorted sequence."""
    if not sorted_values:
        raise ValueError("quantile of an empty sequence")
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    pos = q * (len(sorted_values) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = pos - lo
    return float(sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac)


@dataclass(frozen=True)
class ResidualBands:
    """
    P10/P90 offsets learned from held-out residuals.

    Empirical rather than Gaussian on purpose. Dwell residuals are right-skewed
    -- a box can sit for an extra week but cannot leave four days early -- so a
    symmetric +/-1.28 sigma band would be too wide below and too narrow above.
    """

    p10_offset: float
    p90_offset: float
    n: int

    def band(self, point: float, floor: Optional[float] = 0.0) -> Tuple[float, float]:
        lo = point + self.p10_offset
        hi = point + self.p90_offset
        if floor is not None:
            lo = max(floor, lo)
            hi = max(lo, hi)
        return lo, hi

    def as_dict(self) -> Dict[str, Any]:
        return {
            "p10_offset": round(self.p10_offset, 4),
            "p90_offset": round(self.p90_offset, 4),
            "n_residuals": self.n,
            "method": "empirical held-out residual quantiles (not Gaussian)",
        }


def residual_bands(y_true: Sequence[float], y_pred: Sequence[float]) -> ResidualBands:
    residuals = sorted(a - b for a, b in zip(y_true, y_pred))
    return ResidualBands(quantile(residuals, 0.10), quantile(residuals, 0.90),
                         len(residuals))


# ==========================================================================
# SECTION 3 -- THE RIDGE TAIL  (stdlib, always available)
# ==========================================================================


def _solve_ridge(x_rows: Sequence[Sequence[float]], y: Sequence[float],
                 alpha: float = 1.0) -> List[float]:
    """
    Ridge regression by Gauss-Jordan on the normal equations.

    Present so that the fallback chain terminates in something that always
    works: a bare CPython install with no scikit-learn still trains, still
    serves and still reports honest held-out metrics -- degraded, and badged as
    such, rather than a 500.
    """
    n_features = len(x_rows[0]) + 1                       # +1 intercept
    xtx = [[0.0] * n_features for _ in range(n_features)]
    xty = [0.0] * n_features

    for row, target in zip(x_rows, y):
        vec = [1.0] + list(row)
        for i in range(n_features):
            xty[i] += vec[i] * target
            for j in range(n_features):
                xtx[i][j] += vec[i] * vec[j]

    for i in range(1, n_features):                        # never penalise intercept
        xtx[i][i] += alpha

    aug = [xtx[i] + [xty[i]] for i in range(n_features)]
    for col in range(n_features):
        pivot = max(range(col, n_features), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot][col]) < 1e-12:
            continue                                      # singular column, leave at 0
        aug[col], aug[pivot] = aug[pivot], aug[col]
        pv = aug[col][col]
        aug[col] = [v / pv for v in aug[col]]
        for r in range(n_features):
            if r == col:
                continue
            factor = aug[r][col]
            if factor:
                aug[r] = [v - factor * w for v, w in zip(aug[r], aug[col])]
    return [aug[i][n_features] for i in range(n_features)]


class _RidgeModel:
    """The always-available tail of the engine chain."""

    name = "ridge"

    def __init__(self, alpha: float = 1.0) -> None:
        self.alpha = alpha
        self.coef: List[float] = []

    def fit(self, x_rows: Sequence[Sequence[float]], y: Sequence[float]) -> "_RidgeModel":
        self.coef = _solve_ridge(x_rows, y, self.alpha)
        return self

    def predict(self, x_rows: Sequence[Sequence[float]]) -> List[float]:
        return [self.coef[0] + sum(c * v for c, v in zip(self.coef[1:], row))
                for row in x_rows]


# ==========================================================================
# SECTION 4 -- THE ENGINE CHAIN
# ==========================================================================

ENGINE_CHAIN: Tuple[str, ...] = ("hist_gradient_boosting", "gradient_boosting",
                                 "random_forest", "ridge")


@dataclass
class FitReport:
    """What actually happened during training, in a form the API can serve."""

    engine: str
    engine_trace: List[Dict[str, str]] = field(default_factory=list)
    n_train: int = 0
    n_test: int = 0
    seed: int = 0
    feature_names: Tuple[str, ...] = ()

    def as_dict(self) -> Dict[str, Any]:
        return {
            "engine": self.engine,
            "engine_chain": list(ENGINE_CHAIN),
            "engine_trace": self.engine_trace,
            "n_train": self.n_train,
            "n_test": self.n_test,
            "seed": self.seed,
            "features": list(self.feature_names),
        }


class Regressor:
    """
    One regressor with a documented fallback chain and honest reporting.

    ``fit`` walks ``ENGINE_CHAIN`` and stops at the first engine that trains.
    Every skip is recorded with its reason. Bare ``Exception`` is caught rather
    than ``ImportError`` because a broken scikit-learn install on Windows
    raises ``OSError`` for a missing VC++ redistributable, and that must fall
    through to the next engine rather than crash a model service at boot.
    """

    def __init__(self, seed: int, feature_names: Sequence[str],
                 preferred: Optional[str] = None) -> None:
        self.seed = seed
        self.feature_names: Tuple[str, ...] = tuple(feature_names)
        self.preferred = preferred
        self._model: Any = None
        self.report = FitReport(engine="unfitted", seed=seed,
                                feature_names=tuple(feature_names))
        self.metrics: Optional[Metrics] = None
        self.bands: Optional[ResidualBands] = None

    # -- construction of each candidate engine ----------------------------
    def _build(self, name: str) -> Any:
        if name == "ridge":
            return _RidgeModel(alpha=1.0)
        if name == "hist_gradient_boosting":
            from sklearn.ensemble import HistGradientBoostingRegressor
            return HistGradientBoostingRegressor(
                max_iter=200, learning_rate=0.08, max_depth=6,
                random_state=self.seed)
        if name == "gradient_boosting":
            from sklearn.ensemble import GradientBoostingRegressor
            return GradientBoostingRegressor(random_state=self.seed)
        if name == "random_forest":
            from sklearn.ensemble import RandomForestRegressor
            return RandomForestRegressor(n_estimators=200, random_state=self.seed)
        raise ValueError(f"unknown engine {name!r}")

    def fit(self, x_train: Sequence[Sequence[float]], y_train: Sequence[float],
            x_test: Optional[Sequence[Sequence[float]]] = None,
            y_test: Optional[Sequence[float]] = None) -> "Regressor":
        if not x_train:
            raise ValueError("cannot fit on an empty training set")
        if len(x_train[0]) != len(self.feature_names):
            raise ValueError(
                f"feature count mismatch: {len(x_train[0])} columns vs "
                f"{len(self.feature_names)} names {self.feature_names}")

        chain = ENGINE_CHAIN
        if self.preferred and self.preferred in ENGINE_CHAIN:
            idx = ENGINE_CHAIN.index(self.preferred)
            chain = ENGINE_CHAIN[idx:]

        trace: List[Dict[str, str]] = []
        chosen = None
        for name in chain:
            try:
                model = self._build(name)
                model.fit(list(x_train), list(y_train))
                chosen = (name, model)
                trace.append({"engine": name, "status": "used"})
                break
            except Exception as exc:  # noqa: BLE001 - see class docstring
                trace.append({"engine": name, "status": "skipped",
                              "reason": repr(exc)[:160]})

        if chosen is None:  # pragma: no cover - ridge cannot fail on valid input
            raise RuntimeError(f"every engine failed: {trace}")

        self._model, engine_name = chosen[1], chosen[0]
        self.report = FitReport(
            engine=engine_name, engine_trace=trace, n_train=len(x_train),
            n_test=len(x_test or []), seed=self.seed,
            feature_names=self.feature_names)

        if x_test and y_test:
            preds = self.predict(x_test)
            self.metrics = regression_metrics(list(y_test), preds)
            self.bands = residual_bands(list(y_test), preds)
        return self

    def predict(self, x_rows: Sequence[Sequence[float]]) -> List[float]:
        if self._model is None:
            raise RuntimeError("predict() called before fit()")
        for row in x_rows:
            if len(row) != len(self.feature_names):
                raise ValueError(
                    f"expected {len(self.feature_names)} features "
                    f"{list(self.feature_names)}, got {len(row)}")
        return [float(v) for v in self._model.predict(list(x_rows))]

    def predict_one(self, row: Sequence[float]) -> float:
        return self.predict([row])[0]

    @property
    def engine(self) -> str:
        return self.report.engine

    @property
    def degraded(self) -> bool:
        """True when the served number comes from the stdlib tail, not a GBM."""
        return self.report.engine == "ridge"


# ==========================================================================
# SECTION 5 -- FEATURE IMPORTANCE  (permutation, engine-agnostic)
# ==========================================================================


def permutation_importance(model: Regressor, x_test: Sequence[Sequence[float]],
                           y_test: Sequence[float], seed: int = 0,
                           repeats: int = 3) -> List[Dict[str, Any]]:
    """
    Per-feature MAE increase when that column is shuffled.

    Permutation rather than the tree's own ``feature_importances_`` so the
    number means the same thing whichever engine won the fallback chain -- an
    importance chart that silently explains a different model from the one that
    produced the prediction is the failure UC1-M3 documents at length.
    """
    if not x_test:
        return []
    base = regression_metrics(list(y_test), model.predict(x_test)).mae
    rng = random.Random(seed)
    out: List[Dict[str, Any]] = []

    for col, name in enumerate(model.feature_names):
        deltas: List[float] = []
        for _ in range(repeats):
            shuffled = [list(r) for r in x_test]
            column = [r[col] for r in shuffled]
            rng.shuffle(column)
            for row, value in zip(shuffled, column):
                row[col] = value
            deltas.append(
                regression_metrics(list(y_test), model.predict(shuffled)).mae - base)
        out.append({
            "feature": name,
            "mae_increase": round(statistics.fmean(deltas), 4),
            "baseline_mae": round(base, 4),
        })
    out.sort(key=lambda d: -d["mae_increase"])
    return out


# ==========================================================================
# SECTION 6 -- ARTIFACT EXPORT  ("Link to Model Weights")
# ==========================================================================


def bundle_paths(model_key: str, root: Optional[str] = None) -> Dict[str, str]:
    """
    Where a model's artifacts live: ``trained_models/uc2/<key>/``.

    The submission's "Link to Model Weights" column points at these paths, so
    they are computed in one place rather than spelled out per model.
    """
    if root is None:
        try:
            import jnpa_paths
            root = jnpa_paths.TRAINED_MODELS_DIR
        except Exception:
            root = os.path.join(os.getcwd(), "trained_models")
    base = os.path.join(root, "uc2", model_key)
    return {
        "dir": base,
        "model": os.path.join(base, "model.joblib"),
        "metrics": os.path.join(base, "metrics.json"),
        "card": os.path.join(base, "model_card.json"),
    }


def save_bundle(model_key: str, model: Optional[Regressor], metrics: Dict[str, Any],
                card: Dict[str, Any], root: Optional[str] = None) -> Dict[str, Any]:
    """
    Write model.joblib + metrics.json + model_card.json and report what landed.

    The three files are written independently: joblib may be absent on the demo
    machine, and losing the weights export must not also lose the metrics the
    dashboard model card reads.
    """
    paths = bundle_paths(model_key, root)
    os.makedirs(paths["dir"], exist_ok=True)
    written: Dict[str, Any] = {"dir": paths["dir"], "model": None,
                               "metrics": None, "card": None, "warnings": []}

    if model is not None:
        try:
            import joblib
            joblib.dump({"model": model._model, "report": model.report.as_dict(),
                         "feature_names": list(model.feature_names)}, paths["model"])
            written["model"] = paths["model"]
        except Exception as exc:  # noqa: BLE001
            written["warnings"].append(f"joblib export skipped: {exc!r}"[:200])

    for key in ("metrics", "card"):
        payload = metrics if key == "metrics" else card
        try:
            with open(paths[key], "w", encoding="utf-8") as fh:
                json.dump(payload, fh, indent=2, default=str)
            written[key] = paths[key]
        except OSError as exc:
            written["warnings"].append(f"{key}.json write failed: {exc!r}"[:200])
    return written


def load_bundle(model_key: str, root: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Load a previously exported bundle, or ``None`` to trigger a retrain."""
    paths = bundle_paths(model_key, root)
    if not os.path.exists(paths["model"]):
        return None
    try:
        import joblib
        return joblib.load(paths["model"])
    except Exception:  # noqa: BLE001 - a stale artifact must retrain, not crash
        return None


# ==========================================================================
# SECTION 7 -- SELF-TEST
# ==========================================================================


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []
    rng = random.Random(7)

    # y = 3*x0 - 2*x1 + 5 + noise, so any working engine must recover it well.
    rows = []
    for i in range(400):
        x0, x1 = rng.uniform(0, 10), rng.uniform(0, 5)
        rows.append({"t": i, "x": [x0, x1], "y": 3 * x0 - 2 * x1 + 5 + rng.gauss(0, 0.5)})

    split = chronological_split(rows, key=lambda r: r["t"], test_fraction=0.25)
    checks.append(("chronological split sizes", len(split.train) == 300 and len(split.test) == 100,
                   f"{len(split.train)}/{len(split.test)}"))
    checks.append(("split boundary ordered",
                   split.train[-1]["t"] < split.test[0]["t"],
                   f"train ends {split.train[-1]['t']}, test starts {split.test[0]['t']}"))

    try:
        chronological_split(rows[:1], key=lambda r: r["t"])
        ok, detail = False, "accepted a 1-row split"
    except ValueError:
        ok, detail = True, "raises rather than returning an empty test set"
    checks.append(("split refuses degenerate input", ok, detail))

    model = Regressor(seed=SEED_DWELL, feature_names=("x0", "x1")).fit(
        [r["x"] for r in split.train], [r["y"] for r in split.train],
        [r["x"] for r in split.test], [r["y"] for r in split.test])
    checks.append(("engine selected", model.engine in ENGINE_CHAIN, model.engine))
    checks.append(("recovers a known relation", model.metrics is not None
                   and model.metrics.mae < 1.5,
                   f"MAE {model.metrics.mae:.3f} on y=3x0-2x1+5"))

    ridge = Regressor(seed=1, feature_names=("x0", "x1"), preferred="ridge").fit(
        [r["x"] for r in split.train], [r["y"] for r in split.train],
        [r["x"] for r in split.test], [r["y"] for r in split.test])
    checks.append(("stdlib ridge tail works", ridge.metrics.mae < 1.0,
                   f"MAE {ridge.metrics.mae:.3f} with no third-party package"))
    checks.append(("ridge flagged degraded", ridge.degraded, "engine == ridge"))

    try:
        model.predict([[1.0]])
        ok, detail = False, "accepted a 1-column row for a 2-feature model"
    except ValueError:
        ok, detail = True, "raises on feature-count mismatch"
    checks.append(("predict validates arity", ok, detail))

    m = regression_metrics([1.0, 2.0, 3.0], [1.0, 2.0, 3.0])
    checks.append(("perfect fit metrics", m.mae == 0.0 and m.rmse == 0.0 and m.r2 == 1.0,
                   "MAE 0, RMSE 0, R2 1"))

    m = regression_metrics([0.0, 2.0], [0.5, 2.5])
    checks.append(("MAPE None when a target is zero", m.mape_pct is None,
                   "no division by a legitimate zero queue"))

    bands = residual_bands([r["y"] for r in split.test],
                           model.predict([r["x"] for r in split.test]))
    lo, hi = bands.band(20.0)
    checks.append(("bands bracket the point", lo <= 20.0 <= hi,
                   f"[{lo:.2f}, {hi:.2f}] around 20.00"))
    lo, _ = bands.band(0.05, floor=0.0)
    checks.append(("bands respect the floor", lo >= 0.0, f"lower edge {lo:.3f} >= 0"))

    imps = permutation_importance(model, [r["x"] for r in split.test],
                                  [r["y"] for r in split.test], seed=3)
    checks.append(("importance ranks x0 above x1",
                   bool(imps) and imps[0]["feature"] == "x0",
                   f"top={imps[0]['feature'] if imps else 'n/a'} (true coef 3 vs -2)"))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    print("=" * 78)
    print(f"{MODULE_ID}  {MODULE_VERSION}  -- shared learning kit self-test")
    print("=" * 78)
    checks = _self_test()
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<38} {detail}")
    failed = [c for c in checks if not c[1]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
