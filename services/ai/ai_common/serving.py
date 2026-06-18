"""Serving + metrics helpers shared by the AI services (prompt §7).

ModelService wraps a fitted estimator behind a FastAPI /predict (batch +
single), exposes /metrics (the committed metrics.json), and /health. MetricsReport
is the structure written to metrics.json and asserted by tests against the bid
§8.4.2 thresholds.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from typing import Any, Callable, Optional

from fastapi import FastAPI
from pydantic import BaseModel


@dataclass
class MetricsReport:
    model: str
    algorithm: str
    metric: str            # e.g. "MAE"
    value: float
    threshold: float
    passed: bool
    n_test: int
    trained_at: str
    feature_list: list[str]
    version: str = "0.1.0"

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


class PredictRequest(BaseModel):
    instances: list[list[float]]


class ModelService:
    def __init__(
        self,
        name: str,
        predict_fn: Callable[[list[list[float]]], list[float]],
        metrics: MetricsReport,
        postprocess: Optional[Callable[[float], dict]] = None,
    ):
        self.name = name
        self.predict_fn = predict_fn
        self.metrics = metrics
        self.postprocess = postprocess

    def build_app(self) -> FastAPI:
        app = FastAPI(title=f"JNPA UC2 — {self.name} AI service")

        @app.get("/health")
        def health() -> dict:
            return {"model": self.name, "ready": True, "version": self.metrics.version}

        @app.get("/metrics")
        def metrics() -> dict:
            return asdict(self.metrics)

        @app.post("/predict")
        def predict(req: PredictRequest) -> dict:
            preds = self.predict_fn(req.instances)
            out: dict[str, Any] = {"predictions": preds}
            if self.postprocess:
                out["detail"] = [self.postprocess(p) for p in preds]
            return out

        return app


def write_metrics(model_dir: str, report: MetricsReport) -> str:
    os.makedirs(os.path.join(model_dir, "models"), exist_ok=True)
    path = os.path.join(model_dir, "metrics.json")
    with open(path, "w") as f:
        f.write(report.to_json())
    return path
