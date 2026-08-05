# UC-II Models — Integration Guide

**Jawaharlal Nehru Port Authority · Digital Twin PoC · Tender GeM/2026/B/7297343**
Workstream 2 — UC-II Improved Cargo Handling & Logistics Optimization

This is the wiring document. It tells a frontend engineer what to call, what
comes back, and what must be rendered. It does not explain the models — for
that read the module docstrings or `docs/WS2_UC2_AI_ML_Tools.md`.

---

## 1. Sixty-second start

```bash
pip install -r requirements.txt

python run.py corpus        # what real data is present            (exit 0)
python run.py uc2           # run all 7 models, write sample I/O   (exit 0)
python run.py serve-uc2     # start the HTTP service on :8200
```

Then open <http://127.0.0.1:8200/docs> for live OpenAPI, or:

```bash
curl http://127.0.0.1:8200/uc2/demo-all      # one headline per model
curl http://127.0.0.1:8200/uc2/manifest      # every route, no hard-coding needed
```

**You do not have to run the server to see the shapes.** `python run.py uc2`
writes a matched request/response pair per model:

| File | What it is |
|---|---|
| `data/input/uc2/m3_request.json` | the body to POST, verbatim |
| `out/uc2/m3_response.json` | exactly what comes back |
| `out/uc2/uc2_dashboard.json` | the flattened shape a UI card renders |
| `out/uc2/uc2_model_cards.json` | the whole WS2 table as JSON |
| `out/uc2/uc2_corpus_inventory.json` | which data sources are real vs degraded |

Both files are regenerated from the real models on every run, so they cannot
drift into fiction the way a hand-written example does.

---

## 2. The seven models

| | Model | Answers | Primary endpoint |
|---|---|---|---|
| **M1** | Container dwell | "How many hours will this box sit?" | `POST /uc2/m1/predict-one` |
| **M2** | Rake TAT | "How long is this train on the siding?" | `POST /uc2/m2/predict-one` |
| **M3** | Gate queue | "How many trucks queue next hour?" | `POST /uc2/m3/predict-one` |
| **M4** | Event anomaly | "Whose paperwork chain is broken?" | `POST /uc2/m4/predict` |
| **M5** | Discharge & berth stay | "Is this vessel to plan? When does she finish?" | `POST /uc2/m5/reforecast` |
| **M6** | Lane assignment | "Three lanes are down — what now?" | `POST /uc2/m6/plan` |
| **M7** | Empty pool & reefer | "Enough empties? Enough plugs?" | `POST /uc2/m7/reefer-allocation` |

Every model additionally exposes:

```
GET  <prefix>/health          module health + self-test results
GET  <prefix>/demo            the canonical scenario, no body needed
GET  <prefix>/constants       versioned coefficients ("Link to Model Weights")
GET  <prefix>/model-card      the WS2 submission row, generated from what ran
```

Service-level:

```
GET  /health?deep=true        all 7 modules, full self-tests (slow, ~40 s)
GET  /uc2/manifest            route + version discovery
GET  /uc2/model-cards         every model card in one call
GET  /uc2/constants           every constant block in one call
GET  /uc2/corpus              data-source badges
GET  /uc2/demo-all            one headline per model — good for first paint
GET  /uc2/inference-log       the AI-inference evidence log
```

---

## 3. Four rules that bind every response

These are not stylistic. They come from the acceptance criteria, and a UI that
breaks them fails the evidence check.

### 3.1 Never render a bare point

Every prediction carries an interval and its provenance:

```json
{
  "queueVehicles": 8.33,
  "p10": 7.64, "p50": 8.33, "p90": 9.08,
  "model_version": "m3-gate-queue-v2.0.0",
  "trained_at": "2026-08-02T07:02:47Z"
}
```

Render the band. A single number implies a confidence the model does not have.

### 3.2 `degraded: true` must be visible

`degraded` means a fallback produced this number — a synthetic series, the
stdlib regression engine instead of gradient boosting, an assumed crane rate
instead of an observed one. Show a badge. Never hide it.

Today M7 returns `degraded: true` because two of the nine shipping-line
inventory files are legacy `.xls` that need `xlrd`; the provenance names them.

### 3.3 `decision_path` explains which engine ran

```
"decision_path": "engine=hist_gradient_boosting | series=CORPUS | split=chronological | uc3_truck_inflow=caller_supplied"
```

Put it behind a hover or an info icon. It is the one-line audit trail.

### 3.4 On missing input, suspend — do not extrapolate

The services return **422** with the offending field named rather than guessing:

```json
{ "detail": "expected 5 features in the order ['queue_lag1', 'queue_lag2', 'hour_sin', 'hour_cos', 'uc3_truck_inflow'], got 2" }
```

The panel must show "suspended — awaiting <field>", not a stale or extrapolated
value.

---

## 4. Model-by-model wiring

### M1 — Container dwell → Yard / pendency panel

```bash
curl -X POST http://127.0.0.1:8200/uc2/m1/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"stream_idx":0,"line_idx":1,"arrival_cadence_h":4.0,
       "customs_flag":1,"reefer":1,"facility_load":0.85,
       "gate_in_utc":"2026-08-02T06:30:00Z"}'
```

Returns `dwellHours`, `p10/p50/p90Hours`, `predictedDepartureWindowH`, and —
when `gate_in_utc` is supplied — absolute `predictedDepartureUtc` and
`predictedDepartureWindowUtc` so the UI does no date arithmetic.

There is also `POST /uc2/m1/predict` taking the published positional contract
`{"instances": [[stream_idx, line_idx, arrival_cadence_h, customs_flag, reefer, facility_load]]}`.
**Prefer the named form.** Positional vectors are how a dashboard silently swaps
two columns and ships it.

> **Rendering caveat.** M1's headline accuracy (MAE 3.69 h) is measured on
> synthetic data. Its real-corpus figure (MAE 21.36 h, against a 15.74 h median
> baseline it does not beat) is at `GET /uc2/m1/metrics`. If the UI shows an
> accuracy, show both. They are not interchangeable.

### M2 — Rake TAT → Rail tab card

```bash
curl -X POST http://127.0.0.1:8200/uc2/m2/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"siding":1,"cto_idx":0,"wagon_count":45,"arrival_hour":9,"inbound":1,
       "container_count":53,"terminal_count":5,"engine":"handling",
       "eta_utc":"2026-08-02T09:00:00Z"}'
```

Returns `tatHours`, `etaPlacementH`, `etaRemovalH`, `departureWindowH`, and with
`eta_utc` the absolute `etaPlacementUtc` / `etaRemovalUtc` / `departureWindowUtc`.

`engine` selects `"handling"` (deterministic, the default and what you should
serve) or `"learned"`. `breakdown.steps` carries every term with its arithmetic
substituted — render it as the "why" drawer.

For the whole rail board in one call:

```
GET /uc2/m2/inbound      every real inbound rake with its forecast
```

### M3 — Gate queue → Gate tab curve

Single point:

```bash
curl -X POST http://127.0.0.1:8200/uc2/m3/predict-one \
  -H 'Content-Type: application/json' \
  -d '{"queue_lag1":9.0,"queue_lag2":6.0,"hour":9,"uc3_truck_inflow":8.0}'
```

Note `hour` is a plain clock hour — the service derives `hour_sin`/`hour_cos`,
so the UI never computes trigonometry.

The curve the Gate tab actually draws:

```
GET /uc2/m3/forecast/CFS?hours=12&uc3_truck_inflow=8
```

Returns 12 points, each with `queueVehicles`, `p10`, `p90`,
`estimatedWaitMinutes` and `deferralRecommended`, plus a `deferralWindows`
array you can shade directly. **Bands widen by √step** because each step is fed
its own previous output — do not draw a constant-width ribbon.

> **`uc3_truck_inflow` is yours to supply.** This service has no data client and
> will not invent one. Feed it from UC-III's camera counts. Omit it and you get
> the training stand-in, which the response discloses.

### M4 — Event anomaly → Exceptions queue

One container:

```bash
curl -X POST http://127.0.0.1:8200/uc2/m4/predict \
  -H 'Content-Type: application/json' \
  -d '{"trail":[{"eventType":"GATE_IN","ts":"2026-07-01T08:00:00"},
                {"eventType":"CUSTOMS_FLAG","ts":"2026-07-01T14:00:00"}],
       "now":"2026-07-05T08:00:00","container":"DEMO0000001"}'
```

The whole shared corpus — **this is the graded output**:

```
GET /uc2/m4/scan?limit=100
GET /uc2/m4/scan?limit=100&severity=CRIT
```

Current result: 1,401 containers scanned, 1,136 flagged, 1,139 findings, 265
clean. Sort by `worstSeverity` then `ageHours`; every finding carries an
`evidence` object with the timestamps that triggered it.

### M5 — Discharge & berth stay → Vessel working panel

```bash
curl -X POST http://127.0.0.1:8200/uc2/m5/reforecast \
  -H 'Content-Type: application/json' \
  -d '{"via_no":"Q2806","terminal":"BMCT","moves_total":1200,
       "moves_done":400,"elapsed_h":8.0,"planned_stay_h":24.0}'
```

`rateSource` is `"observed"` or `"assumption"` — badge the second. Below 0.5 h
elapsed or 5% of the parcel the service refuses to trust the observed rate,
because a rate from a handful of moves would drive the whole projection.

`GET /uc2/m5/tracking` returns every real vessel call measured against its own
plan, ready for a table.

### M6 — Lane assignment → Gate closure what-if

```bash
curl -X POST http://127.0.0.1:8200/uc2/m6/plan \
  -H 'Content-Type: application/json' \
  -d '{"demand_per_hour":{"IMPORT_LADEN":42,"EXPORT_LADEN":38,"EMPTY":18,
                          "REEFER":8,"HAZARDOUS":4},
       "closed_lanes":["L2","L4","L6"]}'
```

Or a named scenario with its baseline delta already computed:

```
GET /uc2/m6/scenario/S4        3 of 6 lanes closed
GET /uc2/m6/from-forecast?gate=CFS&closed=L2,L4
```

`from-forecast` pulls demand from M3 so the two models agree on what the gate is
facing. **Render `unservableDemandPerHour` prominently** — it means traffic with
no compatible open lane, which is a plan that cannot execute, not a long queue.

### M7 — Empty pool & reefer → ECY / CPP panel

```bash
curl -X POST http://127.0.0.1:8200/uc2/m7/reefer-allocation \
  -H 'Content-Type: application/json' \
  -d '{"reefers_arriving":742,"plugs_failed":18,"plugs_total":96}'

curl -X POST http://127.0.0.1:8200/uc2/m7/empty-balance \
  -H 'Content-Type: application/json' -d '{}'

curl http://127.0.0.1:8200/uc2/m7/pool
curl http://127.0.0.1:8200/uc2/m7/scenario/S6
```

`hoursToFirstRisk` is the countdown clock for the duty manager: how long before
the most sensitive unplugged box is at risk. `priorityEvacuation` is the
ordered list to move first.

---

## 5. A minimal frontend client

```js
const UC2 = "http://127.0.0.1:8200";

async function callModel(path, body) {
  const res = await fetch(`${UC2}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // 422 means an input was missing or out of range. Suspend the panel —
  // the acceptance criteria forbid extrapolating past a missing input.
  if (res.status === 422) {
    const { detail } = await res.json();
    return { suspended: true, reason: detail };
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Every card renders the same three provenance affordances.
function Provenance({ result }) {
  return (
    <div className="provenance">
      {result.degraded && <span className="badge badge--degraded">DEGRADED</span>}
      <span title={result.decision_path}>ⓘ</span>
      <small>{result.model_version} · trained {result.trained_at}</small>
    </div>
  );
}

// Gate tab: the queue curve.
const curve = await fetch(
  `${UC2}/uc2/m3/forecast/CFS?hours=12&uc3_truck_inflow=${uc3Count}`
).then(r => r.json());

curve.points.forEach(p => {
  drawBand(p.ts, p.p10, p.p90);          // widens with step — do not flatten
  drawLine(p.ts, p.queueVehicles);
  if (p.deferralRecommended) shadeDeferralWindow(p.ts);
});
```

Discover the surface instead of hard-coding it:

```js
const manifest = await fetch(`${UC2}/uc2/manifest`).then(r => r.json());
manifest.modules.forEach(m => console.log(m.module_id, m.prefix, m.routes.length));
```

---

## 6. Which data is real

`GET /uc2/corpus` (or `out/uc2/uc2_corpus_inventory.json`) returns a per-source
badge. As shipped, 12 of 13 sources parse fully from the real corpus:

| Source | State | Rows |
|---|---|---|
| CODECO container gate events | CORPUS | 1,929 |
| Paired container stays | CORPUS | 1,202 (483 complete) |
| FOIS train intimations | CORPUS | 59 |
| CTO rake manifests | CORPUS | 8 |
| TOS container entry/exit | CORPUS | 10 |
| TOS vessel calls | CORPUS | 5 |
| Customs LEO | CORPUS | 100 |
| Shipping bills | CORPUS | 100 |
| RMS scanning lists | CORPUS | 99 |
| ICEGATE IGM headers | CORPUS | 13 |
| EIR / Form 13 / pick-up tickets | CORPUS | 12 |
| EDI CODECO messages | CORPUS | 5 (format samples) |
| Shipping-line EAL / IAL | **PARTIAL** | 6,467 — 2 legacy `.xls` unread |

The one `PARTIAL` is why M7 reports `degraded: true`. Installing `xlrd` would
clear it; until then the two files are named in the provenance on every M7
response rather than silently dropped.

---

## 7. Inference logging (acceptance evidence)

JNPA requires AI-inference logs as evidence (Bidder Briefing p.4). Every call to
a `/uc2/*` endpoint appends one JSON line to `out/uc2/inference_log.jsonl`:

```json
{"ts":"2026-08-02T07:02:48.113Z","method":"POST","path":"/uc2/m3/predict-one",
 "status":200,"latency_ms":4.21,"module":"UC2-M3",
 "model_version":"m3-gate-queue-v2.0.0","app_version":"uc2-api-v1.0.0"}
```

On by default. `JNPA_UC2_INFERENCE_LOG=0` disables it. Readable over HTTP at
`GET /uc2/inference-log?limit=100`.

---

## 8. Deployment notes

| Concern | Current state | Before any public exposure |
|---|---|---|
| CORS | `allow_origins=["*"]` | Pin to the deployed frontend origin |
| Auth | None | Add API auth per the cybersecurity criterion |
| Cold start | 3 models train on first request (~20 s) | Call `GET /uc2/demo-all` at boot to warm them |
| Model cards | `/uc2/model-cards` retrains and rescans | Cache in the frontend; do not call per render |
| Port | 8200 (`JNPA_PORT` overrides) | — |

Both services can run side by side:

```bash
python run.py serve       # UC-I vessel traffic  :8000
python run.py serve-uc2   # UC-II cargo handling :8200
```

---

## 9. Troubleshooting

**`GET /health` returns 503.** Read `import_failures` and `mount_failures` in the
body. One broken module does not take the others down — six will still serve.

**A model reports `degraded: true` unexpectedly.** Run `python run.py corpus`.
Any source below `CORPUS` explains it, and the response's `provenance` block
names the missing files.

**Numbers changed between runs.** They should not: every seed is fixed
(101 / 202 / 303 / 505). If a metric moved, a split, threshold or generator
changed — and per the acceptance criteria `metrics.json`, the dashboard model
card and the submission table must all be re-measured and updated together.

**`ModuleNotFoundError: uc2_learn`.** You are running a module file directly
from an unexpected working directory. Use `python run.py uc2` or run from the
repository root.
