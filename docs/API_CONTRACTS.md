# API & Event Contracts — JNPA UC2

> Two contract surfaces: (1) the **gateway REST API** the dashboard / LiveAdapter
> binds to (§5), and (2) the **event backbone** (CloudEvents 1.0 / AsyncAPI 2.6,
> §1) carrying gate/rail/customs events + notifications + the **gate-automation
> feed** (§13) terminal TOS consume, and the **cross-twin** channel (§12).

---

## 1. Gateway REST API (BFF)

Base: `GATEWAY_PORT` (default `:8080`). All `/api/*` require `Authorization:
Bearer <JWT>`; claims carry the RBAC `role` (§9). Per-consumer rate limiting +
audit logging + OWASP security headers applied (§14).

| Method | Path | Role | Returns |
|---|---|---|---|
| GET | `/health` | public | `{ ok, mode }` |
| POST | `/auth/dev-token` | public (PoC only) | `{ token, role }` — replaced by OIDC in prod |
| GET | `/api/terminals` | any | `Terminal[]` |
| GET | `/api/facilities` | any (scoped) | `Facility[]` |
| GET | `/api/kpis` | any | `KpiResult[]` (7 + 3 rollups) |
| GET | `/api/integration-health` | any | `IntegrationHealth[]` |
| GET | `/api/pendency` | any | `PendencyDTO[]` |
| GET | `/api/gate-ops` | any | `GateOpsDTO[]` |
| GET | `/api/gate-queue-forecast/:gateId` | any | `GateQueueForecastDTO` |
| GET | `/api/rail-side/:siding` | any | `RailSideDTO` (T1/T2) |
| GET | `/api/rake-forecast/:rakeId` | any | `RakeForecastDTO` |
| GET | `/api/itrho` | any | `ITRHOMovement[]` |
| GET | `/api/scan-queue` | any | `ScanEvent[]` |
| GET | `/api/empty-pool` | any | `EmptyPoolDTO` |
| POST | `/api/container-movements` | any (scoped) | `ContainerMovementDTO[]` |
| GET | `/api/notifications` | any (role-filtered) | `Notification[]` |
| POST | `/api/notifications/:id/ack` | any | `{ acked }` |
| POST | `/api/scenarios/:id` | port-wide roles only | `ScenarioRunResult` |
| POST | `/api/gate-decision` | any | `GateDecision` (§13) |
| GET | `/api/audit` | `DTCCC_ADMIN` | `AuditEntry[]` |

Errors: `401` unauthenticated, `403` role-forbidden, `429` rate-limited, `404`,
`500`.

---

## 2. Gate-automation feed (§13, Appendix C req 7) — publishable contract

The twin returns **validated gate decisions** a terminal TOS consumes for 100%
gate automation. Synchronous via `POST /api/gate-decision`, and also published
as a CloudEvents stream on topic `jnpa.uc2.gate-decisions`.

**Request** (`GateDecisionRequest`):
```json
{
  "gateId": "NSICT-G1",
  "vehicleNo": "MH04AB1234",
  "containerNo": "MAEU1234567",
  "sealNo": "SEAL778899",
  "appointmentRef": "APPT-12345",
  "customsStatus": "CLEAR",
  "vehicleCompliant": true
}
```

**Response** (`GateDecision`, version `1.0`):
```json
{
  "version": "1.0",
  "gateId": "NSICT-G1",
  "containerNo": "MAEU1234567",
  "vehicleNo": "MH04AB1234",
  "decision": "ALLOW",
  "reasons": [],
  "checks": {
    "containerVehicleMatch": true,
    "esealIntact": true,
    "customsClear": true,
    "appointmentValid": true,
    "vehicleCompliant": true
  },
  "decidedTs": "2026-06-17T08:30:00.000Z"
}
```

Decision policy: hard-fail (vehicle mismatch / broken e-seal / non-compliant
vehicle) → **DENY**; customs hold or unknown appointment → **HOLD**; else
**ALLOW**.

---

## 3. Event backbone — AsyncAPI 2.6 / CloudEvents 1.0

All events ride a CloudEvents 1.0 structured-mode envelope (`specversion`,
`type`, `source`, `id`, `time`, `subject`, `data`, `dataschema`, `jnpamode`).
The `jnpamode` extension (`LIVE`/`CACHED`/`SYNTHETIC`) is what the Health Card
badge reflects — the only way to tell sim from live.

| Topic | `type` prefix | Payload | Producer → Consumer |
|---|---|---|---|
| `jnpa.uc2.cargo-events` | `jnpa.uc2.cargo.<EventType>` | `CargoEvent` | connectors/sim → gateway, notifications, KPI |
| `jnpa.uc2.gate-transactions` | `jnpa.uc2.gate.*` | `GateTransaction` | TOS connector → gateway |
| `jnpa.uc2.rail` | `jnpa.uc2.rail.*` | `Rake`/rail event | FOIS connector → gateway |
| `jnpa.uc2.itrho` | `jnpa.uc2.itrho.*` | `ITRHOMovement` | TOS → gateway |
| `jnpa.uc2.scans` | `jnpa.uc2.scan.*` | `ScanEvent` | ICEGATE → gateway |
| `jnpa.uc2.notifications` | `jnpa.uc2.notify.*` | `Notification` | notifications → dashboard |
| `jnpa.uc2.integration-health` | `jnpa.uc2.health` | `IntegrationHealth` | connectors → gateway |
| `jnpa.uc2.gate-decisions` | `jnpa.uc2.gate-decision` | `GateDecision` | gateway → terminal TOS |
| `jnpa.crosstwin.deferred-arrival` | `jnpa.crosstwin.uc2.deferred-arrival` | `DeferredArrivalWindow` | UC2 scenario → **UC3 Trucking App** |
| `jnpa.crosstwin.deferred-arrival` | `jnpa.crosstwin.uc3.dpd-release` | `DpdReleaseNotice` | **UC3** → UC2 |

The machine-readable AsyncAPI 2.6 document is generated at
[`docs/asyncapi.yaml`](asyncapi.yaml).

---

## 4. Cross-twin contract (§12, D.2 sub-criterion 5)

Defined once in `@jnpa/schemas` (`cross-twin/contract.ts`) and imported by **both**
UC2 and UC3 — the proof point for cross-domain interdependency. CGO-2 emits a
`DeferredArrivalWindow` (UC2→UC3) when a customs-flag surge is predicted to spike
a gate queue; UC3 can reply with a `DpdReleaseNotice` (UC3→UC2). See the schema
for the exact fields.
