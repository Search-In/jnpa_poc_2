# UC-II — Improved Cargo Handling & Logistics Optimization
## Workstream 2: AI / ML Tools (Tabular Description)

**Tender Ref:** GEM / 2026 / B / 7297343 · **Submission:** PoC Pilot, 07 Aug 2026
**Columns per Bidder Briefing WS2:** Use Case Solved · Training Data (Features) · Objective Function · Model Used · Rationale · Link to Model Weights · Validation Data · Accuracy

> ### Disclosure — methodology honesty
>
> Every figure below was produced by running the shipped code against the shared
> corpus. Reproduce the whole table with `python run.py uc2`; each model also
> serves its own row at `GET /uc2/m<N>/model-card`.
>
> Three disclosures matter more than any single number, and each is stated again
> in the row it belongs to:
>
> 1. **Two of the seven models publish an accuracy measured on synthetic data.**
>    Row 1's headline MAE of 3.69 h comes from a seeded generator; its
>    real-corpus MAE of 21.36 h — which does *not* beat a median baseline — is
>    published beside it. They are not interchangeable.
> 2. **Row 2's metric is fidelity, not accuracy.** The corpus records no
>    observed rake turnaround anywhere, so there is nothing to be accurate to.
>    The number measures how faithfully the regressor reproduces the
>    deterministic handling model.
> 3. **Row 3's previously disclosed leakage defect is fixed, and the fix did not
>    confirm the assumption behind it.** All three split protocols are published.
>
> The corpus sources were also measured against each other: **the CODECO
> container population, the shipping-line inventories, the RMS scanning lists
> and the parsed gate documents share zero container numbers.** That single
> fact, not a modelling preference, is why four of the seven models are
> deterministic and why row 1 cannot join reefer or customs status to a real
> label.

---

## The table

| # | Use Case Solved | Training Data (Features) | Objective Function | Model Used | Rationale | Link to Model Weights | Validation Data | Accuracy |
|---|---|---|---|---|---|---|---|---|
| **1** | **Container dwell prediction** — hours a box will sit before it leaves; drives pendency optimisation and evacuation planning (briefing: "yard congestion", "buffer pendency") | 6 features: `stream_idx`, `line_idx`, `arrival_cadence_h`, `customs_flag`, `reefer`, `facility_load`. Trained on a seeded generator (n=4,000, seed 101) **anchored to the measured real dwell distribution** — median 49.2 h, sd 18.9 h, bimodal at ~28 h and ~71 h, taken from 254 real CFS-CODECO stays | Minimise MAE of dwell hours; post-process adds a ±4 h departure window and empirical P10/P90 from held-out residuals | `HistGradientBoostingRegressor` (max_iter 200, lr 0.08, depth 6) with a documented fallback chain → GradientBoosting → RandomForest → stdlib ridge. Production = LightGBM per-facility on real `container_event` history | Gradient boosting handles the mixed categorical/numeric set and is explainable via permutation importance; the serving path is proven end to end through FastAPI `/predict` | `trained_models/uc2/dwell-predictor/model.joblib` + `metrics.json` + `model_card.json` (`python run.py uc2 --export`). Source: `src/uc2_models/uc2_m1_container_dwell.py` | **Headline:** held-out synthetic slice, n=800, chronological split. **Real-world:** 254 genuine CFS-CODECO container stays (483 complete pairs, 229 excluded as left-censored by the observation window) | **Headline MAE 3.69 h** (threshold ≤ 8.0 h) ✅ · R² 0.979 <br> **Real-corpus MAE 21.36 h vs a 15.74 h median baseline — the model does NOT beat the baseline.** Published in full at `GET /uc2/m1/metrics` |
| **2** | **Rake TAT forecast** — railside placement/removal ETAs and departure window (briefing: "rake assignment") | 5 published features: `siding`, `cto_idx`, `wagon_count`, `arrival_hour`, `inbound`. The regressor is trained on **7** — the published five plus `container_count` and `terminal_count`, because rake TAT is dominated by boxes lifted and terminals served and neither is recoverable from the five (see the note below the table) | Minimise MAE against the deterministic handling model; post-process derives placement at 0.25·TAT, removal at 0.80·TAT and a ±1 h departure window | **Primary: deterministic handling model** — `TAT = placement + containers/effective-moves-per-hour + release`, every coefficient versioned in `HANDLING`. **Secondary:** `HistGradientBoostingRegressor` (seed 303, n=2,500) | With no observed rake TAT anywhere in the corpus, an auditable handling model a rail operations manager can check by hand is worth more than a learned model fitted to a label that does not exist | `trained_models/uc2/rake-tat-forecaster/`. The `HANDLING` and `CTO_EFFICIENCY` blocks are the real "weights"; served at `GET /uc2/m2/constants` | Held-out synthetic slice, n=500. **Real-world:** composition only — 8 CTO manifests (39–45 wagons, 42–57 containers, 68–89 TEU) and 59 FOIS intimations. **No TAT label exists to score against** | **Fidelity MAE 0.85 h** to the handling model (threshold ≤ 2.0 h) ✅ <br> **This is fidelity, not accuracy.** Handling model exercised on all 67 real rakes: median TAT 4.79 h, range 2.04–6.06 h |
| **3** | **Gate queue forecast** — next-interval queue length per gate and a deferral recommendation (briefing: "lane planning") | 5 features: `queue_lag1`, `queue_lag2`, `hour_sin`, `hour_cos`, `uc3_truck_inflow` (**cross-twin**, supplied by the caller from UC-III). Trained on **1,222 hourly steps derived from 1,929 real CODECO gate movements** across 611 hours | Minimise RMSE of next-step queue; post-process recommends deferral when queue > 8 and converts queue to an estimated wait | `HistGradientBoostingRegressor` autoregressor, **rolling-origin evaluated**. Production = LSTM/TFT on live gate transaction streams with UC-III camera counts | The cross-twin inflow feature demonstrates UC-II ↔ UC-III interdependency (marking criterion 5); the split correction is the P1 defect fix | `trained_models/uc2/gate-queue-forecaster/`. Source: `src/uc2_models/uc2_m3_gate_queue.py` | Pooled across 5 rolling-origin expanding-window folds, n=611 held-out steps, on the real derived series | **RMSE 0.909 vehicles** (threshold ≤ 3.5) ✅ · MAE 0.480 · R² 0.970 <br> Beats a persistence baseline (1.019 RMSE). All three split protocols published at `GET /uc2/m3/leakage` |
| **4** | **Event-sequence anomaly detection** — stuck boxes and broken event chains (briefing: "pendency optimisation & alerts") | Container event trails `[{eventType, ts}]` assembled from CODECO gate movements, RMS scanning lists and customs LEO records | Detect missing-sequence anomalies against 6 versioned thresholds; **maximise recall subject to precision ≥ 0.85** | Deterministic rule engine, **6 versioned rules** — 3 from the published spec, 3 added after measuring the corpus (orphan gate-out, negative dwell, dwell outlier) | Rules give actionable, explainable alerts on day one and every finding carries the evidence that produced it. An orphan gate-out affects 528 of 1,202 corpus containers and the published rule set was blind to it | No learned weights. The `RULES` block **is** the versioned configuration; served at `GET /uc2/m4/rules` | Labelled synthetic set, n=400, seed 505 — roughly a third are near-miss clean trails sitting just inside a threshold. **Plus a full scan of 1,401 real corpus containers** | **Precision 1.0 · Recall 1.0 · F1 1.0** (thresholds ≥ 0.85) ✅ <br> All 6 rules exercised. **Corpus scan: 1,139 findings over 1,136 containers, 265 clean** — 529 orphan gate-outs, 408 missing gate-outs, 100 LEO-no-move, 99 scan-flag-no-scan, 3 dwell outliers |
| **5** | **Discharge-rate & berth-stay tracking** — actual vs planned, with a berth-stay re-forecast on deviation | TOS plan/outcome timestamps (ETA/ETD/ATA/ATD); 720 usable DSR berth stays; 6,467 EAL/IAL move counts per terminal | Report actual vs planned rate and stay; re-forecast completion from the observed rate once it is trustworthy (≥ 0.5 h elapsed **and** ≥ 5% of the parcel worked) | Deterministic tracking + rate-based re-forecast. Production = crane-productivity regression per vessel class and terminal | Measurement precedes prediction. The corpus has no move-level productivity history, so a productivity regression would be fitted to nothing; honest tracked actuals are exactly the training base it needs | No learned weights. `TERMINAL_CRANE_PRODUCTIVITY` and `BERTH_STAY_OVERHEAD_H` are the versioned configuration; served at `GET /uc2/m5/constants` | 5 real TOS vessel calls with both plan and outcome; 720 DSR berth stays; 6,467 inventory lines across 8 terminal/direction groups | **Deterministic** (exact given inputs) <br> Measured on real calls: stay variance mean +4.73 h, median +3.27 h, range −1.48 to +16.70 h; arrival delay mean +1.72 h. Berth-stay sd 14.98 h sizes the re-forecast band |
| **6** | **Dynamic lane assignment** — re-assign open lanes to minimise projected wait under closure (briefing: "lane planning") | Lane states and compatibility matrix, closure events, and the UC2-M3 queue forecast (`GET /uc2/m6/from-forecast`) | Minimise projected queue wait subject to lane compatibility; recommend throttling at ≥ 45 min worst wait or any unservable demand | Deterministic re-assignment, most-constrained-movement-class first. Production couples to UC-III TAS metering | A re-plan must be instant and defensible to a gate supervisor mid-closure, and the corpus contains no closure history to learn a policy from | No learned weights. `LANES` and `SCENARIOS` are the versioned configuration; served at `GET /uc2/m6/constants` | Scenario regression suite: BASELINE, S4, S4B, S4C | **Deterministic**; feasibility guaranteed by construction — incompatible placements are impossible and unservable demand is reported, never absorbed <br> **S4** (3 of 6 lanes closed): 76 trucks/h capacity lost, worst wait +176.8 min, `OK → UNSERVABLE_DEMAND` with 4 hazardous moves/h stranded |
| **7** | **Empty-pool & reefer surge management** (briefing: "empty discharge & load impact on gates") | Empty pool by terminal and ISO type, reefer plug inventory (96 CPP plugs), discharge forecast. **6,467 real EAL/IAL container lines** — 1,885 empties, 212 reefers across 6 terminals | Match supply to demand; when plugs are constrained, allocate in ascending order of temperature hold time and state the exposure explicitly | Deterministic priority matcher + scenario engine | Reefer power is a safety and commercial risk, so the response must be rule-auditable. A learned allocator would be harder to defend to a duty manager and no more accurate — there is no plug-failure history | No learned weights. `CPP_REEFER_PLUGS`, `HOLD_HOURS_BY_SENSITIVITY` and `SCENARIOS` are the versioned configuration; served at `GET /uc2/m7/constants` | 6,467 real inventory lines across 6 terminals; scenario regression suite BASELINE, S6, S6B | **Deterministic**; conservation asserted (allocated + unplugged ≡ arriving) <br> **S6** (742 reefers, 18 of 96 plugs failed): 74 plugged, **668 exposed**, first at risk in 8.0 h, status `AT_RISK`. Empty pool: NSFT and APMT below the 1.5-day cover floor |

---

## Note on row 2 — the published feature set is short by two

This is an honest finding rather than a deviation for convenience.

Trained on only the five published features, the rake regressor scores **R² −0.03**:
it cannot see the thing that moves the answer. Wagon count is nearly constant
across the real rakes (39–45) and does not determine the fill — the real
manifests run 0.93 to 1.27 boxes per wagon — and the number of destination
terminals, which drives multi-spot shunting, is absent entirely.

The regressor is therefore trained on seven features. The published five-float
endpoint still works: container count is inferred from wagon count and terminal
count defaults to 1, with the substitution flagged on the response. **Recommend
adding `container_count` and `terminal_count` to the published contract** — both
are already present on the CTO manifest that precedes every rake.

---

## Note on row 3 — what the leakage re-measurement actually found

The previous submission disclosed:

> "RMSE 0.323 ≤ 3.5 ✅ ⚠ split is shuffled on a time series (leaks):
>  re-split chronologically, re-measure, re-disclose (P1)"

The defect is real and it is fixed. But re-measurement did not confirm the
assumption behind it, and forcing the expected narrative would have been the
same dishonesty in reverse. The identical model, scored under all three
protocols on the real derived series:

| Protocol | RMSE | Verdict |
|---|---|---|
| **Rolling-origin, 5 expanding folds** | **0.909** | **SERVED** — the published metric |
| Single chronological tail (80/20) | 0.235 | REJECTED — degenerate |
| Shuffled 80/20 | 1.173 | REJECTED on principle |

**Shuffling did not flatter the score; it scored worse.** And the obvious fix —
one chronological tail — turns out to be the misleading one here: the last 245
steps of the log are a quiet fortnight with a flat zero queue, so a tail split
scores 0.235 with an undefined R² and measures the calendar rather than the
model.

Both alternatives are rejected **on principle, not on their numbers**: a
shuffled split is invalid for an autoregressive series whatever it scores, and a
lone tail split makes the metric hostage to what the port happened to be doing
in the last week of the log. Served live at `GET /uc2/m3/leakage`.

---

## Note on row 1 — why the two accuracies differ so much

Three measured facts, in order:

1. **Left censoring.** Gate-ins begin 01 Jul 2026 but the first CFS gate-out is
   07 Jul 08:06. Every container gating in during those six days shows an
   inflated dwell (138 h on 01 Jul, decaying to ~50 h by 11 Jul) purely because
   its departure could not be recorded earlier. 229 of 483 stays are excluded as
   censored, and the exclusion is reported in the provenance, not applied
   quietly.

2. **The sources do not join.** Zero container numbers are shared between the
   dwell population, the line inventories, the scanning lists and the gate
   documents. Trade stream, customs hold and reefer status therefore cannot be
   attached to a single real label. The real-corpus score marginalises those
   three inputs out under a stated prior rather than pinning them to one corner.

3. **What remains does not predict.** A model trained directly on the real
   features with a chronological split scores MAE 19.4 h against a 17.5 h
   median baseline (R² −0.19). It loses to predicting the median.

The generator's `UNEXPLAINED_SD_H = 4.3 h` is the single constant that sets the
headline accuracy — MAE of a Gaussian is ≈ 0.8σ. It is an assumption the real
data does not support (measured sd is 29.7 h), it is held at the previously
submitted value so the committed scoreboard does not move silently, and it is
exposed as `--unexplained-sd` so a reviewer can dial it to the measured value
and watch the headline collapse. **Both numbers ship.**

---

## Committed thresholds and current position

| Model | Metric | Threshold | Measured | |
|---|---|---|---|---|
| M1 dwell | MAE (synthetic) | ≤ 8.0 h | **3.69 h** | ✅ |
| M1 dwell | MAE (real corpus) | *no threshold* | 21.36 h vs 15.74 h baseline | ⚠ disclosed |
| M2 rake TAT | MAE (fidelity) | ≤ 2.0 h | **0.85 h** | ✅ |
| M3 gate queue | RMSE | ≤ 3.5 | **0.909** | ✅ |
| M4 anomaly | Precision | ≥ 0.85 | **1.0** | ✅ |
| M4 anomaly | **Recall** | ≥ 0.85 | **1.0** | ✅ *newly measured* |
| M5 / M6 / M7 | — | deterministic | exact given inputs | ✅ |

Every metric is reproducible from a fixed seed (101 / 202 / 303 / 505). If a
split, threshold or generator changes, `metrics.json`, the dashboard model card
and this table must be re-measured and updated **together**.

---

## Serving architecture

One FastAPI application, seven routers, port 8200
(`src/service/api_uc2.py`, started with `python run.py serve-uc2`).

Per model: `/predict`, `/health`, `/metrics`, `/constants`, `/demo`,
`/model-card`. Service-level: `/uc2/manifest`, `/uc2/model-cards`,
`/uc2/constants`, `/uc2/corpus`, `/uc2/demo-all`, `/uc2/inference-log`.

Every `/uc2/*` request appends one JSON line to `out/uc2/inference_log.jsonl`
with path, status, latency, module and model version — the AI-inference evidence
the acceptance methodology requires (Bidder Briefing p.4, item 10).

Wiring details: `docs/UC2_INTEGRATION.md`.

---

## Production upgrade path

| PoC component | Production replacement | Trigger |
|---|---|---|
| Synthetic training sets (M1, M2) | Real `container_event` / FOIS / gate-transaction history | ≥ 3 months live ingestion |
| HistGB dwell model | LightGBM with per-facility calibration, and **the joined feature set** — reefer, customs and stream attached to real labels | Same, plus a container-number join across TOS, customs and line feeds |
| Deterministic rake handling model | Sequence model on observed placement/removal/departure timestamps | A rail TOS feed that records those three events |
| Gate autoregressor | LSTM / Temporal Fusion Transformer with UC-III camera counts as a live feature | Live camera feeds |
| Rule-only anomaly evaluation | Hybrid rules + learned sequence scoring | Labelled exception history |
| Deterministic crane-rate assumption | Crane-productivity regression per vessel class and terminal | Move-level TOS productivity feed, ≥ 3 months |
| Legacy `.xls` inventories skipped | Full ingestion (`xlrd`) or a modern export from the lines | Immediate — it is a dependency, not a data gap |
