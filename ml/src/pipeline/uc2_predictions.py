"""
uc2_predictions -- one call, one document, every UC-II model, per container.
============================================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

WHY THIS MODULE EXISTS
----------------------
``uc2_webapp_adapter`` already translates a JNPA journey-sheet row into every
model's contract, and serves twelve endpoints under ``/uc2/webapp``. All twelve
are PER-MODEL. A panel that wants to show an operator what the whole UC-II
suite says about one container would have to make five or six calls, stitch the
answers together, and invent its own idea of which models apply to which box.

That stitching is domain logic, and domain logic in a frontend is domain logic
that drifts. So it lives here: ONE request carrying the rows the UI already
holds, ONE response shaped like a dashboard, with a mapping ledger per row.

WHAT IT DOES NOT DO
-------------------
It does not predict anything. Every number in the response comes out of
``uc2_webapp_adapter``, which in turn calls the seven audited model modules
untouched. This module chooses *which* models to run for a row, folds the
answers into one document, and attaches the glossary. Nothing else.

It also does not estimate. Where a model input is missing the ADAPTER
substitutes a named constant and records it in ``mapping.assumptions[]``; that
is the only place a substitution is allowed to happen. See ``normalise_row()``
for the one translation this module does own, and note that it is recorded too.

WHICH MODELS APPLY TO A CONTAINER
---------------------------------
This is the question the per-model endpoints leave to the caller, and getting it
wrong is how a panel ends up telling an operator that three gate lanes are down
*as a fact about the box in front of them*.

    PER CONTAINER   M1 dwell        how long will THIS box sit
                    M4 chain        is THIS box's paperwork chain broken
    CONTEXTUAL      M2 rake TAT     only when the box moves by rail
                    M3 gate queue   only when the box moves by road
                    M5 berth stay   only when the row names a vessel
    FACILITY-LEVEL  M6 lanes        describes the GATE, not the box
                    M7 empties/reefer   describes the YARD, not the box

The facility-level answers are returned in a separate ``facility_summary``
block, never inside a container, so the UI cannot render them as if they were
properties of one container. ``facility_scope`` says in words what set they
describe.

WHY THE BATCH IS THE UNIT
-------------------------
``arrival_cadence_h`` -- hours since the previous container arrived at the same
facility -- is not a property of a row. It is only measurable ACROSS rows. Send
one container and M1 falls back to the 6.0 h default and raises ``degraded``;
send the visible page and the cadence is measured. M6 and M7 are the same story
at facility scale. So the endpoint takes the page, scores it once, and the UI
reads each row out of the same document.

USAGE
-----
    python uc2_predictions.py --selftest
    python uc2_predictions.py --demo            # score the sample workbook rows

    from uc2_predictions import predict_containers
    doc = predict_containers(rows, focus="MAEU6123458")
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

for _extra in (os.path.dirname(os.path.abspath(__file__)),
               os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "uc2_models")):
    if _extra not in sys.path:
        sys.path.append(_extra)

import uc2_webapp_adapter as adapter          # noqa: E402
import uc2_m1_container_dwell as m1           # noqa: E402
import uc2_m2_rake_tat as m2                  # noqa: E402
import uc2_m3_gate_queue as m3                # noqa: E402
import uc2_m4_event_anomaly as m4             # noqa: E402
import uc2_m5_discharge_berth_stay as m5      # noqa: E402
import uc2_m6_lane_assignment as m6           # noqa: E402
import uc2_m7_empty_pool_reefer as m7         # noqa: E402

JnpaRow = Dict[str, Any]

MODULE_ID: str = "UC2-PREDICTIONS"
MODULE_NAME: str = "UC-II per-container prediction fan-out"
MODULE_VERSION: str = "predictions-v1.0.0"
ROUTER_PREFIX: str = "/uc2/webapp"

#: The envelope this module returns.
SCHEMA_VERSION: str = "uc2-webapp-predictions/1.0.0"
#: The document inside it -- the shape run_uc2.py already publishes, reused
#: rather than reinvented so panel numbers and evidence-pack numbers agree.
DASHBOARD_SCHEMA: str = "uc2-dashboard/1.0.0"

#: Containers scored in one call. The Movements table renders 50 rows, so 60
#: covers the visible page with headroom. Above this the request is TRIMMED and
#: the count reported in run.containers_dropped -- never silently shortened.
MAX_BATCH: int = 60

#: Block ids, in the order the panel shows them.
PER_CONTAINER_MODELS: Tuple[str, ...] = ("UC2-M1", "UC2-M4")
CONTEXTUAL_MODELS: Tuple[str, ...] = ("UC2-M2", "UC2-M3", "UC2-M5")
FACILITY_MODELS: Tuple[str, ...] = ("UC2-M6", "UC2-M7")
ALL_MODELS: Tuple[str, ...] = PER_CONTAINER_MODELS + CONTEXTUAL_MODELS + FACILITY_MODELS


# ==========================================================================
# SECTION 1 -- THE PLAIN-ENGLISH QUESTION EACH MODEL ANSWERS
#
# Rendered on an info affordance beside each card title, so an operator who
# has not read the model docs still knows what they are looking at. Taken from
# docs/WS2_UC2_AI_ML_Tools.md, not paraphrased here.
# ==========================================================================

MODEL_QUESTIONS: Dict[str, str] = {
    "UC2-M1": "How many hours will this box sit before it leaves the terminal?",
    "UC2-M2": "How long is this train on the siding, from arrival to departure?",
    "UC2-M3": "How many trucks will be queued at the gate in the next hour?",
    "UC2-M4": "Is this container's document and event chain broken, and how?",
    "UC2-M5": "Is this vessel running to plan, and when does she finish working?",
    "UC2-M6": "Lanes are down or demand has shifted -- how should the gate be run?",
    "UC2-M7": "Are there enough empties in the pool, and enough reefer plugs?",
}

#: What set each facility-level block describes. This wording reaches the
#: screen: it is the difference between "3 lanes are down at the gate" and an
#: operator reading "3 lanes down" as a fact about the container they opened.
FACILITY_SCOPE: Dict[str, str] = {
    "UC2-M6": ("Describes the GATE across every container in this request, not "
               "the single container on screen."),
    "UC2-M7": ("Describes the YARD's empty pool and reefer plug bank across "
               "every container in this request, not the single container on "
               "screen."),
}


# ==========================================================================
# SECTION 2 -- THE GLOSSARY
#
# Every key that reaches the screen carries a one-line definition, and
# `selftest()` FAILS if a rendered key has neither a gloss nor a place in
# SELF_EVIDENT_KEYS. That check is what makes generic rendering honest rather
# than lazy: the panel iterates whatever the service returns, so a field with
# no definition would reach an operator as an unexplained number.
#
# The five keys the delivery's own uc2_dashboard.json glosses are reproduced
# verbatim -- two definitions of `realCorpusMaeH` would be worse than none.
# ==========================================================================

GLOSSARY: Dict[str, str] = {
    # --- shared across models ---------------------------------------------
    "degraded": "A fallback produced this number. Render the badge.",
    "headline": "One line fit for a card title.",
    "engine": "Which engine actually computed this: the learned model, or the "
              "documented fallback it degrades to.",
    "decision_path": "One-line audit trail of the choices behind this number: "
                     "engine, data series, split protocol, caller-supplied inputs.",
    "moduleId": "Which UC-II model produced this block.",
    "model_version": "Version of the model that produced this number.",
    "trained_at": "When the model behind this number was last trained.",

    # --- M1 container dwell -----------------------------------------------
    "dwellHours": "Predicted hours between gate-in and gate-out for this container.",
    "windowHours": "The p10-p90 band around the dwell prediction. Read the band, "
                   "not the point.",
    "p10Hours": "10th percentile of the dwell forecast -- the optimistic end.",
    "p50Hours": "Median of the dwell forecast. This is the headline figure.",
    "p90Hours": "90th percentile of the dwell forecast -- the pessimistic end.",
    "predictedDepartureWindowH": "The forecast band expressed as hours from gate-in.",
    "predictedDepartureUtc": "Calendar time this container is forecast to leave, "
                             "computed by the service so the UI does no date arithmetic.",
    "predictedDepartureWindowUtc": "The p10 and p90 departure times as calendar times.",
    "gateInUtc": "The arrival timestamp the dwell forecast was measured from.",
    "headlineAccuracyMaeH": "Mean absolute error in hours ON A SEEDED SYNTHETIC "
                            "GENERATOR. Not interchangeable with realCorpusMaeH.",
    "realCorpusMaeH": ("UC2-M1 only: error on real container stays, published beside "
                       "the synthetic headline and NOT interchangeable with it."),
    "realCorpusBeatsBaseline": "Whether M1 beats a plain median baseline on the real "
                               "corpus. It does not. That is published, not hidden.",
    "realCorpusBaselineMaeH": "The median baseline M1 is measured against on the real "
                              "corpus.",
    "realStaysObserved": "How many real container stays the corpus calibration saw.",
    "calibrationSource": "CORPUS when calibrated on real stays; a FALLBACK value means "
                         "the corpus was unavailable and the figure is synthetic.",
    "accuracyDisclosure": "Why this model publishes two accuracies that must never be "
                          "blended into one.",
    "realCorpusMetricsAvailable": "False when the real-stay error could not be "
                                  "recomputed in this deployment. The synthetic figure "
                                  "beside it is NOT a substitute for it.",
    "realCorpusUnavailableReason": "Why the real-corpus accuracy is missing, so a lone "
                                   "synthetic figure is never read as the whole story.",

    # --- M2 rake TAT -------------------------------------------------------
    "tatHours": "Forecast hours the rake spends on the siding, arrival to departure.",
    "etaPlacementH": "Hours until the rake is placed on the siding.",
    "etaRemovalH": "Hours until the rake is removed from the siding.",
    "departureWindowH": "The band around the forecast rake departure, in hours.",
    "fidelityMaeH": "How closely the learned engine reproduces the deterministic "
                    "handling model. This is FIDELITY, not accuracy.",
    "metricIsFidelityNotAccuracy": ("UC2-M2 only: the error is measured against a "
                                    "deterministic model, not against an observed rake "
                                    "TAT, because the corpus has none."),
    "realRakesExercised": "How many real rakes the model was exercised against. "
                          "Exercised, not scored -- there is no observed TAT to score to.",
    "realTatMedianH": "Median turnaround of the real rakes, for context only.",
    "breakdown": "Every term of the handling model with its arithmetic substituted -- "
                 "the 'why' behind the number.",

    # --- M3 gate queue -----------------------------------------------------
    "queueVehicles": "Forecast vehicles queued at the gate in the next hour.",
    "estimatedWaitMinutes": "Forecast wait for a truck joining the queue now.",
    "deferralRecommended": "True when the forecast queue justifies telling hauliers to "
                           "come later.",
    "p10": "10th percentile of the queue forecast.",
    "p50": "Median of the queue forecast.",
    "p90": "90th percentile of the queue forecast.",
    "rmse": "Root-mean-square error of the served model, in vehicles.",
    "splitPolicy": "Which train/test split produced the served metric. Rolling-origin "
                   "is the one that counts; the others exist for comparison.",
    "seriesSource": "CORPUS when the real gate series was read; SYNTHETIC means the "
                    "corpus was unavailable and the series was generated.",
    "realGateMovements": "How many real gate movements the series carried.",
    "leakageCheck": ("UC2-M3 only: the same model scored under all three split "
                     "protocols. servedRmse is the one that counts."),
    "servedRmse": "Error under the rolling-origin split -- the protocol actually served.",
    "shuffledRmse": "Error under a shuffled split. Published FOR COMPARISON ONLY: it "
                    "leaks the future and always flatters the model.",
    "tailRmse": "Error on a chronological tail hold-out. For comparison only.",

    # --- M4 event / chain anomaly -----------------------------------------
    "findings": "The R1-R6 rules this container's event chain broke.",
    "findingCount": "How many rules the chain broke.",
    "clean": "True when the container's event chain broke no rule.",
    "worstSeverity": "Severity of the most serious finding: CRIT outranks WARN.",
    "eventCount": "How many lifecycle events the chain was assembled from.",
    "trailUsed": "The chronological event trail the rules were actually run on -- so a "
                 "finding can be checked against what the model saw.",
    "precision": "Of the chains M4 flags, the share that really are broken.",
    "recall": "Of the broken chains present, the share M4 finds.",
    "f1": "The harmonic mean of precision and recall.",
    "ruleId": "Which of the R1-R6 rules produced this finding.",
    "severity": "How serious a single finding is.",
    "reason": "Why the rule fired, in words.",

    # --- M5 discharge / berth stay ----------------------------------------
    "projectedTotalStayHours": "Forecast total hours this vessel occupies the berth.",
    "varianceVsPlanHours": "Hours ahead of (negative) or behind (positive) the berthing "
                           "plan.",
    "status": "The model's verdict in one word.",
    "rateSource": "'observed' when the crane rate came from live TOS progress; anything "
                  "else means an assumed rate and a weaker projection.",
    "realCallsTracked": "How many real TOS vessel calls the model was checked against.",
    "meanStayVarianceH": "Average plan-versus-actual berth-stay variance across those "
                         "calls.",

    # --- M6 lane assignment (facility) ------------------------------------
    "worstWaitMinutes": "Longest wait any movement class faces under this lane plan.",
    "throttleRecommended": "True when the plan cannot serve demand and arrivals should "
                           "be metered.",
    "unservable": "Movements per hour the open lanes cannot serve, by class.",
    "openLanes": "Lanes the plan runs.",
    "closedLanes": "Lanes reported down, which this plan works around.",
    "waitIncreaseVsBaselineMin": "Extra wait this plan carries versus the all-lanes-open "
                                 "baseline.",
    "lanePlan": "Which movement classes each open lane serves.",

    # --- M7 empty pool / reefer (facility) --------------------------------
    "shortfall": "Reefer containers with no plug to go to.",
    "hoursToFirstRisk": "Hours until the first reefer breaches its sensitivity hold time.",
    "priorityEvacuation": "Which reefers to move first, most temperature-sensitive first.",
    "poolTotal": "Containers in the yard snapshot this balance was computed from.",
    "poolEmpties": "Empty containers in that snapshot.",
    "poolReefers": "Reefer containers in that snapshot.",
    "poolSource": "CORPUS when the real line inventories were read; anything else means "
                  "the pool is not measured.",
    "shortTerminals": "Terminals short of empties against their forecast demand.",
    "balances": "Empty surplus or deficit per terminal.",
    "repositionPlan": "Suggested empty moves between terminals to clear the deficits.",

    # --- envelope / run metadata ------------------------------------------
    "facility_scope": "What set a facility-level figure describes -- deliberately NOT "
                      "the single container on screen.",
    "focus": "True for the container the operator actually opened. It is scored first "
             "and is never dropped by the per-call cap.",
    "models_run": "Which models produced a block anywhere in this document.",
    "containers_requested": "How many containers the UI asked to score.",
    "containers_scored": "How many were actually scored in this call.",
    "containers_dropped": "How many were left out because the request exceeded the "
                          "per-call cap.",
    "dropped_reason": "Why containers were left out.",
    "models_failed": "Models that raised in this run, with the error. A model that did "
                     "not run is reported, never quietly omitted.",
    "cadence_measured_rows": "Rows whose arrival cadence was MEASURED from the batch "
                             "rather than assumed. More is better.",
    "cadence_assumed_rows": "Rows that fell back to the named default cadence because "
                            "the batch held no earlier arrival at their terminal.",
    "inputs_observed": "Model inputs that came from a column in the row.",
    "inputs_assumed": "Model inputs the row could not supply, so a published constant "
                      "was used. Each one is named in assumptions.",
    "assumptions": "Every substitution this row's prediction rests on, in words.",
    "warnings": "Notes about the translation that do not change a value.",
    "derived": "One entry per model input: source column, raw value, mapped value, and "
               "the rule that did it.",
    "adapter_version": "Version of the translation layer between the UI row and the "
                       "model contracts.",
}

#: Keys that need no gloss because the word IS the definition. Mirrors the
#: intent of UC-1's dashboard_json.SELF_EVIDENT_KEYS. Anything not here and not
#: in GLOSSARY fails selftest().
SELF_EVIDENT_KEYS: frozenset = frozenset({
    "container", "terminal", "vessel", "stream", "line", "siding", "gate",
    "count", "results", "models", "mapping", "input", "note", "hours",
    "schema", "schema_version", "generated_at_utc", "run", "glossary",
    "model_questions", "containers", "facility_summary", "adapter",
    "moduleId", "version", "scope", "value", "source", "raw", "rule",
    "observed", "model_input", "sheet", "target_module", "error", "model",
    "eventType", "ts", "finding_type", "cadence", "method", "measured_rows",
    "assumed_rows", "status_detail", "id", "name", "label", "type",
    # The seven model ids. They key `models` and `facility_summary`, and the
    # document already ships MODEL_QUESTIONS — a plain-English sentence per id,
    # which is a better definition than a glossary line would be.
    *ALL_MODELS,
})


# ==========================================================================
# SECTION 3 -- ROW NORMALISATION
#
# The ONE translation this module owns, and the reason it is here and not in
# the frontend.
#
# The Movements table holds a `ContainerMovementDTO`. Its fields are already
# observed facts -- `originStream: "IMPORT_DPD"`, `laden: false` -- so the UI
# passes them through verbatim under their own names. But turning
# "IMPORT_DPD" into the adapter's `DPD_Eligible` / `Delivery_Mode` columns is a
# MAPPING, and a mapping in the frontend is a second copy of domain knowledge
# that will disagree with this one sooner or later (Gotcha 4). So the UI sends
# what it observed; the expansion happens here, versioned and ledgered.
# ==========================================================================

#: OriginStream (packages/schemas) -> the adapter columns that encode it.
#: The names on the left are the app's own enum values, unmodified.
ORIGIN_STREAM_TO_COLUMNS: Dict[str, Dict[str, Any]] = {
    "IMPORT_CFS": {"Pre_Advice_Type": "IMPORT", "Delivery_Mode": "C"},
    "IMPORT_ICD": {"Pre_Advice_Type": "IMPORT", "Arrival_Mode": "ICD Rail"},
    "IMPORT_DPD": {"Pre_Advice_Type": "IMPORT", "Delivery_Mode": "D",
                   "DPD_Eligible": "Yes"},
    "EXPORT_CFS": {"Pre_Advice_Type": "EXPORT", "Delivery_Mode": "C"},
    "EXPORT_ICD": {"Pre_Advice_Type": "EXPORT", "Arrival_Mode": "ICD Rail"},
    "TRANSSHIPMENT": {"Pre_Advice_Type": "IMPORT", "Delivery_Mode": "G"},
    "EMPTY_RETURN": {"Container_Status": "MTY"},
}


def normalise_row(row: JnpaRow) -> Tuple[JnpaRow, List[str]]:
    """
    Expand app-native columns into the adapter's PCS column names. Pure.

    Returns the enriched row and a list of the expansions performed, in words,
    so they can be folded into the row's ledger. An expansion never OVERWRITES
    a column the caller supplied: an explicit value always beats a derived one.
    """
    out = dict(row)
    notes: List[str] = []

    stream = adapter._norm(adapter.read_text(row, "Origin_Stream", "originStream"))
    if stream and stream in ORIGIN_STREAM_TO_COLUMNS:
        for column, value in ORIGIN_STREAM_TO_COLUMNS[stream].items():
            if out.get(column) in (None, ""):
                out[column] = value
                notes.append(f"{column}={value} from Origin_Stream={stream}")
    elif stream:
        notes.append(f"Origin_Stream={stream!r} is not a known stream; left for the "
                     f"adapter's own direction evidence to resolve")

    # `laden: false` is an OBSERVED fact about the box, and M1's strongest
    # single signal (an empty is an EMPTY_RETURN whatever else the row says).
    laden = adapter.read_bool(row, "Laden", "laden")
    if laden is False and out.get("Container_Status") in (None, ""):
        out["Container_Status"] = "MTY"
        notes.append("Container_Status=MTY from Laden=false")

    return out, notes


# ==========================================================================
# SECTION 4 -- MODEL-CARD METRICS
#
# The published accuracy figures are properties of a MODEL, not of a row, so
# they are read once per process and merged into every row's block. Three of
# them must never be smoothed, and each is carried here under a key whose
# glossary entry says why (see GLOSSARY above):
#
#   M1  two accuracies -- 3.69 h synthetic AND 21.36 h on 254 real stays,
#       where it LOSES to a 15.74 h median baseline. Both ship. Never blended.
#   M2  the metric is FIDELITY. There is no observed rake TAT to be accurate
#       to, so the word "accuracy" never appears against it.
#   M3  three split protocols, one of which is served. The leakage figures
#       travel with the name of the protocol that produced them.
# ==========================================================================

_METRICS_CACHE: Optional[Dict[str, Dict[str, Any]]] = None


def model_metrics() -> Dict[str, Dict[str, Any]]:
    """Published metrics per model. Computed once, then cached."""
    global _METRICS_CACHE
    if _METRICS_CACHE is not None:
        return _METRICS_CACHE

    out: Dict[str, Dict[str, Any]] = {}

    predictor = m1.get_predictor()
    validation = predictor.validate_against_corpus()
    card = predictor.model_card()
    real_mae = validation.get("metrics", {}).get("mae")
    out["UC2-M1"] = {
        "headlineAccuracyMaeH": round(predictor.model.metrics.mae, 3),
        "realCorpusMaeH": real_mae,
        "realCorpusBaselineMaeH": validation.get("baseline", {}).get("mae"),
        "realCorpusBeatsBaseline": validation.get("beats_baseline"),
        "realStaysObserved": predictor.calibration.n_observed,
        "calibrationSource": predictor.calibration.source,
        "accuracyDisclosure": card.get("disclosure"),
        # M1 publishes TWO accuracies and neither may be shown alone. In a
        # checkout without the corpus the real-corpus figure cannot be
        # RECOMPUTED, which would leave only the flattering synthetic number on
        # screen -- exactly the smoothing the model's own disclosure forbids.
        # The figure is not fabricated back in; instead its absence is stated,
        # so the UI renders "not measurable here" rather than nothing at all.
        "realCorpusMetricsAvailable": real_mae is not None,
        "realCorpusUnavailableReason": (
            None if real_mae is not None else
            (f"{validation.get('reason', 'the real corpus is not present')} -- this "
             f"deployment excludes the UC-II corpus, so the real-stay error cannot be "
             f"recomputed here. The synthetic figure beside it is NOT a substitute for "
             f"it. See ml/data/corpus/README.md.")),
    }

    forecaster = m2.get_forecaster()
    exercise = forecaster.validate_against_corpus()
    out["UC2-M2"] = {
        "fidelityMaeH": round(forecaster.model.metrics.mae, 3),
        # Not a rounding of an accuracy: there is nothing to be accurate to.
        "metricIsFidelityNotAccuracy": True,
        "realRakesExercised": (exercise.get("n_cto_manifests", 0)
                               + exercise.get("n_fois_intimations", 0)),
        "realTatMedianH": exercise.get("tat_distribution_h", {}).get("median"),
    }

    queue = m3.get_forecaster()
    leak = queue.leakage
    out["UC2-M3"] = {
        "rmse": round(queue.metrics_obj.rmse, 4),
        "splitPolicy": queue.split_info.get("policy"),
        "seriesSource": queue.series_info.source if queue.series_info else None,
        "realGateMovements": (queue.series_info.arrivals_total
                              if queue.series_info else None),
        "leakageCheck": {
            "servedRmse": leak.get("chronological", {}).get("rmse"),
            "shuffledRmse": leak.get("shuffled_for_comparison_only", {}).get("rmse"),
            "tailRmse": leak.get("chronological_tail_for_comparison_only", {}).get("rmse"),
        },
    }

    trail_metrics = m4.evaluate().get("trail_level", {})
    out["UC2-M4"] = {
        "precision": trail_metrics.get("precision"),
        "recall": trail_metrics.get("recall"),
        "f1": trail_metrics.get("f1"),
    }

    _METRICS_CACHE = out
    return out


# ==========================================================================
# SECTION 5 -- WHICH CONTEXTUAL MODELS A ROW SUPPORTS
#
# A row earns a contextual model by carrying the evidence that model needs --
# never by a default. A box with no rail column gets no rake forecast, because
# a rake forecast for a box that is not on a train is noise dressed as insight.
# ==========================================================================

#: Columns whose presence means the box moves by rail (M2 applies).
RAIL_COLUMNS: Tuple[str, ...] = ("Siding", "CTO_Index", "Rake_ID", "Wagon_Count",
                                 "Train_No", "Origin_ICD")
#: Columns whose presence means a road gate movement (M3 applies).
ROAD_COLUMNS: Tuple[str, ...] = ("Truck_In_Time", "Vehicle_No", "Vehicle_Number",
                                 "Gate", "Gate_No", "Move_Type", "Queue_Lag1")
#: Columns whose presence means the row names a vessel call (M5 applies).
VESSEL_COLUMNS: Tuple[str, ...] = ("Vessel_Name", "Vessel_Code", "IMO", "Voyage_No",
                                   "Berth_Code", "ATA", "Vessel_ETA")


def _has_any(row: JnpaRow, columns: Sequence[str]) -> bool:
    return any(adapter.read_text(row, column) for column in columns)


def applicable_contextual_models(row: JnpaRow) -> List[str]:
    """Which contextual models this row carries the evidence for. Pure."""
    models: List[str] = []
    if _has_any(row, RAIL_COLUMNS):
        models.append("UC2-M2")
    if _has_any(row, ROAD_COLUMNS):
        models.append("UC2-M3")
    if _has_any(row, VESSEL_COLUMNS):
        models.append("UC2-M5")
    return models


# ==========================================================================
# SECTION 6 -- THE FAN-OUT
# ==========================================================================

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _container_of(row: JnpaRow) -> str:
    return (adapter.read_text(row, "Container_No", "containerNo", "Entity_Ref")
            or "").strip().upper()


def _dashboard_m1(response: Dict[str, Any]) -> Dict[str, Any]:
    """M1's model response -> the uc2-dashboard card fields. Pure."""
    dwell = response.get("dwellHours")
    block: Dict[str, Any] = {
        "headline": f"{dwell:.1f} h dwell" if isinstance(dwell, (int, float)) else "dwell unavailable",
        "dwellHours": dwell,
        "windowHours": [response.get("p10Hours"), response.get("p90Hours")],
        "engine": response.get("engine"),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
    }
    for key in ("predictedDepartureUtc", "predictedDepartureWindowUtc", "gateInUtc",
                "predictedDepartureWindowH", "model_version", "trained_at"):
        if response.get(key) is not None:
            block[key] = response[key]
    block.update(model_metrics().get("UC2-M1", {}))
    return block


def _dashboard_m4(response: Dict[str, Any]) -> Dict[str, Any]:
    findings = response.get("findings") or []
    count = response.get("findingCount", len(findings))
    block: Dict[str, Any] = {
        "headline": ("no chain findings" if not count
                     else f"{count} finding(s) on this container"),
        "findingCount": count,
        "findings": findings,
        "worstSeverity": response.get("worstSeverity"),
        "clean": response.get("clean"),
        "eventCount": response.get("eventCount"),
        "trailUsed": response.get("trailUsed"),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
    }
    block.update(model_metrics().get("UC2-M4", {}))
    return block


def _dashboard_m2(response: Dict[str, Any]) -> Dict[str, Any]:
    tat = response.get("tatHours")
    block: Dict[str, Any] = {
        "headline": f"{tat:.2f} h rake TAT" if isinstance(tat, (int, float)) else "rake TAT unavailable",
        "tatHours": tat,
        "etaPlacementH": response.get("etaPlacementH"),
        "etaRemovalH": response.get("etaRemovalH"),
        "engine": response.get("engine"),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
    }
    block.update(model_metrics().get("UC2-M2", {}))
    return block


def _dashboard_m3(response: Dict[str, Any]) -> Dict[str, Any]:
    queue = response.get("queueVehicles")
    block: Dict[str, Any] = {
        "headline": (f"{queue:.1f} vehicles queued" if isinstance(queue, (int, float))
                     else "gate queue unavailable"),
        "queueVehicles": queue,
        "estimatedWaitMinutes": response.get("estimatedWaitMinutes"),
        "deferralRecommended": response.get("deferralRecommended"),
        "p10": response.get("p10"),
        "p90": response.get("p90"),
        "engine": response.get("engine"),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
    }
    block.update(model_metrics().get("UC2-M3", {}))
    return block


def _dashboard_m5(response: Dict[str, Any]) -> Dict[str, Any]:
    stay = response.get("projectedTotalStayHours", response.get("projected_total_stay_h"))
    return {
        "headline": (f"{stay:.1f} h projected stay" if isinstance(stay, (int, float))
                     else "berth stay unavailable"),
        "projectedTotalStayHours": stay,
        "varianceVsPlanHours": response.get("varianceVsPlanHours",
                                            response.get("variance_vs_plan_h")),
        "status": response.get("status"),
        "rateSource": response.get("rateSource", response.get("rate_source")),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
    }


def _dashboard_m6(response: Dict[str, Any]) -> Dict[str, Any]:
    worst = response.get("worstWaitMinutes", response.get("worst_wait_minutes"))
    return {
        "headline": (f"{response.get('status')}, worst wait {worst:.0f} min"
                     if isinstance(worst, (int, float)) else "lane plan unavailable"),
        "status": response.get("status"),
        "worstWaitMinutes": worst,
        "throttleRecommended": response.get("throttleRecommended",
                                            response.get("throttle_recommended")),
        "unservable": response.get("unservable"),
        "openLanes": response.get("openLanes", response.get("open_lanes")),
        "closedLanes": response.get("closedLanes", response.get("closed_lanes")),
        "degraded": bool(response.get("degraded")),
        "decision_path": response.get("decision_path"),
        "facility_scope": FACILITY_SCOPE["UC2-M6"],
    }


def _dashboard_m7(reefer: Dict[str, Any], empties: Dict[str, Any]) -> Dict[str, Any]:
    shortfall = reefer.get("shortfall")
    return {
        "headline": (f"{shortfall} reefer(s) with no plug"
                     if shortfall is not None else "reefer allocation unavailable"),
        "status": reefer.get("status"),
        "shortfall": shortfall,
        "hoursToFirstRisk": reefer.get("hoursToFirstRisk",
                                       reefer.get("hours_to_first_risk")),
        "priorityEvacuation": reefer.get("priorityEvacuation",
                                         reefer.get("priority_evacuation")),
        "poolTotal": empties.get("poolTotal", empties.get("total_containers")),
        "poolEmpties": empties.get("poolEmpties", empties.get("empties")),
        "poolSource": empties.get("poolSource", empties.get("source")),
        "shortTerminals": empties.get("shortTerminals", empties.get("short_terminals")),
        "balances": empties.get("balances"),
        "degraded": bool(reefer.get("degraded")) or bool(empties.get("degraded")),
        "decision_path": reefer.get("decision_path"),
        "facility_scope": FACILITY_SCOPE["UC2-M7"],
    }


def predict_containers(rows: Sequence[JnpaRow],
                       focus: str = "",
                       closed_lanes: Optional[Sequence[str]] = None,
                       now: Optional[str] = None) -> Dict[str, Any]:
    """
    Score a page of containers through every applicable UC-II model.

    ``rows`` is the visible page of the Movements table, one row per container,
    in the app's own column names (see ``normalise_row``). ``focus`` is the
    container the operator opened -- it is scored first and never dropped by the
    cap, because a panel answering "that one was not in the sample" is useless.

    Raises ``ValueError`` on an empty request. Never raises for a model that
    fails: that model is recorded in ``run.models_failed`` and the rest still
    answer, matching the service's own posture that models degrade individually
    and visibly.
    """
    if not rows:
        raise ValueError("no container rows to score")

    focus_key = (focus or "").strip().upper()
    requested = len(rows)

    # Focus first, then feed order. Stable: the same page always produces the
    # same request, so a cached response and a fresh one agree.
    ordered = ([r for r in rows if _container_of(r) == focus_key and focus_key]
               + [r for r in rows if not (focus_key and _container_of(r) == focus_key)])
    scored_rows = ordered[:MAX_BATCH]
    dropped = requested - len(scored_rows)

    normalised: List[JnpaRow] = []
    expansion_notes: List[List[str]] = []
    for row in scored_rows:
        enriched, notes = normalise_row(row)
        normalised.append(enriched)
        expansion_notes.append(notes)

    models_failed: List[Dict[str, str]] = []

    def _guarded(model_id: str, fn, *args, **kwargs):
        """Run one model; record a failure rather than losing the whole run."""
        try:
            return fn(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            models_failed.append({"model": model_id, "error": f"{type(exc).__name__}: {exc}"})
            return None

    # --- M1: the whole batch in one call, so cadence is MEASURED ----------
    batch = _guarded("UC2-M1", adapter.predict_dwell_batch, normalised) or {}
    m1_results: List[Dict[str, Any]] = batch.get("results", [])
    cadence = batch.get("cadence", {})

    # --- per container ----------------------------------------------------
    containers: List[Dict[str, Any]] = []
    for index, row in enumerate(normalised):
        container_no = _container_of(row)
        blocks: Dict[str, Any] = {}
        mapping: Optional[Dict[str, Any]] = None

        m1_response = m1_results[index] if index < len(m1_results) else None
        if m1_response is not None:
            blocks["UC2-M1"] = _dashboard_m1(m1_response)
            mapping = m1_response.get("mapping")

        trail = _guarded("UC2-M4", adapter.evaluate_container_trail,
                         [row], container_no, now)
        if trail is not None:
            blocks["UC2-M4"] = _dashboard_m4(trail)

        for model_id in applicable_contextual_models(row):
            if model_id == "UC2-M2":
                response = _guarded(model_id, adapter.predict_j7_rake, row)
                if response is not None:
                    blocks[model_id] = _dashboard_m2(response)
            elif model_id == "UC2-M3":
                response = _guarded(model_id, adapter.predict_j4_queue, row)
                if response is not None:
                    blocks[model_id] = _dashboard_m3(response)
            elif model_id == "UC2-M5":
                response = _guarded(model_id, adapter.reforecast_j10_vessel, row)
                if response is not None:
                    blocks[model_id] = _dashboard_m5(response)

        # The expansions normalise_row() performed belong in this row's ledger:
        # they are translations the operator is entitled to see, exactly like
        # the adapter's own. They are warnings, not assumptions -- nothing was
        # invented, an observed value was re-expressed.
        if mapping is not None and expansion_notes[index]:
            mapping = dict(mapping)
            mapping["warnings"] = list(mapping.get("warnings", [])) + [
                f"{note} (uc2_predictions {MODULE_VERSION})"
                for note in expansion_notes[index]
            ]

        containers.append({
            "container": container_no,
            "terminal": adapter.read_text(row, "Terminal_Code", "Facility_Code") or "",
            "vessel": adapter.read_text(row, "Vessel_Name") or "",
            "focus": bool(focus_key) and container_no == focus_key,
            "degraded": any(bool(b.get("degraded")) for b in blocks.values()),
            "models": blocks,
            "mapping": mapping,
        })

    # --- facility level: computed ONCE over the whole batch ---------------
    facility: Dict[str, Any] = {}
    lanes = _guarded("UC2-M6", adapter.plan_lanes_from_rows,
                     normalised, list(closed_lanes or []), normalised)
    if lanes is not None:
        facility["UC2-M6"] = _dashboard_m6(lanes)

    reefer = _guarded("UC2-M7", adapter.allocate_reefers_from_rows,
                      normalised, normalised, None, normalised)
    empties = _guarded("UC2-M7", adapter.balance_empties_from_rows, normalised)
    if reefer is not None or empties is not None:
        facility["UC2-M7"] = _dashboard_m7(reefer or {}, empties or {})

    ran = sorted({model_id for c in containers for model_id in c["models"]}
                 | set(facility))

    dashboard: Dict[str, Any] = {
        "schema_version": DASHBOARD_SCHEMA,
        "generated_at_utc": _utc_now_iso(),
        "run": {
            "containers_requested": requested,
            "containers_scored": len(containers),
            "containers_dropped": dropped,
            "models_run": ran,
            "models_failed": models_failed,
            "cadence_measured_rows": cadence.get("measured_rows", 0),
            "cadence_assumed_rows": cadence.get("assumed_rows", len(containers)),
        },
        "model_questions": MODEL_QUESTIONS,
        "glossary": GLOSSARY,
        "containers": containers,
        "facility_summary": facility,
    }
    if dropped:
        dashboard["run"]["dropped_reason"] = (
            f"the request carried {requested} containers; this endpoint scores at "
            f"most {MAX_BATCH} per call. The focused container is always scored.")

    return {
        "schema": SCHEMA_VERSION,
        "adapter": {
            "moduleId": MODULE_ID,
            "version": MODULE_VERSION,
            "adapter_version": adapter.MODULE_VERSION,
            "scope": "CONTAINER_BATCH",
            "max_batch": MAX_BATCH,
            "per_container_models": list(PER_CONTAINER_MODELS),
            "contextual_models": list(CONTEXTUAL_MODELS),
            "facility_models": list(FACILITY_MODELS),
            "note": ("M6 and M7 are facility-level: their numbers describe the gate "
                     "and the yard across every container in this request, not the "
                     "container on screen. They are returned in facility_summary "
                     "for exactly that reason."),
        },
        "dashboard": dashboard,
    }


# ==========================================================================
# SECTION 7 -- HTTP ROUTER
# ==========================================================================

try:
    from pydantic import BaseModel, Field

    class PredictionsRequest(BaseModel):
        """The visible page of the Movements table, plus what the operator opened."""

        rows: List[JnpaRow] = Field(..., min_length=1)
        #: Container the panel was opened for. Scored first, never dropped.
        focus: str = ""
        #: Gate lanes reported down, for M6.
        closed_lanes: List[str] = Field(default_factory=list)
        now: Optional[str] = None

except ImportError:  # pragma: no cover - CLI path needs no FastAPI/pydantic
    PredictionsRequest = None  # type: ignore


def build_router():  # pragma: no cover - exercised by the service
    """FastAPI router adding the fan-out to the adapter's own prefix."""
    from fastapi import APIRouter, HTTPException

    router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC2-ADAPTER (web app ingest)"])

    @router.post("/predictions",
                 summary="A page of container rows -> every applicable UC-II model")
    def predictions(req: PredictionsRequest) -> Dict[str, Any]:
        try:
            return predict_containers(req.rows, req.focus, req.closed_lanes, req.now)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/predictions/glossary",
                summary="Every key the predictions document can render, defined")
    def glossary() -> Dict[str, Any]:
        return {
            "moduleId": MODULE_ID,
            "version": MODULE_VERSION,
            "schema": SCHEMA_VERSION,
            "model_questions": MODEL_QUESTIONS,
            "facility_scope": FACILITY_SCOPE,
            "glossary": GLOSSARY,
            "self_evident_keys": sorted(SELF_EVIDENT_KEYS),
        }

    @router.get("/predictions/health", summary="Fan-out health")
    def health() -> Dict[str, Any]:
        checks = selftest()
        return {
            "moduleId": MODULE_ID, "version": MODULE_VERSION,
            "ok": all(c["passed"] for c in checks), "checks": checks,
        }

    return router


# ==========================================================================
# SECTION 8 -- SELF-TEST
#
# The checks a module cannot make about itself in a docstring. This runs in
# CI and gates the Docker build, so a glossary that falls behind the document
# fails the build rather than reaching an operator.
# ==========================================================================

def _demo_rows() -> List[JnpaRow]:
    """Two containers at one terminal, four hours apart, one rail one road."""
    return [
        {
            "Container_No": "MAEU6123458", "Terminal_Code": "NSICT",
            "Arrival_DateTime": "2026-08-02T06:30:00Z",
            "Shipping_Line_Code": "MAEU", "Customs_Status": "PENDING",
            "ISO_Size_Type": "45R1", "Nature_Of_Cargo": "FROZEN SEAFOOD",
            "Origin_Stream": "IMPORT_DPD", "Laden": "Yes",
            "Vessel_Name": "MAERSK SEMBAWANG", "Move_Type": "DELIVER IMPORT",
            "Truck_In_Time": "2026-08-02T07:10:00Z",
            "Terminal_Yard_Utilization_Pct": 85,
        },
        {
            "Container_No": "MSCU7654321", "Terminal_Code": "NSICT",
            "Arrival_DateTime": "2026-08-02T10:30:00Z",
            "Shipping_Line_Code": "MSCU", "Customs_Status": "HELD",
            "ISO_Size_Type": "22G1", "Nature_Of_Cargo": "MACHINERY",
            "Origin_Stream": "IMPORT_ICD", "Laden": "Yes",
            "Siding": "T2", "CTO_Index": "CTO-2", "Wagon_Count": 45,
            "Terminal_Yard_Utilization_Pct": 85,
        },
    ]


def _rendered_keys(node: Any, out: set, depth: int = 0) -> None:
    """Every dict key the panel could render, recursively."""
    if depth > 8:
        return
    if isinstance(node, dict):
        for key, value in node.items():
            out.add(key)
            _rendered_keys(value, out, depth + 1)
    elif isinstance(node, list):
        for item in node[:5]:
            _rendered_keys(item, out, depth + 1)


def selftest() -> List[Dict[str, Any]]:
    """Checks that the claims this module makes about itself still hold."""
    checks: List[Dict[str, Any]] = []

    def check(name: str, passed: bool, detail: str = "") -> None:
        checks.append({"check": name, "passed": bool(passed), "detail": detail})

    rows = _demo_rows()
    doc = predict_containers(rows, focus="MSCU7654321")
    dashboard = doc["dashboard"]
    containers = dashboard["containers"]

    check("the envelope names its schema", doc["schema"] == SCHEMA_VERSION,
          doc["schema"])
    check("the document reuses the published uc2-dashboard shape",
          dashboard["schema_version"] == DASHBOARD_SCHEMA,
          dashboard["schema_version"])

    check("every requested container is in the document",
          len(containers) == len(rows), f"{len(containers)} of {len(rows)}")

    # The focused container is scored FIRST. A panel that answered "the one you
    # opened was not in the sample" would be worse than no panel.
    check("the focused container is scored first",
          containers[0]["container"] == "MSCU7654321" and containers[0]["focus"],
          containers[0]["container"])

    for container in containers:
        check(f"{container['container']} has the per-container models",
              all(model in container["models"] for model in PER_CONTAINER_MODELS),
              ", ".join(sorted(container["models"])))

    # Cadence is the whole reason the batch is the unit. Two rows four hours
    # apart at one terminal must MEASURE it for the later row rather than
    # falling back to the 6.0 h default.
    check("arrival cadence is measured across the batch, not assumed",
          dashboard["run"]["cadence_measured_rows"] >= 1,
          f"measured={dashboard['run']['cadence_measured_rows']} "
          f"assumed={dashboard['run']['cadence_assumed_rows']}")

    # Contextual models are earned by evidence, not handed out.
    rail = next(c for c in containers if c["container"] == "MSCU7654321")
    road = next(c for c in containers if c["container"] == "MAEU6123458")
    check("the rail box gets M2 and the road box does not",
          "UC2-M2" in rail["models"] and "UC2-M2" not in road["models"],
          f"rail={sorted(rail['models'])} road={sorted(road['models'])}")
    check("the road box gets M3", "UC2-M3" in road["models"],
          ", ".join(sorted(road["models"])))
    check("only the row naming a vessel gets M5",
          "UC2-M5" in road["models"] and "UC2-M5" not in rail["models"],
          f"road={sorted(road['models'])} rail={sorted(rail['models'])}")

    # Facility models must NOT be inside a container. This is the check that
    # stops "3 lanes are down" being read as a fact about one box.
    check("facility models are never inside a container",
          all(model not in c["models"] for c in containers for model in FACILITY_MODELS),
          "")
    for model_id in FACILITY_MODELS:
        block = dashboard["facility_summary"].get(model_id)
        check(f"{model_id} states the set it describes",
              bool(block) and bool(block.get("facility_scope")),
              (block or {}).get("facility_scope", "MISSING"))

    # The three published numbers that must never be smoothed.
    m1_block = containers[0]["models"].get("UC2-M1", {})
    check("M1 publishes BOTH accuracies, unblended",
          m1_block.get("headlineAccuracyMaeH") is not None
          and "realCorpusMaeH" in m1_block
          and m1_block.get("headlineAccuracyMaeH") != m1_block.get("realCorpusMaeH"),
          f"synthetic={m1_block.get('headlineAccuracyMaeH')} "
          f"real={m1_block.get('realCorpusMaeH')}")
    # The corpus-excluded case. A synthetic accuracy standing alone, with no
    # word about the real-stay figure it is not a substitute for, is precisely
    # the smoothing M1's disclosure forbids — so the absence must be stated.
    check("a missing real-corpus accuracy is stated, not silently omitted",
          m1_block.get("realCorpusMaeH") is not None
          or (m1_block.get("realCorpusMetricsAvailable") is False
              and bool(m1_block.get("realCorpusUnavailableReason"))
              and bool(m1_block.get("accuracyDisclosure"))),
          str(m1_block.get("realCorpusUnavailableReason"))[:80] or "real figure present")

    m2_block = rail["models"].get("UC2-M2", {})
    # `metricIsFidelityNotAccuracy` is the disclosure itself, so it is the one
    # key allowed to contain the word. Any OTHER key claiming accuracy for M2
    # would be claiming a measurement that does not exist.
    accuracy_claims = [k for k in m2_block
                       if "accurac" in k.lower() and k != "metricIsFidelityNotAccuracy"]
    check("M2 calls its metric fidelity, never accuracy",
          m2_block.get("metricIsFidelityNotAccuracy") is True and not accuracy_claims,
          f"offending keys: {accuracy_claims}" if accuracy_claims
          else "fidelity only, as published")
    m3_block = road["models"].get("UC2-M3", {})
    check("M3 names the split protocol behind its metric",
          bool(m3_block.get("splitPolicy")) and "leakageCheck" in m3_block,
          str(m3_block.get("splitPolicy")))

    # The ledger. Nothing is estimated in the frontend, so every substitution
    # must be named here or it is named nowhere.
    with_mapping = [c for c in containers if c["mapping"]]
    check("every container carries a mapping ledger",
          len(with_mapping) == len(containers), f"{len(with_mapping)}/{len(containers)}")
    check("the ledger counts inputs, and the counts are inputs not models",
          all(c["mapping"]["inputs_observed"] + c["mapping"]["inputs_assumed"]
              == len(c["mapping"]["derived"]) for c in with_mapping), "")

    # The glossary gate. This is the one that fails the build.
    emitted: set = set()
    _rendered_keys(dashboard, emitted)
    missing = sorted(emitted - set(GLOSSARY) - SELF_EVIDENT_KEYS)
    check("every rendered key has a glossary entry or is self-evident",
          not missing, f"missing: {', '.join(missing)}" if missing else "all defined")

    # Determinism: same rows in, same numbers out. A panel whose figures move
    # on refresh cannot be checked by the operator reading it.
    again = predict_containers(rows, focus="MSCU7654321")
    stable = (json.dumps(_strip_time(doc), sort_keys=True)
              == json.dumps(_strip_time(again), sort_keys=True))
    check("scoring the same rows twice gives the same numbers", stable, "")

    # Refusals.
    try:
        predict_containers([])
        check("an empty request is refused", False, "no error raised")
    except ValueError as exc:
        check("an empty request is refused", True, str(exc))

    return checks


def _strip_time(doc: Dict[str, Any]) -> Dict[str, Any]:
    """The generation timestamp is the one field that legitimately changes."""
    clone = json.loads(json.dumps(doc))
    clone["dashboard"]["generated_at_utc"] = ""
    return clone


# ==========================================================================
# SECTION 9 -- CLI
# ==========================================================================

def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC-II per-container prediction fan-out")
    parser.add_argument("--selftest", action="store_true",
                        help="run the self-checks and exit non-zero on failure")
    parser.add_argument("--demo", action="store_true",
                        help="score the demo rows and print the document")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.selftest:
        checks = selftest()
        if args.json:
            print(json.dumps(checks, indent=2))
        else:
            for entry in checks:
                mark = "PASS" if entry["passed"] else "FAIL"
                print(f"  [{mark}] {entry['check']}"
                      + (f"  -- {entry['detail']}" if entry["detail"] else ""))
            failed = [c for c in checks if not c["passed"]]
            print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if any(not c["passed"] for c in checks) else 0

    doc = predict_containers(_demo_rows(), focus="MSCU7654321")
    print(json.dumps(doc, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
