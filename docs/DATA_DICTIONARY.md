# Data Dictionary — JNPA UC2 Canonical Model

> Tender **GEM/2026/B/7297343** · Appendix C §2.3 · Bid §8.4
> Source of truth: [`packages/schemas/src/entities`](../packages/schemas/src/entities).
> Conventions: container numbers **ISO 6346** (with valid check digit); ISO type
> codes **ISO 6346** size/type; all timestamps **UTC ISO-8601** with the source
> system's local offset preserved (`sourceOffsetMin`). Geometry is GeoJSON in
> **EPSG:4326** `[lng, lat]`.

This dictionary is generated from, and kept 1:1 with, the TypeScript types, the
JSON-Schema definitions ([`json-schema/schemas.ts`](../packages/schemas/src/json-schema/schemas.ts))
and the Postgres DDL ([`ddl/001_canonical.sql`](../packages/schemas/src/ddl/001_canonical.sql)).

---

## Conventions & shared primitives

| Type | Definition |
|---|---|
| `IsoUtc` | UTC ISO-8601 instant string, e.g. `2026-06-17T02:45:00.000Z` |
| `UtcOffsetMinutes` | Source-system local offset (minutes east of UTC); IST = `330` |
| `ContainerNo` | ISO 6346 number `^[A-Z]{3}[UJZ]\d{6}\d$` with valid check digit |
| `IsoTypeCode` | ISO 6346 size/type code, e.g. `22G1`, `45R1` |
| `RawRef` | Object-store key (MinIO/S3) of the raw native payload, for audit |
| `Geometry` | GeoJSON `Point` or `Polygon`, EPSG:4326 |

---

## Container — physical unit of cargo

| Field | Type | Req | Notes |
|---|---|---|---|
| `containerNo` | ContainerNo | ✓ | Natural key (ISO 6346) |
| `isoTypeCode` | IsoTypeCode | ✓ | e.g. `22G1` |
| `sizeFt` | `20 \| 40 \| 45` | ✓ | |
| `laden` | boolean | ✓ | true = carrying cargo |
| `grossWtKg` | number | ✓ | kilograms |
| `cargoType` | string | ✓ | coded/free-text description |
| `hazmatIMDG` | `{ imdgClass, unNo?, packingGroup? }` | – | present only if dangerous goods |
| `reefer` | `{ setpointC, currentC }` | – | present only if reefer |
| `lineOwner` | string | ✓ | shipping-line code, e.g. `MAEU` |
| `currentSealNo` | string | ✓ | updated by `ESEAL_AFFIX` events |
| `status` | ContainerStatus | ✓ | see enum below |
| `originStream` | OriginStream | ✓ | see enum below |
| `lastUpdatedTs` | IsoUtc | ✓ | last projection change |

**ContainerStatus**: `EXPECTED · GATE_IN · IN_YARD · RAIL_IN · RAIL_OUT · UNDER_SCAN · HELD_CUSTOMS · STUFFING · DESTUFFING · ITRHO_IN_TRANSIT · GATE_OUT · DEPARTED`

**OriginStream**: `IMPORT_CFS · IMPORT_ICD · IMPORT_DPD · EXPORT_CFS · EXPORT_ICD · EXPORT_DPE · TRANSSHIP`

---

## CargoEvent — the event-sourced spine

All entity projections are derived by folding the ordered `CargoEvent` stream.

| Field | Type | Req | Notes |
|---|---|---|---|
| `eventId` | string | ✓ | globally unique (deterministic for idempotent re-map) |
| `containerNo` | ContainerNo | ✓ | |
| `eventType` | EventType | ✓ | closed enum (below) |
| `ts` | IsoUtc | ✓ | when it happened |
| `sourceOffsetMin` | UtcOffsetMinutes | ✓ | preserved source offset |
| `facilityId` | string | ✓ | FK → Facility |
| `terminalId` | string | – | when facility maps to a terminal |
| `gateId` | string | – | gate events |
| `vehicleNo` | string | – | road moves |
| `rakeId` | string | – | rail events |
| `sourceSystem` | SourceSystem | ✓ | `ULIP·ICEGATE·TOS·FOIS·ESEAL·SHIPLINE·SIM` |
| `rawRef` | RawRef | ✓ | raw native payload key (audit) |
| `payload` | object (jsonb) | ✓ | normalised native fields |

**EventType** (closed — mappers must not invent): `GATE_IN · GATE_OUT · RAIL_IN · RAIL_OUT · YARD_MOVE · SCAN_START · SCAN_END · LEO · STUFFING · DESTUFFING · ITRHO_OUT · ITRHO_IN · DAMAGE_FLAG · CUSTOMS_FLAG · ESEAL_AFFIX · ESEAL_BREAK`

---

## GateTransaction — drives gate-transaction-time + trailer TAT

| Field | Type | Req | Notes |
|---|---|---|---|
| `gateTxnId` | string | ✓ | |
| `gateId` | string | ✓ | |
| `direction` | `IN \| OUT` | ✓ | |
| `vehicleNo` | string | ✓ | |
| `containerNo` | ContainerNo | – | |
| `appointmentRef` | string | – | links to UC3 trucking slot |
| `arrivalTs` | IsoUtc | ✓ | reached gate queue |
| `startTs` | IsoUtc | ✓ | processing began |
| `endTs` | IsoUtc | – | processing ended |
| `docsVerified` | string[] | ✓ | e.g. `["FORM13","DO","ESEAL"]` |
| `outcome` | `CLEARED \| HELD \| REJECTED` | ✓ | |

---

## Facility — any node in the cargo network

| Field | Type | Req | Notes |
|---|---|---|---|
| `facilityId` | string | ✓ | |
| `type` | FacilityType | ✓ | `TERMINAL·CFS·ICD·DPE·DPD·ECD·CPP·RAIL_SIDING` |
| `name` | string | ✓ | |
| `operator` | string | ✓ | |
| `geom` | Geometry | ✓ | point/polygon EPSG:4326 |
| `capacityTEU` | number | – | |
| `currentPendency` | number | ✓ | live count awaiting next move |

---

## Terminal — config-driven (`config/terminals.json`)

| Field | Type | Req | Notes |
|---|---|---|---|
| `terminalId` | string | ✓ | e.g. `NSICT` |
| `name` / `operator` | string | ✓ | **confirm operators before live** |
| `status` | `OPERATING\|TRANSITION\|CLOSED` | ✓ | |
| `geom` | Geometry | ✓ | |
| `quayLengthM` / `capacityTEU` | number | – | |
| `gates` | string[] | ✓ | gate ids |
| `sidings` | `('T1'\|'T2')[]` | ✓ | rail siding mapping |
| `tos` | `{ mode, ediVersion?, url?, dropDir? }` | ✓ | polyglot access mode |

`tos.mode`: `EDIFACT · X12 · REST · FILE_DROP`.

---

## Rake + Wagon — drive Rake TAT + Mixed-Train Optimization

**Rake**

| Field | Type | Req | Notes |
|---|---|---|---|
| `rakeId` | string | ✓ | |
| `ctoOperator` | string | ✓ | CONCOR / private CTO |
| `trainNo` | string | ✓ | |
| `foisRef` | string | ✓ | FOIS reference |
| `sidingId` | `T1 \| T2` | ✓ | |
| `terminalId` | string | ✓ | |
| `arrivalTs` | IsoUtc | ✓ | |
| `placementTs` | IsoUtc | – | placed on siding |
| `removalTs` | IsoUtc | – | removed from siding |
| `departureTs` | IsoUtc | – | departed yard |
| `wagonCount` | number | ✓ | |
| `direction` | `INBOUND \| OUTBOUND` | ✓ | |
| `mixedFlag` | boolean | ✓ | mixed-terminal containers |

**Wagon**: `wagonId`, `rakeId`, `position` (1-based), `containerNos[]`.

---

## ITRHOMovement — Inter-Terminal TAT + Transshipment Trailer TAT

| Field | Type | Req | Notes |
|---|---|---|---|
| `itrhoId` | string | ✓ | |
| `containerNo` | ContainerNo | ✓ | |
| `fromTerminalId` / `toTerminalId` | string | ✓ | |
| `requestedTs` | IsoUtc | ✓ | |
| `outTs` | IsoUtc | – | handed out of origin |
| `inTs` | IsoUtc | – | received at destination |
| `mode` | `RAIL \| ROAD` | ✓ | |

---

## ScanEvent — drives Scanner TAT

| Field | Type | Req | Notes |
|---|---|---|---|
| `scanId` | string | ✓ | |
| `containerNo` | ContainerNo | ✓ | |
| `scannerId` | string | ✓ | |
| `flaggedBy` | `CUSTOMS \| RANDOM` | ✓ | |
| `startTs` | IsoUtc | ✓ | queue-in (start of TAT) |
| `endTs` | IsoUtc | – | cleared |
| `result` | `CLEAR \| HOLD \| EXAM` | – | |

---

## ShippingDoc · EmptyPool

**ShippingDoc**: `docId`, `type` (`IAL·EAL·DO·BE·SB·FORM13`), `containerNos[]`, `lineId`, `issuedTs`, `payload`.

**EmptyPool**: `lineId`, `depotId` (ECD facility), `availableQty`, `projectedDemandQty`, `asOfTs`.

---

## Notification — event → fan-out (§11)

| Field | Type | Req | Notes |
|---|---|---|---|
| `notifId` | string | ✓ | |
| `type` | NotificationType | ✓ | see enum |
| `severity` | `INFO \| WARN \| CRIT` | ✓ | |
| `audienceRoles` | Role[] | ✓ | RBAC roles (§9) |
| `facilityId` | string | – | scoping |
| `containerNo` | ContainerNo | – | |
| `body` | `{ en, hi, mr }` | ✓ | multilingual (§1 i18n) |
| `createdTs` | IsoUtc | ✓ | |
| `ackBy` / `ackTs` | string / IsoUtc | – | acknowledgement |

**NotificationType**: `GATE_IN · GATE_OUT · SPECIAL_INSTRUCTION · CUSTOMS_SCANNER_FLAG · DAMAGE_ASSESSMENT · CONTAINER_PENDENCY · GATE_QUEUE_STATUS · ANOMALY_MISSING_GATE_OUT · ANOMALY_LEO_NO_MOVE · ANOMALY_SCAN_FLAG_NO_SCAN · ANOMALY_SEQUENCE`

---

## IntegrationHealth — per-source Health Card (§6)

| Field | Type | Req | Notes |
|---|---|---|---|
| `sourceSystem` | SourceSystem | ✓ | |
| `lastGoodPollTs` | IsoUtc | – | last successful live poll |
| `errorCount` | number | ✓ | |
| `degradation` | `GREEN \| AMBER \| RED` | ✓ | |
| `mode` | `LIVE \| CACHED \| SYNTHETIC` | ✓ | active fallback tier |
| `note` | string | – | Operator Banner text |

---

## RBAC roles (§9)

`JNPA_MARINE · JNPA_TRAFFIC · TERMINAL_OPS · CFS_OPERATOR · ICD_OPERATOR · CTO_RAIL · CUSTOMS · SHIPPING_LINE · DTCCC_ADMIN`

Port-wide (unscoped) read: `JNPA_MARINE, JNPA_TRAFFIC, CUSTOMS, DTCCC_ADMIN`.
Facility-scoped (row-level): `TERMINAL_OPS, CFS_OPERATOR, ICD_OPERATOR, CTO_RAIL, SHIPPING_LINE`.

---

## Mapper coverage (native format → canonical)

| Native | Format | Mapper | Produces |
|---|---|---|---|
| UN/EDIFACT | CODECO | `mapCodeco` | `GATE_IN/OUT`, `ESEAL_AFFIX`, `DAMAGE_FLAG`; seal→`currentSealNo`, TDT→road/rail |
| UN/EDIFACT | COARRI | `mapCoarri` | `YARD_MOVE` (discharge/load on payload) |
| UN/EDIFACT | COPRAR | `mapCoprar` | order projection (expected work) |
| UN/EDIFACT | BAPLIE | `mapBaplie` | stowage positions |
| UN/EDIFACT | IFTSTA | `mapIftsta` | status → `GATE_*`/`RAIL_*`/`YARD_MOVE` |
| ANSI X12 | 322 | `map322` | terminal/ramp activity → `GATE_*`/`RAIL_*`/`YARD_MOVE` |
| ANSI X12 | 315 | `map315` | ocean status → events |
| ANSI X12 | 304 | `map304` | shipping-instruction projection |
| ICES 1.5 | CHSAI GATEPASS/TALLY/LEO/STUFFING/ESEAL/BE_FLAGS | `mapIcesChsai` | `GATE_*`/`YARD_MOVE`/`LEO`/`STUFFING`/`ESEAL_*`/`CUSTOMS_FLAG` (DPD-ready, selected-for-scan) |
| ULIP REST | container track/trace | `mapUlipContainerTrack` | milestone → events |
| ULIP/FOIS REST | rail track/trace | `mapUlipFoisRake` | canonical `Rake` |
| ULIP REST | Vahan | `mapUlipVahan` | vehicle compliance projection |
| RFID | e-seal read | `mapESealRead` | `ESEAL_AFFIX` / `ESEAL_BREAK` |

Every mapper returns `{ data, rawRef, warnings }` and preserves the raw payload
key (`rawRef`) for audit (IPR/handover clause, §4).
