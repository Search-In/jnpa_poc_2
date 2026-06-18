"""Container Dwell Predictor (prompt §7.1) — gradient-boosted regression on
event-history features (stream, line, arrival cadence, customs-flag, reefer,
facility load) → predicted dwell hours. Reports MAE.

Production uses LightGBM/XGBoost; the PoC uses scikit-learn's
HistGradientBoostingRegressor (same GBM family, no native build) so the service
runs anywhere. Swapping to LightGBM is a one-line estimator change.
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
from ai_common.features import synth_dwell_dataset  # noqa: E402
from ai_common.serving import MetricsReport, ModelService, write_metrics  # noqa: E402

FEATURES = ["stream_idx", "line_idx", "arrival_cadence_h", "customs_flag", "reefer", "facility_load"]
MAE_THRESHOLD_H = 8.0  # bid §8.4.2: dwell MAE target (hours)


def train():
    X, y = synth_dwell_dataset()
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=0)
    model = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.08, max_depth=6, random_state=0)
    model.fit(Xtr, ytr)
    mae = float(mean_absolute_error(yte, model.predict(Xte)))
    report = MetricsReport(
        model="container-dwell-predictor",
        algorithm="HistGradientBoostingRegressor (GBM; prod=LightGBM)",
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


def _postprocess(dwell_h: float) -> dict:
    return {"predictedDwellHours": dwell_h, "predictedDepartureWindowH": [max(0, dwell_h - 4), dwell_h + 4]}


service = ModelService("container-dwell-predictor", _predict, _report, _postprocess)
app = service.build_app()
