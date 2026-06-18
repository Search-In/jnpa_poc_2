"""Gate Queue Forecaster (prompt §7.2) — temporal model predicting 30–120 min
per-gate queue length, ingesting UC3 cross-twin truck-inflow events. Output
per-gate queue curve + recommended deferred-arrival windows.

Production uses an LSTM / Temporal Fusion Transformer; the PoC uses a gradient-
boosted autoregressor over lag + hour-of-day + UC3 inflow features (same I/O
contract). Reports RMSE on next-step queue.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_squared_error
from sklearn.model_selection import train_test_split

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from ai_common.features import synth_gate_series  # noqa: E402
from ai_common.serving import MetricsReport, ModelService, write_metrics  # noqa: E402

FEATURES = ["queue_lag1", "queue_lag2", "hour_sin", "hour_cos", "uc3_truck_inflow"]
RMSE_THRESHOLD = 3.5  # vehicles


def train():
    X, y = synth_gate_series()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
    model = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.07, random_state=0)
    model.fit(Xtr, ytr)
    rmse = float(np.sqrt(mean_squared_error(yte, model.predict(Xte))))
    report = MetricsReport(
        model="gate-queue-forecaster",
        algorithm="GBM autoregressor (prod=LSTM/TFT)",
        metric="RMSE",
        value=round(rmse, 3),
        threshold=RMSE_THRESHOLD,
        passed=rmse <= RMSE_THRESHOLD,
        n_test=len(yte),
        trained_at=datetime.now(timezone.utc).isoformat(),
        feature_list=FEATURES,
    )
    return model, report


_model, _report = train()
write_metrics(os.path.dirname(__file__), _report)


def _predict(instances):
    arr = np.array(instances, dtype=float)
    return [round(max(0.0, float(v)), 2) for v in _model.predict(arr)]


def _postprocess(queue: float) -> dict:
    return {"predictedQueue": queue, "deferralRecommended": queue > 8}


service = ModelService("gate-queue-forecaster", _predict, _report, _postprocess)
app = service.build_app()
