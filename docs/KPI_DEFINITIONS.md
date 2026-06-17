# KPI Definitions — JNPA UC2

> Source of truth: [`services/kpi/src/kpis.ts`](../services/kpi/src/kpis.ts).
> Every KPI is a **pure function**, fully unit-tested with worked examples
> ([`test/kpis.test.ts`](../services/kpi/test/kpis.test.ts)). Each returns
> `{ key, label, value, unit, baseline, improvementPct, higherIsBetter, trend[], byFacility? }`.
> Baselines come from [`config/baselines.json`](../config/baselines.json)
> (evaluator-overridable; assumptions in [ASSUMPTIONS.md](ASSUMPTIONS.md)).

## Improvement-% convention

`improvementPct` is **normalised so positive always means "the twin is better
than baseline"**, regardless of metric direction:

- **lower-is-better** (TATs, pendency): `(baseline − value) / baseline × 100`
- **higher-is-better** (utilisation): `(value − baseline) / baseline × 100`

> Worked: value 8 hr vs baseline 10 hr (lower-better) → `(10−8)/10 = +20%`.
> Value 84 vs baseline 70 (higher-better) → `(84−70)/70 = +20%`.

---

## The seven KPIs (§8)

### 1. Rake Turnaround Time — `min/hr`, lower better
`rake.departureTs − rake.arrivalTs` (siding cycle), rolling mean per CTO/siding.

> **Worked:** R1 arrives 00:00, departs 08:00 → 8 h. R2 arrives 00:00, departs
> 12:00 → 12 h. KPI = mean(8, 12) = **10 h**. byFacility: T1=8, T2=12.

### 2. Inter-Terminal Transfer TAT — `hr`, lower better
`itrho.inTs − itrho.outTs`, mean over ITRHO movements.

> **Worked:** out 01:00, in 05:00 → **4 h**. baseline 8 → **+50%**.

### 3. Trailer Turn Around Time — `hr`, lower better
`gateOut.ts − gateIn.ts` for a trailer's port visit. Paired IN→OUT by
`containerNo` where OUT.startTs ≥ IN.startTs.

> **Worked:** gate-in 00:10, gate-out 03:10 → **3 h**.

### 4. Scanner Turn Around Time — `hr`, lower better
`scan.endTs − scan.startTs` (queue-in to clear), mean.

> **Worked:** start 00:00, end 02:00 → **2 h**. baseline 4 → **+50%**.

### 5. Transshipment Trailer TAT — `min/hr`, lower better
Trailer TAT filtered to `originStream=TRANSSHIP` / ITRHO **road** moves only.

### 6. Buffer Pendency — `Nos`, lower better
Count of containers in CFS/buffer awaiting next move **beyond the dwell
threshold**, per facility. A container is pending if its **latest** event is
non-terminal (not `GATE_OUT`/`RAIL_OUT`/`ITRHO_IN`) and its age at `asOf` ≥ the
configurable `bufferDwellThresholdHours`.

> **Worked (threshold 48 h, asOf 17th 12:00):** a container whose last event is a
> 15th-00:00 `YARD_MOVE` (60 h old) counts; one with a `GATE_OUT` does not; one
> only 6 h old does not. KPI = **1**, byFacility CFS-PUNE=1.

### 7. Mixed Train Optimization/Planning — `containers/rake` (% vs baseline), higher better
`containersPerRake` measured from distinct containers per rake in `RAIL_IN`/
`RAIL_OUT` events. Improvement-% = `(containersPerRake − baseline) / baseline`.
Captures mixed-rake utilisation gain and empty-running reduction.

---

## Dashboard rollups (bid §8.4.4)

| Rollup | Unit | Formula |
|---|---|---|
| **Gate Throughput** | Nos | count of `CLEARED` gate transactions, gate-wise breakdown |
| **Avg Gate Transaction Time** | min | mean(`endTs − startTs`) over completed gate transactions |
| **Container Pendency (CFS/ICD-wise)** | Nos | current pendency snapshot (Buffer Pendency at threshold 0), per facility |

---

## Determinism & testing

- The engine takes `asOf` explicitly (no clock read) → deterministic.
- Run `pnpm --filter @jnpa/kpi test` — 13 tests: per-formula worked examples +
  direction normalisation + sim-dataset integration + reproducibility.
