"""Shared AI-service framework for JNPA UC2 (prompt §7).

Each model = a trainer (on synthetic event-history features), a versioned
artifact, a metrics.json (asserted by tests against bid §8.4.2 thresholds), and
a FastAPI /predict service. This package holds the shared synthetic feature
generator + serving helpers so each model file stays focused on its algorithm.
"""
from .features import make_rng, synth_dwell_dataset, synth_gate_series, synth_rake_dataset
from .serving import ModelService, MetricsReport

__all__ = [
    "make_rng",
    "synth_dwell_dataset",
    "synth_gate_series",
    "synth_rake_dataset",
    "ModelService",
    "MetricsReport",
]
