"""Rail-Side Rake Turnaround Forecaster (prompt §7.3) — sequence model
predicting placement/removal times for T1/T2 sidings; output ETA placement, ETA
removal, departure window. PoC: GBM regressor on rake features (prod = sequence
model). Reports MAE (hours).
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ai_common.features import synth_rake_dataset  # noqa: E402
from ai_common.serving import MetricsReport, ModelService, write_metrics  # noqa: E402

FEATURES = ["siding", "cto_idx", "wagon_count", "arrival_hour", "inbound"]
MAE_THRESHOLD_H = 2.0


def train():
    X, y = synth_rake_dataset()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
    model = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.08, random_state=0)
    model.fit(Xtr, ytr)
    mae = float(mean_absolute_error(yte, model.predict(Xte)))
    report = MetricsReport(
        model="rake-tat-forecaster",
        algorithm="GBM regressor (prod=sequence model)",
        metric="MAE",
        value=round(mae, 3),
        threshold=MAE_THRESHOLD_H,
        passed=mae <= MAE_THRESHOLD_H,
        n_test=len(yte),
        trained_at=datetime.now(timezone.utc).isoformat(),
        feature_list=FEATURES,
    )
    return model, report


_model, _report = train()
write_metrics(os.path.dirname(__file__), _report)


def _predict(instances):
    arr = np.array(instances, dtype=float)
    return [round(float(v), 2) for v in _model.predict(arr)]


def _postprocess(tat_h: float) -> dict:
    # placement ~ 25% of TAT, removal ~ 80% of TAT, departure = TAT
    return {
        "etaPlacementH": round(tat_h * 0.25, 2),
        "etaRemovalH": round(tat_h * 0.8, 2),
        "departureWindowH": [round(tat_h - 1, 2), round(tat_h + 1, 2)],
    }


service = ModelService("rake-tat-forecaster", _predict, _report, _postprocess)
app = service.build_app()
