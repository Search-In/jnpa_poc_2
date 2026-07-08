# Assumptions Register — JNPA UC2

> Per prompt §0: **nothing is assumed silently.** Every assumed dataset,
> threshold or mapping is recorded here with a justification and a path to
> replace it with a JNPA-confirmed value (almost always a config-file edit, no
> code change). Items marked **CONFIRM** are the two highest-leverage values an
> evaluator will ask about (terminal operators, KPI baselines).

Legend — **Status**: `ASSUMED` (placeholder), `CONFIRM` (needs JNPA sign-off),
`DERIVED` (from a cited public source), `DECISION` (deliberate design choice).

---

## 1. Terminal operators & geometry  — CONFIRM

- **Source of truth:** [`config/terminals.json`](../config/terminals.json).
- Seeded with JNPA's container terminals NSICT, NSIGT, GTI, BMCT, JNPCT and the
  T1/T2 rail sidings. Operators, capacities and geometry are **approximate** and
  flagged in-file. JNPCT operator is in transition (CONFIRM).
- **Geometry** is approximate berth-line centroids; replace with surveyed
  polygons from the JNPA WebMap (`ARCGIS_WEBMAP_ID`) before production.
- **Replace by:** editing `config/terminals.json` — no code change.

## 2. KPI baselines  — CONFIRM

- **Source of truth:** [`config/baselines.json`](../config/baselines.json).
- Each KPI's improvement-% is computed against these current-state baselines.
  Where a public NLDS / jnport.gov.in figure exists it is cited as `DERIVED`;
  the rest are `ASSUMED` with the justification below.

<a id="rake-tat-baseline"></a>
### rake-tat-baseline — 8.5 hr (ASSUMED)
Indian Railways CTO siding cycle norms run ~6–10 hr; midpoint used pending a JNPA
FOIS extract of arrival→departure per rake. Replace with `rakeTurnaroundTime` in
`baselines.json`.

<a id="itrho-baseline"></a>
### itrho-baseline — 6.0 hr (ASSUMED)
Inter-terminal trans-shipment trailer cycle estimate, pending an ITRHO log
extract. Replace `interTerminalTransferTat`.

<a id="trailer-tat-baseline"></a>
### trailer-tat-baseline — 4.0 hr (ASSUMED)
Road-trailer port-visit dwell estimate (gate-in→gate-out). Replace
`trailerTurnaroundTime`.

<a id="scanner-tat-baseline"></a>
### scanner-tat-baseline — 2.5 hr (ASSUMED)
Customs scan queue + exam cycle estimate. Replace `scannerTurnaroundTime`.

<a id="transship-trailer-baseline"></a>
### transship-trailer-baseline — 5.0 hr (ASSUMED)
Trans-shipment trailer cycle (TAT filtered to `originStream=TRANSSHIP`). Replace
`transshipmentTrailerTat`.

<a id="buffer-pendency-baseline"></a>
### buffer-pendency-baseline — 1200 Nos (ASSUMED)
Typical CFS buffer pendency snapshot, pending a facility-pendency extract.
Replace `bufferPendency`.

<a id="mixed-train-baseline"></a>
### mixed-train-baseline — 78 containers/rake (ASSUMED)
BLCA/BLC rake nominal ~90-TEU capacity at ~85% utilisation. Replace
`mixedTrainOptimization`.

<a id="gate-txn-baseline"></a>
### gate-txn-baseline — 12.0 min (ASSUMED)
Pre-automation gate transaction estimate; target sub-5 min at 100% automation.
Replace `gateTransactionTime`.

---

## 3. Time-zone & timestamp handling — DECISION

- Source feeds (EDIFACT DTM, X12 dates, ICES dates, ULIP timestamps) carry
  **local wall-clock time without a zone**. We treat them as **IST (+0530)** by
  default (`defaultOffsetMin = 330`), convert to UTC for storage, and **preserve
  the source offset** (`sourceOffsetMin`) so the original wall-clock is
  recoverable (§3).
- Where a feed carries an explicit zone (EDIFACT DTM format `303`, epoch millis),
  that wins over the default.

## 4. EDI / X12 / ICES message profiles — ASSUMED

- EDIFACT directory version defaults to **D21A** (overridable per terminal via
  `tos.ediVersion`). Segment positions follow common terminal CODECO/COARRI/
  COPRAR/BAPLIE/IFTSTA profiles; exact positions are documented inline in each
  mapper and covered by golden-file tests. Replace a profile by adjusting the
  mapper's documented segment indices when a terminal supplies its spec.
- **CODECO gate direction**: BGM document-name code `34`→gate-in, `36`→gate-out
  (terminal-specific; documented in `codeco.ts`). Confirm per terminal.
- **ICES CHSAI**: parsed from the public ICES 1.5 sea-custodian message family;
  the message-type→event mapping is in `chsai.ts`. The minimal XML reader is a
  PoC choice (DECISION) — production swaps a hardened XML parser behind the same
  mapping contract.

## 5. Container-number validity — DECISION

- All container numbers are validated against the **real ISO 6346 check-digit
  algorithm**, not just a regex, so simulator output and parsed feeds are
  verifiably valid.

## 6. Live-data posture — DECISION (matches bid §8.4.3)

- Connectors are built against the **real published contracts** (ULIP, ICEGATE/
  ICES 1.5, EDIFACT, X12) but run against **schema-accurate simulators** in
  `DATA_MODE=mock`. A single credential-gated switch points them at production
  once KELTRON/JNPA completes ULIP NDA + ICEGATE DSC/IEC onboarding + CRIS
  access. The PoC pulls **no** live customs data without onboarding.
- **FOIS routing:** rail data is reached **through ULIP track/trace** first
  (`FOIS_VIA_ULIP=true`), with direct CRIS as the JNPA-facilitated fallback.

## 7. Fallback staleness budgets — ASSUMED

- ULIP cached-snapshot staleness budget: **60 min** (`ULIP_CACHE_STALENESS_MIN`).
  Beyond this, the connector escalates from `CACHED` to `SYNTHETIC` and flips the
  Health Card to AMBER/RED (§6). Confirm acceptable staleness with JNPA ops.

## 8a. ArcGIS SDK version — DECISION

- The prompt names "ArcGIS Maps SDK for JavaScript **5.x**". The actually-published
  npm line is `@arcgis/core` **4.31** with the modern `@arcgis/map-components`
  (`<arcgis-map>` web components, no deprecated widget classes) — which is the
  prompt's real intent ("web components — no deprecated widget classes"). We pin
  the latest published 4.x map-components generation; bump to 5.x when GA without
  code change (the web-component API is forward-compatible). Production target
  remains **ArcGIS Enterprise 11.3** (Corrigendum 3 Appendix A1).
- The dashboard runs **offline in mock mode**: layers are client-side
  FeatureLayers built from the sim dataset (no portal/token needed). With
  `ARCGIS_WEBMAP_ID` set it overlays the real JNPA port WebMap.

## 8b. AI model estimators — DECISION

- The bid (§8.4.2) names LightGBM/XGBoost (dwell) and LSTM/TFT (gate queue,
  rake TAT). The PoC trains the **same GBM family** via scikit-learn's
  `HistGradientBoostingRegressor` and a GBM autoregressor for the temporal models
  — no native build, runs anywhere, fast under arm64. The `/predict` I/O contract
  and feature lists are identical to the production models, so swapping in
  LightGBM/TFT is a one-line estimator change. Each model ships a real trained
  artifact + `metrics.json` whose metric is asserted against the bid threshold by
  `pytest` (dwell MAE ≤ 8h, gate-queue RMSE ≤ 3.5, rake-TAT MAE ≤ 2h, anomaly
  precision ≥ 0.85). Models train on **seeded synthetic** event-history features
  (documented in `services/ai/_common/features.py`) until real history is loadable
  via the connectors.

## 8. Scenario deltas — ASSUMED (demo targets, twin-vs-shadow A/B)

- The six §8.2 scenarios (S1–S6) each run **twin-vs-shadow A/B**: a do-nothing
  "shadow" continuation (arm A) and an intervention "twin" arm (B), both derived
  from the **same** base KPI snapshot. Every delta shown is B-vs-A. In offline
  mock mode A and B are two **named, documented deterministic parameter sets**
  (per-KPI multiplicative assumptions listed in `AB_DESIGNS`,
  `packages/data/src/scenarios-mock.ts`), not one magic factor — so each number is
  a modelled outcome under stated assumptions, never a claimed JNPA baseline.
- Example (S3, mixed-train optimisation, bid §8.2): the batched ITRHO split plan
  targets an inter-terminal-transfer-TAT improvement over the naive sequential
  split. The scenario is deterministic (fixed factors, seeded), so the delta is
  repeatable; the figure is a modelled target, not a measured result.
