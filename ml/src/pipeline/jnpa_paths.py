"""
jnpa_paths -- one place that knows where everything lives.

Before the repository was reorganised every script sat next to its data, so a
bare relative path ("dsr_berth_stays.csv", "models/") happened to work as long
as you ran the script from the repository root. That is a silent trap: run the
same command from any other directory and the model quietly falls back to
synthetic data instead of erroring.

Every default path is now derived from this file's own location, so the tools
behave identically regardless of the current working directory.

Layout
------
    <root>/
      run.py                     single CLI entry point
      src/uc1_models/            the eight UC-1 model modules (self-contained)
      src/uc2_models/            the seven UC-2 model modules (self-contained)
      src/pipeline/              input reader, runners, trainer, extractor
      src/service/               FastAPI apps
      data/input/                vessel-call spreadsheets fed to the models
      data/input/uc2/            sample request payloads, one per UC-2 model
      data/reference/            berth roster + extracted DSR berth stays
      data/corpus/               the raw JNPA document corpus (read-only)
      trained_models/            trained .pkl / .json artifacts
      out/                       generated predictions
      out/uc2/                   sample UC-2 responses, one per model
      docs/                      specs, runbook, model explainer
"""

from __future__ import annotations

import os

# src/pipeline/jnpa_paths.py -> src/pipeline -> src -> <root>
PIPELINE_DIR: str = os.path.dirname(os.path.abspath(__file__))
SRC_DIR: str = os.path.dirname(PIPELINE_DIR)
PROJECT_ROOT: str = os.path.dirname(SRC_DIR)

UC1_MODELS_DIR: str = os.path.join(SRC_DIR, "uc1_models")
UC2_MODELS_DIR: str = os.path.join(SRC_DIR, "uc2_models")
SERVICE_DIR: str = os.path.join(SRC_DIR, "service")

DATA_DIR: str = os.path.join(PROJECT_ROOT, "data")
INPUT_DIR: str = os.path.join(DATA_DIR, "input")
UC2_INPUT_DIR: str = os.path.join(INPUT_DIR, "uc2")
REFERENCE_DIR: str = os.path.join(DATA_DIR, "reference")
CORPUS_DIR: str = os.path.join(DATA_DIR, "corpus")

TRAINED_MODELS_DIR: str = os.path.join(PROJECT_ROOT, "trained_models")
OUT_DIR: str = os.path.join(PROJECT_ROOT, "out")
UC2_OUT_DIR: str = os.path.join(OUT_DIR, "uc2")
DOCS_DIR: str = os.path.join(PROJECT_ROOT, "docs")

# Named files the tools default to.
SAMPLE_INPUT_XLSX: str = os.path.join(INPUT_DIR, "Vessel_Training_Input_Sample.xlsx")
BERTHS_JSON: str = os.path.join(REFERENCE_DIR, "berths.json")
DSR_BERTH_STAYS_CSV: str = os.path.join(REFERENCE_DIR, "dsr_berth_stays.csv")
DSR_REPORTS_DIR: str = os.path.join(
    CORPUS_DIR, "UC-I_Vessel_Traffic", "M3_TAT_Prediction_Calibration",
    "Daily_Status_Reports",
)

# --- UC-II cargo-handling corpus -----------------------------------------
# The shared corpus arrived pre-foldered per UC-II model, so each model module
# names the folder it validates against instead of globbing the whole tree.
UC2_CORPUS_DIR: str = os.path.join(CORPUS_DIR, "UC-II_Cargo_Handling")
UC2_M1_DIR: str = os.path.join(UC2_CORPUS_DIR, "M1_Container_Dwell_Prediction")
UC2_M2_DIR: str = os.path.join(UC2_CORPUS_DIR, "M2_Rake_TAT_Forecast")
UC2_M3_DIR: str = os.path.join(UC2_CORPUS_DIR, "M3_Gate_Queue_Forecast")
UC2_M4_DIR: str = os.path.join(UC2_CORPUS_DIR, "M4_Event_Sequence_Anomaly")
UC2_M5_DIR: str = os.path.join(UC2_CORPUS_DIR, "M5_Discharge_Rate_Berth_Stay")
UC2_M7_DIR: str = os.path.join(UC2_CORPUS_DIR, "M7_Empty_Pool_Reefer")


def ensure_on_syspath() -> None:
    """
    Make the three source folders importable as flat module names.

    The eight ``uc1_m*`` and seven ``uc2_m*`` modules are deliberately
    import-free of each other, so they can be lifted into another codebase one
    file at a time. Keeping them as top-level modules (rather than a package)
    preserves that property; this function is what makes it work after the
    split into folders.
    """
    import sys

    for d in (PIPELINE_DIR, UC1_MODELS_DIR, UC2_MODELS_DIR, SERVICE_DIR):
        if d not in sys.path:
            sys.path.insert(0, d)


def relative(path: str) -> str:
    """Path shown to humans: relative to the project root when it is inside it."""
    try:
        rel = os.path.relpath(os.path.abspath(path), PROJECT_ROOT)
    except ValueError:  # different drive on Windows
        return path
    return path if rel.startswith("..") else rel.replace(os.sep, "/")
