# UC-II Models — Plain-Language Guide

**Jawaharlal Nehru Port Authority · Digital Twin PoC · Tender GeM/2026/B/7297343**
Workstream 2 — UC-II Improved Cargo Handling & Logistics Optimization

This document explains, for each of the seven UC-II models:

1. **What the model does** — in plain words.
2. **What you must give it** — every input field explained simply.
3. **What it gives back** — every output field explained simply.
4. **How to run it** — command line and HTTP, both.

It is the "what do these numbers mean" companion to [UC2_INTEGRATION.md](UC2_INTEGRATION.md),
which is the "how do I wire the frontend" document.

---

## 0. Before anything — how to run at all

```bash
pip install -r requirements.txt
```

There are **three ways** to run any UC-II model. All three give the same numbers.

| Way | Command | Use it when |
|---|---|---|
| **A. The model file directly** | `python src/uc2_models/uc2_m3_gate_queue.py` | You want to see the model work, read its printed report, and check its metrics. No server needed. |
| **B. The runner** | `python run.py uc2 --model m3` | You want the sample request + response written to disk as JSON files. |
| **C. The HTTP service** | `python run.py serve-uc2` then POST to `:8200` | A frontend or another system needs to call it. |

Way **B** writes two files per model, and they are the ground truth for the shapes:

| File | What it is |
|---|---|
| `data/input/uc2/m3_request.json` | The exact body to send |
| `out/uc2/m3_response.json` | The exact thing that comes back |

Both are regenerated from the real models on every run, so they cannot go stale.

Run **everything** at once:

```bash
python run.py uc2            # all 7 models, writes every request/response pair
python run.py uc2 --list     # list the 7 models and exit
python run.py corpus         # show which real data files parsed, which did not
python run.py serve-uc2      # start the HTTP service on http://127.0.0.1:8200
```

With the service running, `http://127.0.0.1:8200/docs` gives you a clickable
form for every endpoint below — you can try each model in the browser without
writing a single curl command.

---

## 1. Fields that appear in *every* model's output

Read this once and you can skip it in each model's section below.

| Field | In very simple words |
|---|---|
| `moduleId` | Which model answered. e.g. `"UC2-M3"`. |
| `model_version` | The exact version of the model that produced this number. Pin it in bug reports. |
| `trained_at` / `generated_at_utc` / `evaluated_at` | The moment this answer was produced (UTC). |
| `degraded` | **`true` means a fallback produced this number** — a substituted data source, a simpler engine, or an assumed constant instead of an observed one. The number is still usable, but it is weaker than normal. Always show this on screen. |
| `decision_path` | A one-line audit trail saying which engine ran and on what data. Example: `engine=hist_gradient_boosting \| series=CORPUS \| split=chronological`. Put it behind an info icon. |
| `engine` | The named algorithm that produced the number (`hist_gradient_boosting`, `handling`, `rule_engine`, …). |
| `p10` / `p50` / `p90` | The uncertainty band. **p50 is the main answer.** p10 is the optimistic end, p90 the pessimistic end. In plain words: "we expect 8.3, but realistically it lands between 7.6 and 9.1". Never display the single number alone. |
| `breakdown` | The "why" — every step of the arithmetic with the actual numbers substituted in, so a port manager can check the answer by hand. |
| `features` | Echo of what the model actually used, including anything it derived from your input. Useful to confirm your request was understood. |

**One more universal rule:** if you leave out a required input or send an
out-of-range value, the service returns **HTTP 422** and names the field. It
never guesses a value. Your UI should say "waiting for `<field>`", not show a
stale number.

---

## 2. The seven models at a glance

| | Model | The question it answers | Type |
|---|---|---|---|
| **M1** | Container Dwell | "This box just entered. How many hours until it leaves?" | Learned (gradient boosting) |
| **M2** | Rake TAT | "This train just arrived. How long will it block the siding?" | Deterministic formula (+ learned second opinion) |
| **M3** | Gate Queue | "How many trucks will be queued at the gate next hour?" | Learned (gradient boosting) |
| **M4** | Event Anomaly | "Which containers have broken paperwork right now?" | Rule engine (6 rules) |
| **M5** | Discharge & Berth Stay | "Is this vessel on plan? When will she actually finish?" | Deterministic projection |
| **M6** | Lane Assignment | "Lanes are closed. Which traffic goes where, and how bad is the wait?" | Deterministic allocator |
| **M7** | Empty Pool & Reefer | "Enough empty boxes? Enough reefer plugs?" | Deterministic priority matcher |

---

# M1 — Container Dwell Prediction

## What it does

A container has just been gated in. This model predicts **how many hours it
will sit in the facility before it leaves**. It also converts that into an
actual clock time, so a yard planner can see "this box leaves around Thursday
12:39" instead of doing date arithmetic.

Used for: pendency (backlog) planning, evacuation planning, yard-congestion warnings.

> **Honesty note you must carry into any UI.** M1 publishes **two** accuracy
> numbers and never blends them. The headline (MAE 3.69 h) is measured on
> synthetic data built to match the real dwell distribution. The real-corpus
> figure (MAE 21.36 h, against a 15.74 h median baseline it does **not** beat)
> is served at `GET /uc2/m1/metrics`. If you show one, show both.

## How to run it

```bash
# A. Direct — prints a demo prediction plus metrics
python src/uc2_models/uc2_m1_container_dwell.py
python src/uc2_models/uc2_m1_container_dwell.py --validate    # score against the real 483 stays
python src/uc2_models/uc2_m1_container_dwell.py --json        # machine-readable
python src/uc2_models/uc2_m1_container_dwell.py --selftest    # internal checks

# B. Runner — writes data/input/uc2/m1_request.json + out/uc2/m1_response.json
python run.py uc2 --model m1

# C. HTTP
python run.py serve-uc2
curl -X POST http://127.0.0.1:8200/uc2/m1/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"stream_idx":0,"line_idx":1,"arrival_cadence_h":4.0,
       "customs_flag":1,"reefer":1,"facility_load":0.85,
       "gate_in_utc":"2026-08-02T06:30:00Z"}'
```

## Input — what you must provide

Endpoint: `POST /uc2/m1/predict-one`

| Field | Type / range | Default | What it actually means, simply |
|---|---|---|---|
| `stream_idx` | int, 0–6 | 0 | **What kind of cargo journey this box is on.** Pick the number from the list below. |
| `line_idx` | int, 0–5 | 0 | **Which shipping line owns the box.** Different lines clear their boxes at different speeds. |
| `arrival_cadence_h` | float, >0 to 48 | 6.0 | **How many hours passed since the previous container arrived at this same facility.** A small number means boxes are pouring in (busy); a large number means it is quiet. |
| `customs_flag` | 0 or 1 | 0 | **Is this box held for a customs examination?** `1` = yes (it will sit much longer), `0` = no. |
| `reefer` | 0 or 1 | 0 | **Is it a refrigerated container?** `1` = yes. Reefers get moved out faster because they burn power and risk cargo. |
| `facility_load` | float, 0–1 | 0.7 | **How full the yard is right now**, as a fraction. `0.85` = 85% occupied. A fuller yard slows everything down. |
| `gate_in_utc` | ISO-8601 text | *optional* | **The exact time the box entered**, e.g. `"2026-08-02T06:30:00Z"`. Give it and you get back real clock times for departure instead of just "in N hours". |

**`stream_idx` values** (the trade stream):

| Value | Meaning |
|---|---|
| 0 | `IMPORT_CFS` — import, goes to the Container Freight Station |
| 1 | `IMPORT_ICD` — import, goes to an Inland Container Depot |
| 2 | `IMPORT_DPD` — import, Direct Port Delivery |
| 3 | `EXPORT_CFS` — export via CFS |
| 4 | `EXPORT_ICD` — export via ICD |
| 5 | `TRANSSHIPMENT` — just passing through to another vessel |
| 6 | `EMPTY_RETURN` — an empty box coming back |

**`line_idx` values** (the shipping line): `0 = MSC`, `1 = MAERSK`, `2 = ONE`,
`3 = CMA_CGM`, `4 = HAPAG`, `5 = OTHER`.

**Alternative positional form** — `POST /uc2/m1/predict` takes
`{"instances": [[stream_idx, line_idx, arrival_cadence_h, customs_flag, reefer, facility_load]]}`.
It works, but **prefer the named form above** — positional lists are how a
dashboard silently swaps two columns and ships the bug.

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `dwellHours` | **The headline answer: how many hours this box will sit.** Same as `p50Hours`. |
| `p10Hours` | The optimistic case — 10% of similar boxes leave faster than this. |
| `p50Hours` | The middle estimate. This is the number to display. |
| `p90Hours` | The pessimistic case — 90% of similar boxes leave by this time. Plan capacity against this, not `p50`. |
| `predictedDepartureWindowH` | `[lower, upper]` hours — a tighter "expect it to leave between these two hours" window (±2 h around the point). |
| `predictedDepartureUtc` | **The actual clock time the box is expected to leave.** Only present if you sent `gate_in_utc`. |
| `predictedDepartureWindowUtc` | The same window as two real timestamps instead of hour offsets. Only from the HTTP endpoint, and only if you sent `gate_in_utc`. |
| `confidenceBandHours` | How wide the uncertainty is (`p90 − p10`). A big number = the model is unsure; badge it. |
| `features` | What the model used, with the codes decoded — you get `"stream": "IMPORT_CFS"` and `"line": "MAERSK"` back in words, not just indexes. |
| `breakdown.terms[]` | The "why": a list of `{factor, hours}` — e.g. `customs hold: +26.0 h`, `reefer priority: −9.0 h`. This is what you show in a "why this number?" drawer. |
| `breakdown.additive_total_h` | What those factors add up to on their own. |
| `breakdown.model_point_h` | What the actual trained model said. |
| `breakdown.model_vs_additive_delta_h` | The gap between the two. A big gap means the model found interactions the simple sum misses. |
| `breakdown.attribution_caveat` | **Render this.** It says the factor list explains the documented generator coefficients, *not* the gradient-boosted model's internal splits. |
| `breakdown.interval_method` | How the p10/p90 band was computed — here, from real held-out prediction errors. |

## Other M1 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m1/metrics` | Both accuracy figures — synthetic headline and real-corpus |
| `GET /uc2/m1/calibration` | The real dwell distribution the model is anchored to |
| `GET /uc2/m1/constants` | The versioned coefficients (the "model weights") |
| `GET /uc2/m1/demo` | A canonical prediction, no body needed |
| `GET /uc2/m1/health` | Module health + self-test results |
| `GET /uc2/m1/model-card` | The WS2 submission row for this model |

---

# M2 — Rake Turnaround Time (Rail)

## What it does

A goods train ("rake") is inbound. This model predicts **how many hours it will
occupy the railway siding** — from arrival, through unloading, to departure —
and when to promise the two operational milestones: **placement** (the rake is
positioned for handling) and **removal** (handling is finished).

**Important design fact:** nothing in the shared corpus records when a rake was
actually placed, removed, or departed. There is no ground truth to train on. So
the **primary engine is a deterministic formula** whose every coefficient is
named and whose every step comes back with the arithmetic substituted. A learned
model exists as a second opinion, but its "accuracy" is measured against the
formula's own output — a *fidelity* score, not an accuracy score.

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m2_rake_tat.py
python src/uc2_models/uc2_m2_rake_tat.py --validate            # run over all 8 real manifests + 59 real intimations
python src/uc2_models/uc2_m2_rake_tat.py --engine learned      # use the learned engine instead
python src/uc2_models/uc2_m2_rake_tat.py --json
python src/uc2_models/uc2_m2_rake_tat.py --selftest

# B. Runner
python run.py uc2 --model m2

# C. HTTP
curl -X POST http://127.0.0.1:8200/uc2/m2/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"siding":1,"cto_idx":0,"wagon_count":45,"arrival_hour":9,"inbound":1,
       "container_count":53,"terminal_count":5,"engine":"handling",
       "eta_utc":"2026-08-02T09:00:00Z"}'
```

## Input — what you must provide

Endpoint: `POST /uc2/m2/predict-one`

| Field | Type / range | Default | What it actually means, simply |
|---|---|---|---|
| `siding` | 0 or 1 | 0 | **Which railway siding the rake goes to.** `0 = T1`, `1 = T2`. T2 carries a small extra placement penalty. |
| `cto_idx` | int, 0–3 | 0 | **Which Container Train Operator runs this rake.** `0 = CONCOR`, `1 = GATEWAY`, `2 = ADANI`, `3 = OTHER_CTO`. Each has a different handling efficiency. |
| `wagon_count` | int, 1–90 | 45 | **How many wagons are in the train.** Real rakes run 39–45. |
| `arrival_hour` | int, 0–23 | 10 | **The clock hour the rake asks to be placed** (24-hour, 0 = midnight). Night and morning-peak hours add congestion time. |
| `inbound` | 0 or 1 | 1 | **Direction.** `1` = inbound, arriving loaded to be unloaded. `0` = outbound, being loaded to leave. |
| `container_count` | int | *optional* | **How many containers are actually on the train.** This is the single biggest driver of the answer. If you omit it, the model estimates it from `wagon_count` using the real 1.15 boxes-per-wagon ratio measured off the corpus. |
| `terminal_count` | int, 1–8 | 1 | **How many different terminals the boxes on this train are going to.** More destinations = more shunting = more time. |
| `engine` | `"handling"` or `"learned"` | `"handling"` | **Which engine answers.** Keep `"handling"` — it is the deterministic, explainable, primary one. `"learned"` is the second opinion. |
| `eta_utc` | ISO-8601 text | *optional* | **The rake's expected arrival time.** Give it and every milestone comes back as a real clock time as well as an hour offset. |

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `tatHours` | **The headline answer: total hours the rake occupies the siding.** |
| `p10Hours` / `p50Hours` / `p90Hours` | Optimistic / expected / pessimistic total. |
| `etaPlacementH` | **How many hours from now until the rake is placed** and handling can start (25% of TAT). |
| `etaRemovalH` | **How many hours until handling is complete** and the rake can be pulled out (80% of TAT). |
| `departureWindowH` | `[lower, upper]` hours — the window in which the rake actually leaves. |
| `etaPlacementUtc` / `etaRemovalUtc` / `departureWindowUtc` | The same three as real clock times. Only present if you sent `eta_utc`. |
| `handlingModelHours` | What the deterministic formula said, always, regardless of which engine you asked for. |
| `learnedVsHandlingDeltaH` | How far the learned model disagrees with the formula. A large gap is a flag to investigate, not an error. |
| `features` | Your input echoed back with codes decoded — `"sidingName": "T2"`, `"cto": "CONCOR"`, `"direction": "INBOUND"`, plus `effective_containers` (the count actually used, whether you gave it or it was estimated). |
| `breakdown.steps[]` | **The four-part arithmetic, fully substituted.** This is the "why" drawer: |
| ⤷ `placement` | Time to position the rake on the siding — `base + per-10-wagons + T2 penalty`. |
| ⤷ `handling` | Time to lift the boxes — `containers ÷ (RMG moves per hour ÷ CTO efficiency)`. Usually the biggest term. |
| ⤷ `congestion` | Extra time for night hours, morning road peak, and multiple destination terminals. |
| ⤷ `release` | Paperwork, brake test, and requesting a path out. |
| `breakdown.total_h` | The four steps summed. |
| `breakdown.milestones` | The formulas behind `etaPlacementH` and `etaRemovalH`, spelled out. |
| `breakdown.note` | States plainly that the corpus records no observed rake TAT, so these coefficients are auditable **operating assumptions**, not validated outcomes. |

## Other M2 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m2/inbound` | **The whole rail board** — every real inbound rake in the corpus with its forecast. One call for the Rail tab. |
| `GET /uc2/m2/metrics` | Fidelity metrics and the real-rake exercise |
| `GET /uc2/m2/constants` | The named coefficients (`HANDLING`, `CTO_EFFICIENCY`) |
| `GET /uc2/m2/demo` · `GET /uc2/m2/health` · `GET /uc2/m2/model-card` | Standard |

---

# M3 — Gate Queue Forecast

## What it does

Predicts **how many trucks will be waiting in the queue at a gate over the next
hours**, converts that into an estimated wait in minutes, and says whether
arrivals should be **deferred** (told to come later).

**Two things to understand about this model:**

1. **The queue number is derived, not observed.** No gate log in the corpus
   counts waiting trucks. The queue is built from 1,929 *real* gate movements
   through a documented backlog formula:
   `queue[t] = max(0, queue[t−1] + arrivals[t] − 3.0)`, where 3.0 is the named
   service capacity per hour. So the target is a documented transform of real
   data, not an invention.

2. **`uc3_truck_inflow` is yours to supply.** This service has no camera feed
   and will not invent one. Feed it from UC-III's truck counts. If you omit it,
   the model uses its training stand-in and says so in the response.

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m3_gate_queue.py
python src/uc2_models/uc2_m3_gate_queue.py --gate CFS --hours 12   # print a 12-hour curve
python src/uc2_models/uc2_m3_gate_queue.py --leakage               # the three split protocols, side by side
python src/uc2_models/uc2_m3_gate_queue.py --json
python src/uc2_models/uc2_m3_gate_queue.py --selftest

# B. Runner
python run.py uc2 --model m3

# C. HTTP — one point
curl -X POST http://127.0.0.1:8200/uc2/m3/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"queue_lag1":9.0,"queue_lag2":6.0,"hour":9,"uc3_truck_inflow":8.0}'

# C. HTTP — the whole curve the Gate tab draws
curl "http://127.0.0.1:8200/uc2/m3/forecast/CFS?hours=12&uc3_truck_inflow=8"
```

## Input — what you must provide

Endpoint: `POST /uc2/m3/predict-one`

| Field | Type / range | Default | What it actually means, simply |
|---|---|---|---|
| `queue_lag1` | float, 0–500 | 4.0 | **How many trucks were queued one hour ago.** The strongest single clue — queues do not teleport. |
| `queue_lag2` | float, 0–500 | 3.0 | **How many trucks were queued two hours ago.** Tells the model whether the queue is growing or shrinking. |
| `hour` | int, 0–23 | 9 | **The clock hour you are forecasting for**, 24-hour. The service converts this into the two cyclical features itself — **your UI never does trigonometry.** |
| `uc3_truck_inflow` | float | *optional* | **How many trucks are approaching the gate right now**, from UC-III's camera counts. Omit it and the model falls back to its training stand-in and discloses that in `decision_path`. |

For the curve endpoint `GET /uc2/m3/forecast/{gate}`:

| Parameter | Meaning |
|---|---|
| `{gate}` | Which gate — `CFS` or `ECY`. |
| `hours` | How many hours ahead to forecast, 1–72. Default 12. |
| `uc3_truck_inflow` | Same as above, applied across the curve. |

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `queueVehicles` | **The headline answer: how many trucks will be in the queue.** Never negative. |
| `p10` / `p50` / `p90` | Optimistic / expected / pessimistic queue length. |
| `deferralRecommended` | **`true` = tell some trucks to come later.** The queue is above the threshold. |
| `deferralThreshold` | The number that triggers the above. Currently `8`. |
| `estimatedWaitMinutes` | **How long a truck arriving now would wait**, in minutes. Computed as `queue × 20 min ÷ 3 lanes`. |
| `features.hour_sin` / `hour_cos` | The clock hour converted into a smooth 24-hour cycle so that 23:00 and 00:00 are neighbours, not opposites. Derived for you. |
| `features.hour_of_day` | The plain hour you sent, echoed back. |
| `breakdown.rule` | The deferral rule in words: `deferralRecommended = queue > 8`. |
| `breakdown.queue_vs_threshold` | How far above (or below) the threshold you are. Negative = comfortable. |
| `breakdown.wait_formula` | The wait arithmetic, spelled out. |
| `breakdown.service_capacity_per_hour` | The gate's assumed throughput (3.0/h). **Change this and every queue number changes** — which is why it is echoed on every response. |
| `breakdown.feature_notes` | A one-line plain-English note per feature, including the disclosure about how `uc3_truck_inflow` is stood in for during training. |

**Curve points** (`GET /uc2/m3/forecast/{gate}`) carry all of the above plus:

| Field | What it means |
|---|---|
| `ts` | The timestamp this point is forecasting for. |
| `stepAhead` | How many hours ahead this point is (1, 2, 3, …). |
| `deferralWindows` (on the envelope) | Ready-made time ranges you can shade on the chart. |

> **Charting rule.** Each step is fed its own previous output, so uncertainty
> compounds — the bands **widen by √step**. Do not draw a constant-width ribbon.

## Other M3 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m3/leakage` | The three split protocols (rolling-origin / chronological tail / shuffled) with scores, and why two are rejected. Reviewer evidence. |
| `GET /uc2/m3/series?gate=CFS&limit=200` | The derived queue series itself with its provenance |
| `GET /uc2/m3/metrics` · `/constants` · `/demo` · `/health` · `/model-card` | Standard |

---

# M4 — Event-Sequence Anomaly Detection

## What it does

Looks at the trail of events for a container — gated in, customs flagged,
scanned, gated out — and reports **which containers have a broken paperwork or
movement chain, and how urgent each break is**.

It is **not** a learned model. It is a versioned rule engine with six rules, and
that is deliberate: an exception queue that a customs officer has to act on must
be explainable line by line.

**This model is being graded on the shared data.** The bidder briefing states
that irregularities are present by design and that detecting them is part of the
evaluation. So the real deliverable is `GET /uc2/m4/scan`, which runs every rule
over the whole real corpus. Current result: **1,401 containers scanned, 1,136
flagged, 1,139 findings, 265 clean.**

### The six rules

| ID | Type | Fires when | Severity |
|---|---|---|---|
| R1 | `ANOMALY_MISSING_GATE_OUT` | Box gated in more than **72 h** ago and never gated out | **CRIT** |
| R2 | `ANOMALY_LEO_NO_MOVE` | Export cleared by customs (LEO) more than **48 h** ago with no movement since | WARN |
| R3 | `ANOMALY_SCAN_FLAG_NO_SCAN` | Flagged for customs examination more than **24 h** ago with no scan started | WARN |
| R4 | `ANOMALY_ORPHAN_GATE_OUT` | A gate-out with no matching gate-in — the box left without ever arriving on record | WARN |
| R5 | `ANOMALY_NEGATIVE_DWELL` | Gate-out timestamped *before* gate-in — impossible, so a data fault | **CRIT** |
| R6 | `ANOMALY_DWELL_OUTLIER` | Dwell beyond the observed 99th percentile | INFO |

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m4_event_anomaly.py                  # evaluate + scan the corpus
python src/uc2_models/uc2_m4_event_anomaly.py --scan --limit 25 # corpus findings only, top 25
python src/uc2_models/uc2_m4_event_anomaly.py --json
python src/uc2_models/uc2_m4_event_anomaly.py --selftest

# B. Runner
python run.py uc2 --model m4

# C. HTTP — one container
curl -X POST http://127.0.0.1:8200/uc2/m4/predict \
  -H 'Content-Type: application/json' \
  -d '{"trail":[{"eventType":"GATE_IN","ts":"2026-07-01T08:00:00"},
                {"eventType":"CUSTOMS_FLAG","ts":"2026-07-01T14:00:00"}],
       "now":"2026-07-05T08:00:00","container":"DEMO0000001"}'

# C. HTTP — the whole corpus (the graded output)
curl "http://127.0.0.1:8200/uc2/m4/scan?limit=100"
curl "http://127.0.0.1:8200/uc2/m4/scan?limit=100&severity=CRIT"
```

## Input — what you must provide

Endpoint: `POST /uc2/m4/predict`

| Field | Type | Default | What it actually means, simply |
|---|---|---|---|
| `trail` | list of `{eventType, ts}` | required | **The container's history: everything that happened to it, and when.** Order does not matter — the service sorts and validates for you. |
| `trail[].eventType` | text | required | **What happened.** One of: `GATE_IN`, `GATE_OUT`, `LEO`, `CUSTOMS_FLAG`, `SCAN_START`, `SCAN_DONE`, and a few more. See the vocabulary below. |
| `trail[].ts` | ISO-8601 text | required | **When it happened**, e.g. `"2026-07-01T08:00:00"`. |
| `now` | ISO-8601 text | *optional* | **The moment to judge "how long ago" against.** Leave it out and it defaults to the latest event in the trail — which is what you want when replaying history, so old records do not all light up red. Set it to the current time when checking live containers. |
| `container` | text, ≤32 chars | `""` | **The container number**, e.g. `MSKU2256091`. Purely for labelling the finding. |

**Event vocabulary in plain words:**

| Event | Meaning |
|---|---|
| `GATE_IN` | The box physically entered the facility. |
| `GATE_OUT` | The box physically left. |
| `LEO` | *Let Export Order* — customs cleared this export box to leave. |
| `CUSTOMS_FLAG` | Customs selected this box for examination. |
| `SCAN_START` | The scan of a flagged box began. |
| `SCAN_DONE` | The scan finished. |

The parser also accepts `{"event": ..., "timestamp": ...}` as alternative key
names, so a slightly different upstream feed still works.

For `GET /uc2/m4/scan`:

| Parameter | Meaning |
|---|---|
| `limit` | How many findings to return, 0–5000. Default 100. |
| `severity` | Filter to `CRIT`, `WARN` or `INFO` only. |

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `container` | The container number you asked about. |
| `eventCount` | How many events were in the trail. |
| `clean` | **`true` = nothing wrong with this container.** |
| `findingCount` | How many problems were found. |
| `worstSeverity` | The most urgent severity among the findings — `CRIT`, `WARN` or `INFO`. **Sort your exception queue by this, then by `ageHours`.** |
| `findings[]` | One entry per problem found: |
| ⤷ `ruleId` | Which rule fired — `R1`…`R6`. |
| ⤷ `type` | The machine-readable anomaly name, e.g. `ANOMALY_MISSING_GATE_OUT`. |
| ⤷ `severity` | `CRIT` (act now), `WARN` (look at it today), `INFO` (unusual but not broken). |
| ⤷ `reason` | **A plain-English sentence you can put straight on screen**, e.g. *"Gated in 96.0 h ago with no gate-out (threshold 72 h)."* |
| ⤷ `ageHours` | **How long the problem has existed.** Older = more urgent within the same severity. |
| ⤷ `evidence` | The exact timestamps and thresholds that triggered the rule, so the finding can be checked and disputed. |

**Scan output** (`GET /uc2/m4/scan`) adds:

| Field | What it means |
|---|---|
| `containersScanned` | How many containers were examined (1,401 today). |
| `containersWithFindings` | How many had at least one problem (1,136 today). |
| `byType` | A count per anomaly type — your bar chart. |
| `bySeverity` | A count per severity — your traffic-light summary. |
| `topFindings[]` / results list | The individual findings, worst first. |

## Other M4 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m4/rules` | The versioned rule block — each rule's threshold, severity and required evidence |
| `GET /uc2/m4/metrics?n=400&seed=505` | Precision, recall, F1 and the confusion matrix, overall and per rule |
| `GET /uc2/m4/demo` · `/constants` · `/health` · `/model-card` | Standard |

---

# M5 — Discharge Rate & Berth Stay Tracking

## What it does

Two jobs:

1. **Tracking** — measure every real vessel call against its own plan: did she
   arrive late, did she stay longer than planned, did she leave late?
2. **Re-forecasting** — given a vessel that is *currently working*, and how much
   of her cargo is done so far, project **when she will actually finish** and
   whether she is on plan.

Deliberately deterministic. A learned discharge-rate model needs move-level
crane productivity history, and the shared corpus contains none. What it does
contain is enough to *measure* honestly — and honest tracked actuals are exactly
what a productivity regression would later be trained on.

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m5_discharge_berth_stay.py
python src/uc2_models/uc2_m5_discharge_berth_stay.py --json
python src/uc2_models/uc2_m5_discharge_berth_stay.py --selftest

# B. Runner
python run.py uc2 --model m5

# C. HTTP — re-forecast a working vessel
curl -X POST http://127.0.0.1:8200/uc2/m5/reforecast \
  -H 'Content-Type: application/json' \
  -d '{"via_no":"Q2806","terminal":"BMCT","moves_total":1200,
       "moves_done":400,"elapsed_h":8.0,"planned_stay_h":24.0,"cranes":3.0}'

# C. HTTP — every real call measured against plan
curl http://127.0.0.1:8200/uc2/m5/tracking
```

## Input — what you must provide

Endpoint: `POST /uc2/m5/reforecast`

| Field | Type / range | Default | What it actually means, simply |
|---|---|---|---|
| `via_no` | text, ≤32 chars | `"Q2806"` | **The vessel call number** — the port's ID for this particular visit. Labelling only. |
| `terminal` | text, ≤32 chars | `"BMCT"` | **Which terminal she is working at.** Used to pick the right crane-productivity assumption if the observed rate cannot be trusted. Known: `BMCT`, `NSICT`, `NSIGT`, `NSFT`, `GTI`, `GTIL`, `APMT`. |
| `moves_total` | int, >0 to 20000 | 1200 | **How many container moves this call needs in total** (discharge + load). |
| `moves_done` | int, 0–20000 | 400 | **How many moves are finished so far.** |
| `elapsed_h` | float, 0–500 | 6.0 | **How many hours she has been working.** Together with `moves_done` this gives the observed rate. |
| `planned_stay_h` | float, >0 to 500 | *optional* | **How many hours the berth plan says she should stay.** Supply it and you get the variance-vs-plan and the status badge. |
| `cranes` | float, >0 to 12 | 3.0 | **How many quay cranes are working her.** Only used if the observed rate cannot be trusted yet. |

> **The rate gate.** The observed rate is only trusted after **0.5 h elapsed AND
> 5% of the parcel worked**. Below that, a rate from a handful of moves in the
> first minutes would drive the entire projection, so the terminal's crane
> assumption is used instead and `rateSource` says `"assumption"`. **Badge that.**

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `viaNo` / `terminal` | Echo of which call this is. |
| `movesTotal` / `movesDone` / `elapsedHours` | Echo of the progress you reported. |
| `observedRateMovesPerHour` | **How fast she is actually working**, moves per hour. `moves_done ÷ elapsed_h`. |
| `remainingMoves` | How many moves are left. |
| `remainingHours` | **How many more hours of work at the current rate.** |
| `remainingWindowHours` | `[lower, upper]` — the realistic range for that remaining time, derived from the observed spread of real stay variance (not an assumed distribution). |
| `projectedTotalStayHours` | **The headline answer: total hours at the berth**, = elapsed + remaining + 2.4 h berth overhead (pilot on/off, lashing, gangway, survey). |
| `plannedStayHours` | What the plan said. |
| `varianceVsPlanHours` | **Projected minus planned.** Positive = she will overstay. Negative = she is ahead. |
| `status` | The badge: `ON_PLAN` (within 2 h), `AT_RISK` (2–6 h over), `DELAYED` (more than 6 h over), `AHEAD` (finishing early). |
| `rateSource` | **`"observed"` = measured from her actual progress. `"assumption"` = the terminal's crane figure was substituted** because it was too early to trust the observation. Badge the second one. |
| `breakdown.steps[]` | The four-line arithmetic, substituted: observed rate, assumed rate (with `used: true/false`), remaining work, projected total stay. |
| `breakdown.rate_gate` | The rule above, in words. |
| `breakdown.interval_source` | Where the uncertainty band came from — file, row count, median, mean, sd, p10, p90 of 720 real berth stays. |
| `breakdown.constants` | The crane-productivity table and berth overhead actually used. |

**Tracking output** (`GET /uc2/m5/tracking`) — one row per real vessel call:

| Field | What it means |
|---|---|
| `vesselName` / `viaNo` / `terminal` | Who and where. |
| `plannedStayHours` / `actualStayHours` | Plan vs outcome. |
| `arrivalDelayHours` | Actual arrival minus expected arrival (ATA − ETA). |
| `departureDelayHours` | Actual departure minus expected departure (ATD − ETD). |
| `stayVarianceHours` | **Actual stay minus planned stay.** The number that matters. |
| `status` | `ON_PLAN` / `AT_RISK` / `DELAYED` / `AHEAD`. |
| `dischargeRateMovesPerHour` + `rateSource` | Her rate, and whether it was measured or assumed. |
| `summary` | Pooled statistics — mean/median/max/min stay variance, mean arrival delay, and a count by status. |

## Other M5 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m5/moves` | Real move counts per terminal and direction, from the 6,467 EAL/IAL container lines |
| `GET /uc2/m5/berth-stays` | The observed berth-stay distribution the intervals come from |
| `GET /uc2/m5/constants` · `/model-card` · `/health` | Standard |

---

# M6 — Dynamic Lane Assignment

## What it does

Gate lanes have gone down. This model decides **which traffic goes to which open
lane**, computes **how long the wait becomes**, and flags **traffic that has no
compatible lane at all**.

It is a transparent allocator, not a forecast — and that is the right answer. A
lane reassignment has to be made in the seconds after a closure, defended to a
gate supervisor, and re-made the moment the closure changes. Every step comes
back with its arithmetic substituted.

### The six lanes

| Lane | Name | Throughput/h | Accepts | Powered | Hazmat |
|---|---|---|---|---|---|
| L1 | Lane 1 - Import | 30 | `IMPORT_LADEN`, `EMPTY` | no | no |
| L2 | Lane 2 - Import | 30 | `IMPORT_LADEN`, `EMPTY` | no | no |
| L3 | Lane 3 - Export | 28 | `EXPORT_LADEN`, `EMPTY` | no | no |
| L4 | Lane 4 - Export | 28 | `EXPORT_LADEN`, `EMPTY` | no | no |
| L5 | Lane 5 - Reefer | 22 | `REEFER`, `IMPORT_LADEN`, `EXPORT_LADEN` | **yes** | no |
| L6 | Lane 6 - Hazardous | 18 | `HAZARDOUS`, `IMPORT_LADEN`, `EXPORT_LADEN` | no | **yes** |

Note that **L6 is the only lane that takes hazardous traffic** and **L5 is the
only powered lane**. Close either and that traffic class becomes unservable —
which the allocator reports rather than hides.

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m6_lane_assignment.py                  # scenario S4
python src/uc2_models/uc2_m6_lane_assignment.py --scenario S4B   # S4 during an import surge
python src/uc2_models/uc2_m6_lane_assignment.py --scenario S4C   # only the reefer lane down
python src/uc2_models/uc2_m6_lane_assignment.py --json
python src/uc2_models/uc2_m6_lane_assignment.py --selftest

# B. Runner
python run.py uc2 --model m6

# C. HTTP — your own demand and closure
curl -X POST http://127.0.0.1:8200/uc2/m6/plan \
  -H 'Content-Type: application/json' \
  -d '{"demand_per_hour":{"IMPORT_LADEN":42,"EXPORT_LADEN":38,"EMPTY":18,
                          "REEFER":8,"HAZARDOUS":4},
       "closed_lanes":["L2","L4","L6"]}'

# C. HTTP — a named scenario, with the baseline delta already computed
curl http://127.0.0.1:8200/uc2/m6/scenario/S4

# C. HTTP — demand pulled from M3's queue forecast, so the two models agree
curl "http://127.0.0.1:8200/uc2/m6/from-forecast?gate=CFS&closed=L2,L4"
```

## Input — what you must provide

Endpoint: `POST /uc2/m6/plan`

| Field | Type | Default | What it actually means, simply |
|---|---|---|---|
| `demand_per_hour` | object `{class: trucks/hour}` | required | **How many trucks per hour of each kind want to come through the gate.** |
| `closed_lanes` | list of lane IDs | `[]` | **Which lanes are out of service**, e.g. `["L2","L4","L6"]`. Everything else is treated as open. |

**The five movement classes**, in plain words:

| Class | Meaning |
|---|---|
| `IMPORT_LADEN` | Full import boxes coming out of the port. |
| `EXPORT_LADEN` | Full export boxes coming into the port. |
| `EMPTY` | Empty containers, either direction. |
| `REEFER` | Refrigerated boxes — needs a **powered** lane. |
| `HAZARDOUS` | Dangerous goods — needs a **hazmat-certified** lane. |

**Named scenarios** (`GET /uc2/m6/scenario/{id}`) — these come with the demand
and closure pre-set and a baseline comparison already computed:

| ID | What it is |
|---|---|
| `BASELINE` | All six lanes open, normal demand. The reference plan. |
| `S4` | Three of six lanes closed (L2, L4, L6) at unchanged demand — including the only hazmat lane. |
| `S4B` | S4 *plus* an import surge from a vessel discharge landing at the same time. The case that actually breaks the gate. |
| `S4C` | Only the reefer lane (L5) is down. Reefer traffic has no compatible lane at all. |

**`GET /uc2/m6/from-forecast`** parameters: `gate` (default `CFS`),
`hours_ahead` (default 1), `closed` (comma-separated, e.g. `L2,L4`).

## Output — what comes back, field by field

| Field | What it means, simply |
|---|---|
| `scenarioId` / `title` | Which scenario this is, if named. |
| `openLanes` / `closedLanes` | Which lanes the plan assumes are working. |
| `assignments[]` | **The plan itself — one entry per open lane:** |
| ⤷ `laneId` / `name` | Which lane. |
| ⤷ `assigned` | **What traffic to send here**, as `{class: trucks/hour}`. This is the instruction to the gate supervisor. |
| ⤷ `loadPerHour` | Total trucks per hour sent to this lane. |
| ⤷ `capacityPerHour` | What the lane can actually process per hour. |
| ⤷ `utilisation` | Load ÷ capacity. `1.0` = exactly full. **Above 1.0 = over capacity and the queue will grow.** |
| ⤷ `projectedWaitMinutes` | **How long a truck waits in this lane.** |
| ⤷ `saturated` | `true` = this lane is at or over 100%. |
| `unservableDemandPerHour` | **⚠ Render this prominently.** Traffic that has *no compatible open lane at all* — e.g. `{"HAZARDOUS": 4.0}` when L6 is closed. This is a plan that **cannot execute**, not merely a long queue. |
| `totalDemandPerHour` | All the traffic wanting through. |
| `totalCapacityPerHour` | All the throughput the open lanes can give. |
| `capacityHeadroomPerHour` | Capacity minus demand. **Negative = the gate is structurally short**, e.g. `−30.0` means 30 trucks/hour more than the gate can take. |
| `worstWaitMinutes` | The longest wait on any lane. |
| `meanWaitMinutes` | The average wait across loaded lanes. |
| `throttleRecommended` | **`true` = start turning trucks away upstream.** Triggered above 45 min worst wait, or by any unservable demand. |
| `throttleClasses` | **Which traffic classes to throttle**, unservable ones first. |
| `status` | `OK` · `THROTTLE` (worst wait ≥ 45 min) · `CRITICAL` (≥ 90 min) · `UNSERVABLE_DEMAND` (some traffic has nowhere to go — the worst state). |
| `demand_source` | `"caller"` = you supplied the demand; `"uc2_m3"` = it came from the M3 queue forecast; `"scenario"` = a named scenario. |
| `breakdown.policy` | The allocation rule in words: most-constrained class first, then spread across compatible lanes in proportion to spare capacity; overflow goes to the least-loaded lane and is **reported, never dropped**. |
| `breakdown.wait_formula` | The queueing arithmetic. Note: at or above saturation it reports the one-hour backlog delay rather than infinity, because a blank cell tells a gate supervisor nothing. |
| `breakdown.thresholds` | The 45 min / 90 min trigger points. |
| `breakdown.steps[]` | Every allocation decision, substituted — e.g. *"HAZARDOUS: no compatible lane open → 4.0/h UNSERVABLE"*. |
| `breakdown.lanes[]` | The full lane roster with capabilities, so the UI does not hard-code it. |
| `baselineComparison` | **What this closure actually costs**: `lanesLost`, `capacityLostPerHour`, `worstWaitIncreaseMinutes`, `meanWaitIncreaseMinutes`, `statusChange` (e.g. `"OK -> UNSERVABLE_DEMAND"`), and `newlyUnservable` (classes that were fine before and are not now). |

## Other M6 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m6/lanes` | The lane roster and compatibility matrix |
| `GET /uc2/m6/constants` · `/demo` · `/health` · `/model-card` | Standard |

---

# M7 — Empty Pool & Reefer Surge Management

## What it does

Two related jobs:

1. **Reefer plug allocation** — a reefer-heavy discharge is landing and some
   plugs are broken. **Which boxes get the plugs, how many are left exposed, and
   how long before the first one is at risk?**
2. **Empty pool balance** — **does each terminal have the empty containers it
   needs**, and if not, which terminal should send how many to which?

Rule-auditable on purpose. A reefer that loses power spoils its cargo — that is
a safety and commercial risk, so the decision is a transparent priority matcher,
never a learned policy.

> **Why M7 reports `degraded: true` today.** Two of the nine shipping-line
> inventory files are legacy `.xls` needing `xlrd` and are not read. The
> provenance on every M7 response names them. Installing `xlrd` clears it. They
> are not silently dropped, because an empty-pool balance that quietly loses a
> terminal is wrong in a direction nobody can see.

### Cargo sensitivity — the priority order

Plugs go to whichever cargo can survive unplugged for the *shortest* time:

| Sensitivity | Holds temperature for | Priority |
|---|---|---|
| `PHARMA` | 4 hours | 1st — plugged first |
| `FROZEN` | 8 hours | 2nd |
| `CHILLED` | 12 hours | 3rd |
| `AMBIENT_CONTROLLED` | 24 hours | 4th |
| `UNKNOWN` | 8 hours (assumed) | last |

## How to run it

```bash
# A. Direct
python src/uc2_models/uc2_m7_empty_pool_reefer.py                  # scenario S6
python src/uc2_models/uc2_m7_empty_pool_reefer.py --scenario S6B   # pharma-heavy surge
python src/uc2_models/uc2_m7_empty_pool_reefer.py --scenario BASELINE
python src/uc2_models/uc2_m7_empty_pool_reefer.py --json
python src/uc2_models/uc2_m7_empty_pool_reefer.py --selftest

# B. Runner
python run.py uc2 --model m7

# C. HTTP — reefer plug allocation
curl -X POST http://127.0.0.1:8200/uc2/m7/reefer-allocation \
  -H 'Content-Type: application/json' \
  -d '{"reefers_arriving":742,"plugs_failed":18,"plugs_total":96,
       "sensitivity_mix":{"CHILLED":0.5,"FROZEN":0.3,"PHARMA":0.05,
                          "AMBIENT_CONTROLLED":0.15}}'

# C. HTTP — empty pool balance (empty body = use the real corpus proxy)
curl -X POST http://127.0.0.1:8200/uc2/m7/empty-balance \
  -H 'Content-Type: application/json' -d '{}'

# C. HTTP — the real position, and a named scenario
curl http://127.0.0.1:8200/uc2/m7/pool
curl http://127.0.0.1:8200/uc2/m7/scenario/S6
```

## Input A — reefer plug allocation

Endpoint: `POST /uc2/m7/reefer-allocation`

| Field | Type / range | Default | What it actually means, simply |
|---|---|---|---|
| `reefers_arriving` | int, 0–5000 | 200 | **How many refrigerated containers are about to land** and need power. |
| `plugs_total` | int, >0 to 1000 | 96 | **How many reefer plug points the yard has in total.** 96 at the Container Parking Plaza. |
| `plugs_failed` | int, 0–96 | 0 | **How many of those plugs are broken right now** — e.g. a switchboard fault took out 18. |
| `sensitivity_mix` | object `{class: fraction}` | *optional* | **What proportion of the arriving reefers is each cargo type.** Fractions should sum to 1. Omit it and the model uses the corpus mix. Example: `{"CHILLED":0.5,"FROZEN":0.3,"PHARMA":0.05,"AMBIENT_CONTROLLED":0.15}` = half chilled, 30% frozen, 5% pharma, 15% ambient-controlled. |

**Named scenarios** (`GET /uc2/m7/scenario/{id}`):

| ID | What it is |
|---|---|
| `BASELINE` | Normal arrivals from the real corpus, all 96 plugs live. |
| `S6` | Reefer surge ×3.5 with 18 plugs failed — a reefer-heavy discharge lands while a switchboard fault hits. The published regression case. |
| `S6B` | Pharma-heavy surge ×2.5 with 18 plugs failed. Fewer boxes, but far less time before the first one is at risk. |

## Input B — empty pool balance

Endpoint: `POST /uc2/m7/empty-balance`

| Field | Type | Default | What it actually means, simply |
|---|---|---|---|
| `daily_demand_by_terminal` | object `{terminal: boxes/day}` | *optional* | **How many empty containers each terminal needs per day.** Omit it (send `{}`) and the model estimates demand from export-laden volumes in the real corpus — and says so via `demandSource: "proxy_export_laden"`. |

## Output A — reefer allocation, field by field

| Field | What it means, simply |
|---|---|
| `reefersArriving` / `plugsTotal` / `plugsFailed` | Echo of the situation. |
| `plugsAvailable` | Total minus failed — the plugs that physically work. |
| `plugsReserved` | 5% held back deliberately. **You never plan to the last plug.** |
| `plugsAllocatable` | Available minus reserved — what the allocator actually distributes. |
| `allocatedBySensitivity` | **Who gets a plug**, by cargo type. Highest-risk cargo is served first. |
| `unpluggedBySensitivity` | **Who does not get a plug**, by cargo type. This is your exposure. |
| `shortfall` | **Total boxes with no power.** The single number for the duty manager. |
| `hoursToFirstRisk` | **The countdown clock: how many hours until the most sensitive unplugged box starts to spoil.** `8.0` means eight hours to act. |
| `priorityEvacuation` | **The ordered list of which cargo classes to move or re-power first.** Act top-down. |
| `status` | `OK` (everything plugged) · `CRITICAL` (first risk in ≤ 4 h) · `AT_RISK` (≤ 8 h) · `SHORT` (boxes exposed but with more time). |
| `breakdown.policy` | The priority rule in words. |
| `breakdown.hold_hours` | The temperature-hold table above. **These are the numbers to argue with** if operations disagrees. |
| `breakdown.steps[]` | Every allocation decision substituted — plug bank arithmetic, then `min(arriving_in_class, plugs_remaining)` per class, then the exposure calculation. |
| `breakdown.constants` | The plug count and reserve percentage in force. |

## Output B — empty pool balance, field by field

| Field | What it means, simply |
|---|---|
| `demandSource` | Where the daily demand came from — yours, or the export-laden proxy. |
| `shortTerminals` | **Which terminals are running out of empties.** |
| `repositionPlan[]` | **The instruction: move `units` empties `from` one terminal `to` another**, with a `reason` sentence you can display. |
| `balances[]` | One row per terminal: |
| ⤷ `terminal` | Which terminal. |
| ⤷ `emptiesAvailable` | How many empty boxes it has on hand. |
| ⤷ `dailyDemand` | How many it burns through per day. |
| ⤷ `daysCover` | **How many days it can last** at current demand. This is the key number. |
| ⤷ `status` | `SHORT` (below 1.5 days cover — act) · `ADEQUATE` (fine) · `SURPLUS` (above 3 days — can donate). |
| ⤷ `repositionUnits` | **Positive = send this many boxes in. Negative = this many can be taken out.** |

## Other M7 endpoints

| Endpoint | What it gives you |
|---|---|
| `GET /uc2/m7/pool` | The real empty and reefer position from the 6,467 corpus container lines |
| `GET /uc2/m7/constants` · `/demo` · `/health` · `/model-card` | Standard |

---

# Appendix A — Every command in one place

```bash
# Setup
pip install -r requirements.txt

# Run everything
python run.py uc2                    # all 7 models + write all sample I/O
python run.py uc2 --list             # list the models
python run.py uc2 --export           # also export the joblib model bundles
python run.py uc2 --json             # print the full result as JSON
python run.py uc2 --no-write         # run but write nothing
python run.py corpus                 # which data sources are real vs degraded

# Run one model through the runner
python run.py uc2 --model m1              # ... m2, m3, m4, m5, m6, m7

# Run one model directly (no server, prints a human report)
python src/uc2_models/uc2_m1_container_dwell.py
python src/uc2_models/uc2_m2_rake_tat.py
python src/uc2_models/uc2_m3_gate_queue.py
python src/uc2_models/uc2_m4_event_anomaly.py
python src/uc2_models/uc2_m5_discharge_berth_stay.py
python src/uc2_models/uc2_m6_lane_assignment.py
python src/uc2_models/uc2_m7_empty_pool_reefer.py

# Useful per-model flags
python src/uc2_models/uc2_m1_container_dwell.py --validate
python src/uc2_models/uc2_m2_rake_tat.py --validate --engine learned
python src/uc2_models/uc2_m3_gate_queue.py --leakage --gate CFS --hours 12
python src/uc2_models/uc2_m4_event_anomaly.py --scan --limit 25
python src/uc2_models/uc2_m6_lane_assignment.py --scenario S4B
python src/uc2_models/uc2_m7_empty_pool_reefer.py --scenario S6B

# Every model also accepts --json and --selftest

# The HTTP service
python run.py serve-uc2              # http://127.0.0.1:8200
# then:
#   http://127.0.0.1:8200/docs                interactive OpenAPI (try every model in a browser)
#   http://127.0.0.1:8200/uc2/demo-all        one headline per model
#   http://127.0.0.1:8200/uc2/manifest        every route and version
#   http://127.0.0.1:8200/uc2/model-cards     the whole WS2 table as JSON
#   http://127.0.0.1:8200/uc2/corpus          data-source badges
#   http://127.0.0.1:8200/health?deep=true    all 7 modules, full self-tests (~40 s)
```

Environment variables: `JNPA_PORT` overrides the port, `JNPA_HOST` the host,
`JNPA_UC2_INFERENCE_LOG=0` turns off inference logging.

---

# Appendix B — Which model to call for which question

| A user asks… | Call |
|---|---|
| "When will this box leave the yard?" | **M1** `POST /uc2/m1/predict-one` |
| "How long will this train block the siding?" | **M2** `POST /uc2/m2/predict-one` |
| "Show me every inbound rake with a forecast." | **M2** `GET /uc2/m2/inbound` |
| "How bad will the gate queue be this afternoon?" | **M3** `GET /uc2/m3/forecast/CFS?hours=12` |
| "Should we defer truck arrivals?" | **M3** — check `deferralRecommended` |
| "Which containers are stuck in paperwork?" | **M4** `GET /uc2/m4/scan?severity=CRIT` |
| "Is this one container OK?" | **M4** `POST /uc2/m4/predict` |
| "When does this vessel finish working?" | **M5** `POST /uc2/m5/reforecast` |
| "Which vessels ran over their berth plan?" | **M5** `GET /uc2/m5/tracking` |
| "Three lanes just closed — what now?" | **M6** `POST /uc2/m6/plan` |
| "What does that closure cost us?" | **M6** `GET /uc2/m6/scenario/S4` (has the baseline delta) |
| "Do we have enough reefer plugs?" | **M7** `POST /uc2/m7/reefer-allocation` |
| "Does any terminal need empties?" | **M7** `POST /uc2/m7/empty-balance` |

---

# Appendix C — Four rules for anyone rendering these outputs

1. **Never show a bare point.** Every prediction carries `p10`/`p50`/`p90`.
   Show the band; a single number implies a confidence the model does not have.
2. **`degraded: true` must be visible.** It means a fallback produced the
   number. Show a badge. Never hide it.
3. **`decision_path` is the audit trail.** Put it behind a hover or info icon.
4. **On missing input, suspend — do not extrapolate.** A 422 names the offending
   field. Show "suspended — awaiting `<field>`", never a stale or guessed value.

---

*Generated against the shipped code on 2026-08-02. Every field name, range,
default, endpoint and command in this document was read from the source and the
regenerated sample I/O files, not written from memory.*
