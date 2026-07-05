"""Synthetic, deterministic feature datasets for the AI models (prompt §7).

These mirror the real event-history feature lists (documented in each model's
docstring + docs/) so the trained models are meaningful, while keeping the PoC
self-contained. Seeded → reproducible metrics.
"""
from __future__ import annotations

import random
from typing import Tuple

import numpy as np


def make_rng(seed: int) -> random.Random:
    return random.Random(seed)


# ---------------------------------------------------------------------------
# Dwell Predictor features (§7.1): stream, line, arrival cadence, customs-flag,
# reefer, facility load → dwell hours.
# ---------------------------------------------------------------------------
STREAMS = ["IMPORT_CFS", "IMPORT_ICD", "IMPORT_DPD", "EXPORT_CFS", "EXPORT_ICD", "EXPORT_DPE", "TRANSSHIP"]
LINES = ["MAEU", "MSCU", "CMAU", "HLCU", "ONEY", "COSU"]


def synth_dwell_dataset(n: int = 4000, seed: int = 101) -> Tuple[np.ndarray, np.ndarray]:
    """Return (X, y). X columns:
    [stream_idx, line_idx, arrival_cadence_h, customs_flag, reefer, facility_load].
    y = dwell hours. A documented synthetic generative model with noise.
    """
    rng = np.random.default_rng(seed)
    stream = rng.integers(0, len(STREAMS), n)
    line = rng.integers(0, len(LINES), n)
    cadence = rng.uniform(1, 24, n)          # hours between arrivals at facility
    customs = rng.integers(0, 2, n)          # flagged for scan
    reefer = (rng.random(n) < 0.15).astype(int)
    load = rng.uniform(0.3, 1.0, n)          # facility load factor

    # Generative dwell model (hours): DPD fast, ICD slow, customs adds, load adds.
    stream_effect = np.array([18, 30, 8, 16, 28, 10, 22])[stream]  # per stream
    dwell = (
        stream_effect
        + customs * 14
        + reefer * 4
        + load * 20
        + cadence * 0.3
        + rng.normal(0, 4, n)
    )
    dwell = np.clip(dwell, 2, None)
    X = np.column_stack([stream, line, cadence, customs, reefer, load]).astype(float)
    return X, dwell


# ---------------------------------------------------------------------------
# Gate Queue Forecaster series (§7.2): per-gate queue length time series with an
# hour-of-day profile + UC3 cross-twin truck-arrival influence.
# ---------------------------------------------------------------------------
def synth_gate_series(steps: int = 2000, seed: int = 202) -> Tuple[np.ndarray, np.ndarray]:
    """Return (X, y) for next-step queue prediction. X = [lag1, lag2, hour_sin,
    hour_cos, uc3_truck_inflow]; y = next queue length.
    """
    rng = np.random.default_rng(seed)
    profile = np.array([0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.8, 1.1, 1.4, 1.5, 1.4, 1.2,
                        1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.2, 0.9, 0.7, 0.6, 0.5, 0.4])
    q = np.zeros(steps + 2)
    inflow = np.zeros(steps + 2)
    rows, ys = [], []
    for t in range(2, steps + 2):
        hour = t % 24
        uc3 = rng.poisson(3 * profile[hour])     # cross-twin truck inflow (UC3)
        inflow[t] = uc3
        served = 6
        q[t] = max(0, q[t - 1] + uc3 - served + rng.normal(0, 1))
        rows.append([q[t - 1], q[t - 2], np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24), uc3])
        ys.append(q[t])
    return np.array(rows), np.array(ys)


# ---------------------------------------------------------------------------
# Rake TAT Forecaster (§7.3): predict placement/removal offsets from arrival.
# Features: [siding, cto_idx, wagon_count, hour, inbound]; y = TAT hours.
# ---------------------------------------------------------------------------
# Synthetic Container Train Operator codes (Guardrail §10: no real CTO brands).
CTOS = ["CTO-1", "CTO-2", "CTO-3", "CTO-4"]


def synth_rake_dataset(n: int = 2500, seed: int = 303) -> Tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    siding = rng.integers(0, 2, n)            # T1=0, T2=1
    cto = rng.integers(0, len(CTOS), n)
    wagons = rng.integers(40, 46, n)
    hour = rng.integers(0, 24, n)
    inbound = rng.integers(0, 2, n)
    tat = (
        7.0
        + siding * 0.8
        + wagons * 0.04
        + (hour > 18) * 1.5
        + inbound * 0.6
        + rng.normal(0, 1.0, n)
    )
    tat = np.clip(tat, 3, None)
    X = np.column_stack([siding, cto, wagons, hour, inbound]).astype(float)
    return X, tat
