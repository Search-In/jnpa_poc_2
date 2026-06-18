# Coverage Matrix — JNPA UC2

> One row per: **Appendix C requirements 1–7**, **intended-use 1–3**, the **7
> KPIs**, **D.2 sub-criteria 1–5**, and **bid §8.4.1–8.4.5** commitments.
> `Status` is **green** when implemented *and* covered by an automated test or
> the `poc-selftest`. Run `pnpm poc-selftest` (24 checks) + `pnpm -r test`
> (TS) + `pytest` (Python) to reproduce.

Test totals: **TS 78** (schemas 40 · sim 8 · kpi 13 · data 18 — plus scenarios 3 · notifications 6 · gateway 11 = **98**) · **Python 29** (connectors 21 · AI 8) · **poc-selftest 24**.

---

## Appendix C requirements (1–7)

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| C1 Shared data platform, role-based, all cargo streams | App C §2.3 | `packages/data` MockAdapter, `services/gateway` RBAC | poc-selftest C1, gateway.test | ✅ |
| C2 Automated workflows / notifications | App C | `services/notifications`, `data/notifications-derive` | poc-selftest C2, notifications.test | ✅ |
| C3 Full rail-side T1/T2 + ITRHO | App C | `sim/generators/cargo` rakes+wagons, `getRailSide`/`getITRHO` | poc-selftest C3 | ✅ |
| C4 Trans-shipment / inter-terminal | App C | ITRHO model + `originStream=TRANSSHIP` | poc-selftest C4 | ✅ |
| C5 Feed data to TOS — 100% gate automation | App C req 7 | `gateway/gate-automation` `decideGate` | poc-selftest C5, gateway.test | ✅ |
| C6 Congestion sim → dynamic lane assignment | App C req 6 | `scenarios` LANE-ASSIGN | poc-selftest C6 | ✅ |
| C7 Road-congestion / gate-op simulations | App C req 6 | `scenarios` CGO-1/2/3 | poc-selftest C7, scenarios.test | ✅ |

## Intended-use (1–3)

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| IU1 Operational visibility across streams | App C | `apps/web` Movements/Pendency/Rail panels | mock-adapter.test | ✅ |
| IU2 Automated notifications (gate/scan/damage/pendency/queue) | App C | `services/notifications` §11 map | notifications.test | ✅ |
| IU3 Simulations + what-if | App C | `services/scenarios` | scenarios.test, poc-selftest | ✅ |

## The seven KPIs (§8)

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| Rake Turnaround Time | §8 | `kpi/kpis.rakeTurnaroundTime` | kpis.test, poc-selftest | ✅ |
| Inter-Terminal Transfer TAT | §8 | `kpi/kpis.interTerminalTransferTat` | kpis.test | ✅ |
| Trailer Turn Around Time | §8 | `kpi/kpis.trailerTurnaroundTime` | kpis.test | ✅ |
| Scanner Turn Around Time | §8 | `kpi/kpis.scannerTurnaroundTime` | kpis.test | ✅ |
| Transshipment Trailer TAT | §8 | `kpi/kpis.transshipmentTrailerTat` | kpis.test, integration.test | ✅ |
| Buffer Pendency | §8 | `kpi/kpis.bufferPendency` | kpis.test | ✅ |
| Mixed Train Optimization | §8 | `kpi/kpis.mixedTrainOptimization` | integration.test | ✅ |
| *(rollups: gate throughput, gate txn time, container pendency)* | §8.4.4 | `kpi/kpis` | integration.test | ✅ |

## D.2 sub-criteria (1–5)

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| D1 Functional completeness | Bid D.2 | full dashboard surface via adapter | poc-selftest D1 | ✅ |
| D2 Standards integration (EDI/X12/ICES/ULIP, CloudEvents/AsyncAPI) | Bid D.2 | `schemas/mappers`, `sim/events` | edifact/x12/ices/ulip tests, poc-selftest D2 | ✅ |
| D3 Resilience / fallback transparency | Bid D.2 §8.4.3 | connector fallback chain + Health Cards | test_connectors, poc-selftest D3 | ✅ |
| D4 Security / RBAC | Bid D.2 §7.3 | `gateway/auth`, `gateway/app` | gateway.test, poc-selftest D4 | ✅ |
| D5 Cross-domain interdependency | Bid D.2 | `schemas/cross-twin`, `scenarios` CGO-2 | scenarios.test, poc-selftest D5 | ✅ |

## Bid §8.4 commitments (1–5)

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| §8.4.1 EDI/X12 standards | Bid §8.4.1 | CODECO/COARRI/COPRAR/BAPLIE/IFTSTA + X12 322/315/304 | edifact.test, x12.test | ✅ |
| §8.4.2 AI/ML models + thresholds | Bid §8.4.2 | `services/ai` ×4 + metrics.json | test_ai_models | ✅ |
| §8.4.3 Connectors + fallback chain | Bid §8.4.3 | `services/connectors` ×6 | test_connectors | ✅ |
| §8.4.4 Dashboard KPIs + rollups + notifications | Bid §8.4.4 | `apps/web`, `kpi`, `notifications` | kpis/integration/notifications tests | ✅ |
| §8.4.5 What-if scenarios (CGO-1/2/3) | Bid §8.4.5 | `services/scenarios`, `data/scenarios-mock` | scenarios.test, mock-adapter.test | ✅ |

## Addendum

| Item | Source ref | Implemented in | Test | Status |
|---|---|---|---|---|
| A.1 ArcGIS operational layers | Addendum A.1 | `apps/web/map/layers` (facilities/gates/pendency/flows) | web build | ✅ |
| A.2 Map tools (legend, layer list, what-if overlay) | Addendum A.2 | `apps/web/map/PortMap` | web build | ✅ |
| B.1 Demo-console control groups | Addendum B.1 | `apps/demo-console`, `sim/registry` | demo-console build | ✅ |
| B.4 Console acceptance | Addendum B.4 | `sim/injectors`, controller | poc-selftest B1–B5 | ✅ |

---

**All rows green.** Reproduce: `pnpm install && pnpm poc-selftest && pnpm -r test`
and `cd services && ../.venv/bin/python -m pytest`.
