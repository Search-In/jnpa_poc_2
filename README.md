# JNPA Use Case 2 — Improved Cargo Handling & Logistics Optimization

Digital Twin module + PoC for **Jawaharlal Nehru Port Authority**.
Tender **GEM/2026/B/7297343** · Appendix C §2.3 (Corrigendum 3, pp. 40–42) · Bid §8.4.

A shared, role-based data platform giving operational visibility and automated
workflows across **every cargo stream** (Import CFS/ICD/DPD, Export CFS/ICD/DPE,
trans-shipment), **full rail-side T1/T2 visibility + ITRHO**, feeds to terminal
TOS for gate automation, and what-if simulations (congestion → dynamic lane
assignment). **ArcGIS is the spatial spine**; a presenter-facing **Demo Console**
drives the same event backbone as the live connectors for offline, deterministic
demos.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Monorepo skeleton, config, env | ✅ |
| 1 | `packages/schemas` — canonical model + EDI/X12/ICES/ULIP mappers + golden tests + Data Dictionary | ✅ (gate) |
| 2 | `packages/data` + `MockAdapter` + `packages/sim` → dashboard end-to-end on mock | ⏳ |
| 3 | `services/kpi` + tests + KPI definitions | ⏳ |
| 4 | `apps/web` full dashboard (ArcGIS) | ⏳ |
| 5 | Connectors (sim → live behind switch) + Health Cards | ⏳ |
| 6 | AI services + metric tests | ⏳ |
| 7 | Scenarios (CGO-1/2/3 + lane sim) + cross-twin | ⏳ |
| 8 | Notifications, RBAC, gate-automation feed | ⏳ |
| 9 | Security/compliance, i18n, poc-selftest, COVERAGE all-green | ⏳ |

## Quick start (mock mode — zero credentials)

```bash
pnpm install
pnpm --filter @jnpa/schemas test     # 40 golden + schema tests
# pnpm dev                            # (Phase 2+) full dashboard on mock data
```

`DATA_MODE=mock` runs the whole stack offline against schema-accurate simulators
in `packages/sim`. No external credential is needed for the demo path.

## Live-data onboarding (KELTRON/JNPA only)

The connectors are built against the **real published contracts** and run against
simulators until production access is granted, then a single switch
(`DATA_MODE=live`) points them at production (bid §8.4.3). Each credential and the
exact onboarding step:

| Source | Credential(s) | Onboarding step |
|---|---|---|
| **ULIP** | `ULIP_API_KEY` | Register at goulip.in → submit use-case → sign NDA → TEST token → integrate+demo → PRODUCTION token |
| **ICEGATE / ICES 1.5** | `ICEGATE_CLIENT_ID`, `ICEGATE_DSC_THUMBPRINT` | IEC + Class-3 DSC + ICES 1.5 message-exchange onboarding |
| **FOIS / rail** | `FOIS_VIA_ULIP` (preferred) or `CRIS_FOIS_URL` | Reach via ULIP track/trace first; direct CRIS is JNPA-facilitated |
| **TOS** (per terminal) | `TOS_<terminal>_*` | Per-terminal EDIFACT/X12/REST/file-drop access |
| **ArcGIS** | `ARCGIS_WEBMAP_ID`, `ARCGIS_APP_ID` | Share JNPA port WebMap + OAuth app (same item as UC1) |

See [`.env.example`](.env.example) for the full variable list and
[`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) for every assumed value.

## Repository layout

```
apps/web            React + ArcGIS DTCCC cargo dashboard
apps/demo-console   Presenter control console (shared across UC1/2/3)
services/gateway    API gateway/BFF: authN/Z, rate-limit, health aggregation
services/connectors ulip · icegate · tos · fois · eseal · shipline
services/ai         dwell-predictor · gate-queue-forecaster · rake-tat · anomaly
services/kpi        pure, unit-tested KPI engine
services/scenarios  what-if engine (CGO-1/2/3 + congestion/lane sim)
services/notifications  event → fan-out + ack tracking
packages/schemas    canonical types + EDI/X12/ICES mappers   ← Phase 1
packages/data       typed adapter: MockAdapter | LiveAdapter
packages/sim        schema-accurate simulators + generators
docs/               ASSUMPTIONS · COVERAGE · KPI_DEFINITIONS · API_CONTRACTS · DATA_DICTIONARY
scripts/poc-selftest  asserts each D.2 sub-criterion + Appendix C requirement
config/             terminals.json · baselines.json (config-driven, evaluator-overridable)
```

## Key documents

- [Data Dictionary](docs/DATA_DICTIONARY.md) — every canonical field
- [Assumptions Register](docs/ASSUMPTIONS.md) — nothing assumed silently
