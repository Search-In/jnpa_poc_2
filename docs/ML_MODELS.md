# AI/ML Predictions — the UC-II model suite behind the Movements tab

**Jawaharlal Nehru Port Authority · Digital Twin PoC · Tender GeM/2026/B/7297343**
Workstream 2 — UC-II Improved Cargo Handling & Logistics Optimization

The Movements tab has a **Predictions** column. Clicking *Predict* on a row opens
a panel showing what every applicable WS2 UC-II model says about that container.
This document explains how that works, how it fails, and — the part that matters
most — what in it is estimated rather than observed.

---

## 1. Sixty-second start

```bash
# 1. the model service (once)
cd ml
python3 -m venv .venv
.venv/bin/pip install -r requirements-service.txt -r requirements-dev.txt
JNPA_PORT=8200 .venv/bin/python run.py serve-uc2

# 2. the app, in another terminal
pnpm --filter @jnpa/web dev      # http://localhost:5173
```

Open **Movements → Predict** on any row.

Without the service running the panel says so, names it, and prints the command
above. It does not blame the Cargo backend — see §6.

---

## 2. Architecture

```
  apps/web  ContainerMovements.tsx        Predictions column, one cell per row
       │         │
       │         └── ContainerPredictionsDrawer.tsx   the panel
       │                   │
       │                   └── predictionStore.ts     one call serves every row
       │                             │
       │                             └── data/ml/{client,predictions,types}.ts
       │                                        │
       │                                        │  POST /ml-api/uc2/webapp/predictions
       ▼                                        ▼
  Vite dev proxy  /ml-api → :8200        nginx  /ml-api → ml:8200      (prod)
                                                ▼
  ml/  src/service/api_uc2.py                   the FastAPI app, :8200
         └── src/pipeline/uc2_predictions.py    THE FAN-OUT (added here)
                   └── src/uc2_models/uc2_webapp_adapter.py   the translator
                             └── src/uc2_models/uc2_m1..m7*.py   the seven models
```

**The model service is never published directly.** It is stateless, holds no
port data and carries no auth of its own, so it lives on the private network
with the proxy as the only door — the same posture as `/poc3`. There is no
`ports:` entry for it in `docker-compose.yml`, deliberately.

**Port 8200, not 8000.** The POC-3 Cargo API holds 8000 in this stack, and the
WS2 delivery's own default is also 8000. The port is therefore set explicitly
(`JNPA_PORT`) in dev, in compose and in nginx rather than left to a default.

### Which model set this is

UC-2 had two candidate model implementations. This feature is built on the WS2
delivery models, vendored under `ml/`:

| | | |
|---|---|---|
| **Used here** | `ml/src/uc2_models/` | Seven WS2 models, stdlib-only, self-testing, audited, with published metrics and honesty disclosures. Covers M5/M6/M7. |
| **Left alone** | `services/ai/*/model.py` | Four sklearn models on synthetic data, already wired to the gateway. Does not implement M5, M6 or M7 at all. |

Both are running. `services/ai` was not touched and not retired; that is a
separate decision.

---

## 3. The seven models, and which ones describe your container

This drives the whole layout, and getting it wrong is how a panel tells an
operator that three gate lanes are down *as a fact about the box in front of
them*.

| Scope | Models | Shown |
|---|---|---|
| **Per container** | **M1** dwell, **M4** document/event chain | Always. These answer "how long will THIS box sit" and "is THIS box's chain broken". |
| **Contextual** | M2 rake TAT, M3 gate queue, M5 berth stay | Only when the row carries the evidence: a rail box earns M2, a road movement earns M3, a row naming a vessel earns M5. A rake forecast for a box that is not on a train is noise dressed as insight. |
| **Facility-level** | **M6** lane assignment, **M7** empty pool / reefer | In a separate "Gate & yard figures" section, never inside the container's cards, each carrying a line saying what set it describes. |

The separation is **structural, not cosmetic**: `facility_summary` is a
different key in the response from `containers[].models`, so the UI cannot
render M6/M7 as properties of one container even by mistake. A self-test
enforces it (`uc2_predictions.selftest`, "facility models are never inside a
container") and so does a frontend test.

---

## 4. Why the whole page is scored, not one container

`arrival_cadence_h` — hours since the previous container arrived at the same
facility — is **not a property of a row**. It is only measurable *across* rows.
Send one container and M1 falls back to the 6.0 h default and raises `degraded`;
send the visible page and the cadence is measured from the gaps between arrival
times at each terminal. M6 and M7 are the same story at facility scale.

So one *Predict* click sends the whole visible page (up to 60 rows, focal
container always first and never dropped), and every row is read out of the same
document. Opening a second container inside the 5-minute TTL is instant.

The panel reports `N cadence measured` so you can see how much of the page got
the measured value rather than the default.

---

## 5. What is estimated, and where estimation is allowed to happen

**The frontend estimates nothing.** This is a rule, not a preference: two
screens that each invent their own default will disagree, and neither will know
it. Every substitution happens in `uc2_webapp_adapter.py`, versioned, and is
recorded in a per-container ledger that travels in the response.

A Movements row cannot supply everything the models want. What typically gets
substituted:

| Model input | Substituted with | Why the row cannot supply it |
|---|---|---|
| `facility_load` | 0.70 (corpus median yard occupancy) | The Cargo record carries no yard utilisation. |
| `arrival_cadence_h` | 6.0 h (corpus mean inter-arrival gap) | Only when the page held no earlier arrival at that terminal. |
| `line_idx` | `OTHER` | An unrecognised shipping-line code maps to OTHER and **says so** — it does not map to index 0 (MSC) and pretend. |
| `customs_flag` | 0 (not held) | Only when neither a customs status nor a scan selection is present. |

The panel shows a single chip — `3 estimated` or `all inputs observed` — with
the full list on hover, repeated in the collapsed **Model inputs** section
because a touch screen has no hover.

**That count is model INPUTS, not models.** It is deliberately never rendered as
a fraction: "5 of 8" beside a suite of seven models reads as *five of the seven
models*, which is a different and much worse claim. The number also varies per
container, because the ledger only records inputs it actually had to resolve.

### One translation the frontend does *not* do

`originStream` (`IMPORT_DPD`, `EXPORT_CFS`, …) travels **verbatim** to the
service. Expanding it into the adapter's `Delivery_Mode` / `DPD_Eligible`
columns is domain knowledge, and it lives in `uc2_predictions.normalise_row()`,
in Python, recorded in the ledger's warnings. A test pins this: if
`toRequestRow` ever starts emitting `Delivery_Mode`, it goes red.

---

## 6. Failure modes

### The model service is not running

The panel says:

> `[ML]` The UC-II model service is not reachable at
> `/ml-api/uc2/webapp/predictions`. Start it with
> `cd ml && JNPA_PORT=8200 .venv/bin/python run.py serve-uc2`…

**This one is harder than it looks, and it is the defect most likely to be
reintroduced.** With the service stopped, the Vite dev proxy answers
`500 Internal Server Error` with an **empty `text/plain` body** — measured, in
this repo:

```
status=500  content-type=[text/plain]  bytes=0
```

`fetch` therefore **resolves**. A classifier that looks only at the status calls
this a generic 5xx, and the panel blames whichever backend the generic branch
names — a system that was not involved. nginx does the same thing with a 502.

The discriminator is the **body**, not the status: FastAPI always answers JSON,
so a 5xx with no JSON body did not come from the model service. When that
happens the client probes `/health` before deciding, because the two causes need
opposite actions:

| | Cause | What to do |
|---|---|---|
| `/health` does not answer | the service is **down** | start it |
| `/health` answers | the service is **up and crashed on this request** | read the traceback |

`looksLikeProxyFailure()` in `apps/web/src/data/ml/client.ts` carries this, and
its tests fail if the body check is removed.

### A model fails

Models degrade individually and visibly. A model that raises is recorded in
`run.models_failed` and named in a notice at the top of the panel; the other
models still answer. The panel never quietly renders five cards where seven were
expected.

### A model degraded

Any block whose `degraded` is true gets an amber **degraded** badge, with the
`decision_path` (`engine=… | series=… | split=…`) on hover. That badge is never
hidden — a fallback produced the number and the operator is entitled to know.

### The request is too large

Over 60 containers the request is trimmed, the focal container is kept, and the
panel shows how many were left out and why. Nothing shrinks silently.

---

## 7. The three published numbers that are never smoothed

These are the delivery's own disclosures. The UI carries them; it does not
average, blend or hide them.

1. **M1 publishes two accuracies.** 3.69 h MAE on a seeded synthetic generator,
   and 21.36 h on 254 real container stays — where it **loses** to a 15.74 h
   median baseline. Both ship. Neither may appear alone.
   *In this checkout the corpus is excluded, so the real-stay figure cannot be
   recomputed.* Rather than let the flattering synthetic number stand alone, the
   service emits `realCorpusMetricsAvailable: false` and a reason naming the
   exclusion, and the panel renders it. A self-verifying test enforces this.
2. **M2's metric is fidelity, not accuracy.** The corpus records no observed
   rake turnaround, so there is nothing to be accurate *to*. The word "accuracy"
   never attaches to M2 — the only key containing it is
   `metricIsFidelityNotAccuracy`, which is the disclosure itself. Both a Python
   self-test and a frontend test check this.
3. **M3 publishes three split protocols** and serves the rolling-origin one.
   Every leakage figure travels with `splitPolicy`, the protocol that produced
   it. `shuffledRmse` is labelled for comparison only: it leaks the future and
   always flatters the model.

---

## 8. The glossary is shipped with the data

The panel renders **generically** — it iterates whatever fields the service
returned, so a model that gains a field appears without a frontend change
instead of being silently dropped by a hand-written interface.

That is only honest if every field arrives with a definition. So the document
carries its own `glossary` (99 entries), rendered as hover text on every key,
and `uc2_predictions.selftest()` **fails** if a rendered key has neither a gloss
nor a place in `SELF_EVIDENT_KEYS`. The Docker build runs that self-test, so a
field added without a definition fails the build rather than reaching an
operator as an unexplained number.

---

## 9. The corpus is not in this repository

The 43 MB WS2 corpus is excluded. Six of the seven models degrade without it and
badge `degraded: true`; M6 is unaffected.

**`ml/data/corpus/README.md` is the record** — what degrades per model, what it
costs the test suite, and how to restore it. Read that file rather than
re-deriving it from a red test run. The short version: the panel works end to
end, every degraded figure is badged, and M1's real-corpus accuracy is reported
as unavailable rather than omitted.

---

## 10. Verifying a change

```bash
cd ml
# Every module's self-test — the seven models, the adapter and the fan-out.
# This is what the Docker build runs, and it is the command to use here.
.venv/bin/python tools/selftest_gate.py      # 9/9 modules pass
.venv/bin/python -m pytest -q                # 73 passed, 6 skipped
.venv/bin/python -c "import api_uc2"         # the app mounts

# The fan-out, against a real row
curl -s -X POST http://127.0.0.1:8200/uc2/webapp/predictions \
  -H 'content-type: application/json' \
  -d '{"focus":"MAEU6123458","rows":[{"Container_No":"MAEU6123458", …}]}' | jq

# Frontend
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

**Then do it live, in both states** — stop the service and click *Predict*, then
start it and click again. The first must name the model service and the command
that starts it; if it blames the gateway, the body check in §6 has been lost.

### About the tests

Every regression test in `apps/web/test/ml-predictions*.test.ts*` was confirmed
to **fail when its fix is removed** — a test that passes with and without the
fix certifies nothing while looking like coverage. The counterfactual is named
in a comment above each one.

`test/calcite-passthrough.tsx` is the stand-in for the Calcite React wrappers,
which need a registered custom element that node has none of. It has its own
test file, because a mock that does not mirror the real component hides the bug
you are testing: it **always renders children** and **always forwards `title`**,
the two axes on which the UC-1 build's mocks diverged and silently disarmed the
tests written against them.

`test/fixtures/predictions-response.json` is a verbatim live response, not a
hand-written fixture — a hand-built one drifts from the service the moment a
model gains a field, and then the tests certify a shape nobody serves.
