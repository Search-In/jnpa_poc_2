/**
 * The single typed data adapter the UI binds to (prompt §5). MockAdapter and
 * LiveAdapter implement THIS interface; nothing in apps/web ever calls a model
 * or an external API directly. Selected by DATA_MODE=mock|live.
 */
import type {
  Container,
  EmptyPool,
  GateTransaction,
  ITRHOMovement,
  IntegrationHealth,
  KpiResult,
  Notification,
  Rake,
  Role,
  ScanEvent,
  ShippingDocType,
  SidingId,
  Wagon,
  Facility,
  Terminal,
} from '@jnpa/schemas';

// ---- filter / window DTOs --------------------------------------------------

/** Live AIS vessel position as returned by GET /api/marine/vessels/live. */
export interface LiveVesselDTO {
  mmsi: string;
  vessel_name: string;
  imo_no?: string | null;
  lat: number;
  lon: number;
  speed_knots: number;
  course: number;
  heading?: number | null;
  ship_type_code: number;
  ship_type_label: string;
  destination?: string | null;
  flag?: string | null;
  length?: number | null;
  elapsed_seconds?: number | null;
}

export interface TimeWindow {
  /** ISO start (inclusive). */
  from: string;
  /** ISO end (exclusive). */
  to: string;

}

export interface ContainerMovementFilter {
  originStream?: Container['originStream'];
  terminalId?: string;
  facilityId?: string;
  status?: Container['status'];
  /** Restrict to a role's scope (row-level). */
  role?: Role;
  window?: TimeWindow;
  // ---- POC-3 shared Cargo API filters (GET /api/cargo query params) ---------
  // These map 1:1 to the POC-3 gateway's query parameters. MockAdapter honours
  // `containerNo` (exact match) for parity; the rest are POC-3-only and ignored
  // by the mock/sim path (which has no customs/release projection).
  /** Exact ISO-6346 container number. Drives Container Search → GET /api/cargo/{id}. */
  containerNo?: string;
  /** Customs clearance status filter (POC-3 `customs_status`). */
  customsStatus?: CargoCustomsStatus;
  /** Yard block filter (POC-3 `yard_block`). */
  yardBlock?: string;
  /** Released-from-port filter (POC-3 `is_released`). */
  isReleased?: boolean;
  /** Allocated haulage plate filter (POC-3 `vehicle_number`). */
  vehicleNumber?: string;
  /** Page size (POC-3 `limit`, 1–1000, default 100). */
  limit?: number;
  /** Page offset (POC-3 `offset`, ≥0, default 0). */
  offset?: number;
}

/** Customs clearance status served by the POC-3 shared Cargo API. */
export type CargoCustomsStatus = 'PENDING' | 'CLEARED' | 'HELD' | 'UNDER_INSPECTION';

/** e-Seal reader status served by the POC-3 shared Cargo API (latest deployment). */
export type CargoEsealStatus = 'ACTIVE' | 'ARMED' | 'TAMPERED' | 'REMOVED' | 'NONE';

/** Pre-document processing status served by the POC-3 shared Cargo API (latest deployment). */
export type CargoPreDocStatus = 'NOT_STARTED' | 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';

/**
 * Request body for `POST /api/cargo` (POC-3 `CargoCreate`). Only
 * `container_number` is required; every other field defaults on the backend
 * (customs_status→PENDING, is_released→false, the rest→null). Timestamps
 * (`created_at`/`updated_at`) are server-assigned and never sent.
 */
export interface CargoCreateInput {
  container_number: string;
  vessel_name?: string | null;
  customs_status?: CargoCustomsStatus;
  yard_block?: string | null;
  is_released?: boolean;
  vehicle_number?: string | null;
  gate?: string | null;
  camera_id?: string | null;
  eta?: string | null;
}

/** The mutable subset of a cargo record accepted by `PUT /api/cargo/{id}`
 * (POC-3 `CargoUpdate`). All fields optional — only the provided ones are
 * written. The PK (container_number) is immutable and comes from the path. */
export type CargoUpdateInput = Partial<Omit<CargoCreateInput, 'container_number'>>;

/**
 * The raw shared Cargo record as served by the POC-3 gateway (`CargoOut`,
 * `GET /api/cargo`). This is the single source of truth for cargo — POC-2 keeps
 * no cargo store of its own. Field names mirror the API (snake_case) so the
 * payload maps with zero transformation; the adapter derives the canonical
 * {@link ContainerMovementDTO} view from it for the existing UI.
 */
export interface CargoRecord {
  /** ISO-6346 container number (primary key). */
  container_number: string;
  vessel_name?: string | null;
  customs_status: CargoCustomsStatus;
  yard_block?: string | null;
  is_released: boolean;
  vehicle_number?: string | null;
  gate?: string | null;
  camera_id?: string | null;
  /** ISO-8601 timestamp (estimated time of arrival). */
  eta?: string | null;
  // ---- fields added by the latest POC-3 deployment (may be null when unset) ----
  /** e-Seal reader status. */
  eseal_status?: CargoEsealStatus | null;
  /** e-Seal device/tag number (surfaced in the Scan tab's e-Seal column). */
  eseal_number?: string | null;
  /** Pre-document processing status (surfaced in the Scan tab's Pre-doc column). */
  pre_document_status?: CargoPreDocStatus | null;
  /** Origin stream (surfaced in the Movements tab's Stream column). */
  origin_stream?: string | null;
  created_at: string;
  updated_at: string;
}

// ---- result DTOs -----------------------------------------------------------

export interface ContainerMovementDTO {
  container: Container;
  /** Latest known location + status, derived from the event fold. */
  lastEventType: string;
  lastEventTs: string;
  facilityId: string;
  /** Full ordered event trail for drill-down. */
  trail: Array<{ eventType: string; ts: string; facilityId: string; sourceSystem: string }>;
  /**
   * The raw POC-3 shared Cargo record this DTO was derived from, present ONLY
   * when the row is sourced from the POC-3 Cargo API (undefined in mock/sim
   * mode). Carries the cargo-native fields (vessel, customs, yard, release,
   * vehicle, gate, camera, ETA) the mock projection does not have, so the Cargo
   * panel can render them straight from the single source of truth.
   */
  cargo?: CargoRecord;
}

export interface GateOpsDTO {
  gateId: string;
  terminalId: string;
  /** Live queue length (vehicles waiting). */
  queueLength: number;
  /** Transactions in the window. */
  transactions: GateTransaction[];
  /** Avg transaction time (min) in the window. */
  avgTxnTimeMin: number;
}

export interface GateQueueForecastDTO {
  gateId: string;
  generatedTs: string;
  /** 30–120 min ahead, per-step queue length. */
  curve: Array<{ ts: string; predictedQueue: number }>;
  recommendedDeferralWindows: Array<{ from: string; to: string; reason: string }>;
}

export interface PendencyDTO {
  facilityId: string;
  facilityType: Facility['type'];
  facilityName: string;
  pendency: number;
  geom: Facility['geom'];
  /**
   * Predominant shipping-doc type (IAL/EAL/DO) handled at this facility, derived
   * from the shipping documents of its containers. Drives the panel's doc-type
   * filter (the facility analogue of EmptyPoolDTO.primaryDocByLine).
   */
  primaryDoc?: ShippingDocType;
}

export interface RailSideDTO {
  siding: SidingId;
  rakes: Rake[];
  wagons: Wagon[];
}

export interface RakeForecastDTO {
  rakeId: string;
  etaPlacement?: string;
  etaRemoval?: string;
  etaDeparture?: string;
}

export interface EmptyPoolDTO {
  pools: EmptyPool[];
  /**
   * The predominant shipping-document type (IAL/EAL/DO) per line code, derived
   * from the shipping documents on the same lineId. Drives the panel's doc-type
   * filter so it scopes empty-pool rows to the lines led by that document type.
   */
  primaryDocByLine?: Record<string, ShippingDocType>;
}

export interface ScenarioParams {
  [key: string]: unknown;
}

export interface ScenarioResultDTO {
  scenarioId: string;
  seed: number;
  /** KPI values before and after the scenario, for the delta panel. */
  before: KpiResult[];
  after: KpiResult[];
  /** Human-readable automated actions fired (notifications, recommendations, cross-twin pushes). */
  actions: Array<{ kind: string; detail: string; target?: string }>;
  /** Optional spatial overlay payload for the map (reroute lines, recoloured flows). */
  mapOverlay?: unknown;
}

// ---- POC-3 extended Cargo APIs (Jayesh handover — additive integration) -----
//
// These map 1:1 to the newly-deployed POC-3 Cargo endpoints. POC-3 remains the
// single owner of all cargo business logic; POC-2 only consumes them. The shapes
// mirror the handover's field descriptions and the 0016–0018 migrations; response
// types keep every field optional so the adapter degrades gracefully if the
// backend omits or renames a field (the same faithful/defensive posture the base
// cargo mapper uses). Exact request/response schemas are owned by POC-3.

/** Severity for a stakeholder notification (POC-3 `POST /api/cargo/notifications`). */
export type CargoNotificationSeverity = 'INFO' | 'WARN' | 'CRIT';

/** Request body for `POST /api/cargo/notifications` — raise a stakeholder notification. */
export interface CargoNotificationCreateInput {
  /** Human title/subject. */
  title?: string;
  /** Notification body. */
  message: string;
  /** INFO | WARN | CRIT. */
  severity?: CargoNotificationSeverity;
  /** Stakeholder audience (roles/parties) to notify. */
  stakeholders?: string[];
  /** Container context, when the notification is about one box. */
  container_number?: string | null;
  /** Free-text category/type (e.g. GATE_IN, CUSTOMS_FLAG). */
  type?: string;
  /** Lifecycle status (e.g. OPEN). Backend defaults when omitted. */
  status?: string;
}

/** One stakeholder notification as served by `GET /api/cargo/notifications`. */
export interface CargoNotification {
  id?: string | number;
  title?: string | null;
  message?: string | null;
  severity?: CargoNotificationSeverity | null;
  stakeholders?: string[] | null;
  status?: string | null;
  container_number?: string | null;
  type?: string | null;
  created_at?: string | null;
}

/** Query filters for `GET /api/cargo/notifications`. */
export interface CargoNotificationFilter {
  severity?: string;
  status?: string;
  stakeholder?: string;
  container_number?: string;
  limit?: number;
  offset?: number;
}

/** Workflow transition requested by `POST /api/cargo/{container_number}/workflow`. */
export type CargoWorkflowAction = 'TRIGGER' | 'APPROVE' | 'REJECT';

/** Request body for `POST /api/cargo/{container_number}/workflow`. */
export interface CargoWorkflowActionInput {
  action: CargoWorkflowAction;
  /** Which workflow is being driven (e.g. RELEASE_APPROVAL). Optional per backend. */
  workflow_type?: string;
  /** Operator note recorded on the transition. */
  note?: string;
  /** Actor performing the transition (falls back to the token subject on the backend). */
  actor?: string;
}

/** Current workflow state returned by the workflow POST / read. */
export interface CargoWorkflowState {
  container_number?: string;
  status?: string | null;
  workflow_type?: string | null;
  updated_at?: string | null;
}

/** One append-only entry from `GET /api/cargo/{container_number}/workflow/history`. */
export interface CargoWorkflowHistoryEntry {
  id?: string | number;
  container_number?: string;
  action?: string | null;
  status?: string | null;
  actor?: string | null;
  note?: string | null;
  created_at?: string | null;
}

/** Request body for `POST /api/cargo/yard-planning` — allocate a planned yard position.
 *  The deployed POC-3 backend requires `preferred_block` (verified from the API's
 *  422 "Field required: preferred_block" response), NOT `yard_block`. This is the
 *  yard-planning REQUEST contract only; the yard-assignment / cargo-update APIs
 *  continue to use `yard_block` and are unchanged. */
export interface YardPlanningInput {
  container_number: string;
  /** Preferred yard block for the planned position (POC-3 `preferred_block`). */
  preferred_block?: string;
  slot?: string;
  priority?: number;
}

/** Result of a yard-planning allocation. */
export interface YardPlanningResult {
  container_number?: string;
  yard_block?: string | null;
  slot?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/** `GET /api/cargo/yard-optimization` — congestion, priority containers, suggested moves. */
export interface YardOptimization {
  congestion?: Array<{ yard_block?: string; utilization?: number; level?: string }> | null;
  priority_containers?: Array<{ container_number?: string; reason?: string }> | null;
  suggested_moves?: Array<{ container_number?: string; from?: string; to?: string; reason?: string }> | null;
}

/** Request body for `POST /api/cargo/rake-planning` — create a rake plan. */
export interface RakePlanInput {
  rake_id: string;
  siding?: string;
  container_numbers?: string[];
  /** ISO-8601 planned placement time. */
  planned_placement?: string;
  /** ISO-8601 planned departure time. */
  planned_departure?: string;
}

/** One rake plan as served by `GET /api/cargo/rake-planning`. */
export interface RakePlan {
  id?: string | number;
  rake_id?: string;
  siding?: string | null;
  container_numbers?: string[] | null;
  planned_placement?: string | null;
  planned_departure?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/** Request body for `POST /api/cargo/reefer-planning` — allocate a reefer slot. */
export interface ReeferPlanInput {
  container_number: string;
  /** Set-point temperature (°C). */
  temperature_c?: number;
  /** Power requirement (kW). */
  power_kw?: number;
  slot?: string;
}

/** One reefer allocation as returned by the reefer-planning API. */
export interface ReeferPlan {
  id?: string | number;
  container_number?: string;
  temperature_c?: number | null;
  power_kw?: number | null;
  slot?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/** One cargo lifecycle event from `GET /api/cargo/events` (cargo.created, cargo.gate_in, …). */
export interface CargoLifecycleEvent {
  id?: string | number;
  event_type?: string | null;
  container_number?: string | null;
  payload?: unknown;
  created_at?: string | null;
}

// ---- IGM (Import General Manifest, ICEGATE CHPOI03) ------------------------
//
// The first step of the import container lifecycle: the shipping line files an
// IGM before the vessel arrives, declaring every cargo line and every container
// on board. Sourced from the POC-3 customs layer (`GET /api/customs/igm` and
// `/api/customs/igm/{igm_no}/containers`), which holds the manifests parsed from
// the official ICEGATE CHPOI03 XML files. Field names mirror the API response
// verbatim — this layer renames nothing.

/** One filed import manifest (vessel-level header) from `GET /api/customs/igm`. */
export interface IgmManifest {
  /** Manifest number, e.g. 1194313. Numeric in the API; the natural key. */
  igm_no: number | string;
  /** Date the manifest was filed (ISO date). */
  igm_date?: string | null;
  /** Customs house code, e.g. INNSA1 (JNPT). */
  customs_house_code?: string | null;
  /** Vessel IMO number, e.g. 9523017. */
  imo_code?: string | null;
  /** Vessel call sign / code, e.g. BPKG. */
  vessel_code?: string | null;
  voyage_no?: string | null;
  vessel_type?: string | null;
  master_name?: string | null;
  /** Shipping line code, e.g. CHZ. */
  shipping_line_code?: string | null;
  /** Shipping agent PAN, e.g. AABCC9418Q. */
  shipping_agent_code?: string | null;
  port_of_arrival?: string | null;
  brief_cargo_desc?: string | null;
  /** Terminal operator the vessel calls at, e.g. INNSA1NSI1 (NSICT). */
  terminal_operator_code?: string | null;
  /** Numeric on the wire but serialised as a decimal STRING (e.g. "475221.00"). */
  lighthouse_dues?: number | string | null;
  /** Line count declared on the manifest header (may differ from line_count). */
  total_no_of_lines?: number | null;
  /** Expected time of arrival (ISO timestamp). */
  expected_arrival?: string | null;
  /** Entry-inward granted timestamp (ISO); null until customs grants it. */
  entry_inward?: string | null;
  /** Cargo lines actually present for this manifest. */
  line_count?: number | null;
  /** Containers actually declared across those lines. */
  container_count?: number | null;
}

/**
 * One container declared on an IGM, from `GET /api/customs/igm/{igm_no}/containers`.
 * The container-level fields come from the manifest's container block; the cargo-line
 * fields (BL, importer, POL/POD, goods) come from its parent line.
 */
export interface IgmContainer {
  igm_no: number | string;
  line_no?: number | null;
  subline_no?: number | null;
  /** ISO-6346 container number, e.g. DPWU9011100. */
  container_no: string;
  seal_no?: string | null;
  /** Container agent PAN, e.g. AAECP2527J. */
  container_agent_code?: string | null;
  /** FCL / LCL / EMPTY. */
  container_status?: string | null;
  no_of_packages?: number | null;
  /**
   * Container weight as declared on the container block. The API serialises
   * Postgres `numeric` as a decimal STRING (e.g. "1.350"), so consumers must
   * coerce before doing arithmetic or locale formatting.
   */
  container_weight?: number | string | null;
  /** ISO 6346 size-type code, e.g. 4210. */
  iso_size_type?: string | null;
  /** Shipper-owned container flag. */
  soc_flag?: boolean | null;
  // -- parent cargo line ----------------------------------------------------
  bl_no?: string | null;
  bl_date?: string | null;
  /** Port of loading, e.g. THLCH. */
  port_of_loading?: string | null;
  /** Port of destination, e.g. INNSA1. */
  port_of_destination?: string | null;
  importer_name?: string | null;
  nature_of_cargo?: string | null;
  cargo_movement?: string | null;
  /** Gross weight of the whole cargo line; a decimal STRING on the wire. */
  gross_weight?: number | string | null;
  unit_of_weight?: string | null;
  goods_description?: string | null;
  /** RMS flagged this line for scanning (SELECTED_SCAN=Y on the manifest). */
  selected_scan?: boolean | null;
  // -- RMS scanner assignment, present only when a scanning-division list
  //    actually selected this container --------------------------------------
  /** Scanner class: "D" (drive-through) or "M" (mobile). */
  machine_type?: string | null;
  /** Scanner site code, e.g. INNSA1RSDT01. Renders as "D-INNSA1RSDT01". */
  scan_location?: string | null;
  /** CFS/ICD recorded on the scan list. */
  scan_cfs_name?: string | null;
}

/** Filter for the IGM container listing. */
export interface IgmContainerFilter {
  limit?: number;
  offset?: number;
}

// ---- RMS (Risk Management System container scanning) -----------------------
//
// The scanning branch of the import lifecycle, which applies between discharge
// and delivery when Customs' Container Scanning Division selects a box. One
// scan list is issued per vessel/IGM; it either names the containers to scan or
// records that none were selected. Sourced from POC-3:
//   GET /api/customs/rms                      -> the scan lists
//   GET /api/customs/rms/{igm_no}/containers  -> the selected containers
//
// NOTE: the scan lists reference IGM numbers that are deliberately NOT among the
// filed manifests in this corpus, so an RMS selection never joins to an IGM
// container row. Treat the two as disjoint rather than assuming a broken link.

/** One RMS scan list (one vessel/IGM) from `GET /api/customs/rms`. */
export interface RmsScanList {
  /** Surrogate key of the scan report. */
  report_id?: number | null;
  /** IGM the scan list was issued against, e.g. 1194257. */
  igm_no: number | string;
  /** IGM year, e.g. 2026 (the .txt lists render it as "1194257/2026"). */
  igm_year?: number | null;
  vessel_name?: string | null;
  shipping_line?: string | null;
  /** Shipping agent PAN. */
  shipping_agent?: string | null;
  /** Date the scanning division finished processing the list. */
  processing_end_date?: string | null;
  /** Containers selected for scanning; 0 = "No container selected for scanning". */
  selected_count?: number | null;
  /** False when the list selected nothing — a real outcome, not missing data. */
  any_selected?: boolean | null;
}

/** One container selected for scanning, from `GET /api/customs/rms/{igm_no}/containers`. */
export interface RmsScanContainer {
  igm_no: number | string;
  igm_year?: number | null;
  vessel_name?: string | null;
  shipping_line?: string | null;
  shipping_agent?: string | null;
  processing_end_date?: string | null;
  /** Serial number within the scan list. */
  sl_no?: number | null;
  container_no: string;
  /** Scanner class: "D" (drive-through) or "M" (mobile). */
  machine_type?: string | null;
  /** Scanner site code, e.g. INNSA1RSDT01. Pairs with machine_type as "D-INNSA1RSDT01". */
  scan_location?: string | null;
  /** CFS/ICD the box is bound for. */
  cfs_name?: string | null;
  goods_description?: string | null;
}

// ---- the interface ---------------------------------------------------------

export interface DataAdapter {
  /** Static spatial backdrop. */
  getFacilities(role?: Role): Promise<Facility[]>;
  getTerminals(): Promise<Terminal[]>;

  // §5 methods
  getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]>;
  getGateOps(window: TimeWindow): Promise<GateOpsDTO[]>;
  getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO>;
  getPendency(byFacility?: boolean): Promise<PendencyDTO[]>;
  getRailSide(siding: SidingId, window: TimeWindow): Promise<RailSideDTO>;
  getRakeForecast(rakeId: string): Promise<RakeForecastDTO>;
  getITRHO(window: TimeWindow): Promise<ITRHOMovement[]>;
  getScanQueue(): Promise<ScanEvent[]>;
  getEmptyPool(): Promise<EmptyPoolDTO>;
  getKPIs(): Promise<KpiResult[]>;
  getNotifications(role: Role): Promise<Notification[]>;
  getIntegrationHealth(): Promise<IntegrationHealth[]>;
  runScenario(id: string, params: ScenarioParams): Promise<ScenarioResultDTO>;

  /**
   * Create a cargo record in the POC-3 shared backend (`POST /api/cargo` → 201).
   * Returns the newly created record projected into the canonical
   * {@link ContainerMovementDTO} via the same cargo mapper the reads use. A
   * duplicate container number surfaces as a 409 {@link CargoApiError}. Optional:
   * implemented only on the Poc3CargoAdapter path.
   */
  createCargo?(record: CargoCreateInput): Promise<ContainerMovementDTO>;

  /**
   * Write-through to the POC-3 shared Cargo resource: a partial or full update of
   * the EXISTING `/api/cargo/{container_number}` record via **`PUT`** (the backend
   * does not support PATCH — see gateway/routers/cargo.py). Only the provided
   * fields are written (POC-3 uses `exclude_unset`), so `{ yard_block }` on a
   * vessel discharge or `{ is_released: true }` on a gate release both work.
   * Returns the updated record as a {@link ContainerMovementDTO}. A missing
   * container surfaces as a 404 {@link CargoApiError}. Optional: implemented only
   * on the Poc3CargoAdapter path (undefined when cargo is served from the mock/sim).
   */
  updateCargo?(containerNo: string, patch: CargoUpdateInput): Promise<ContainerMovementDTO>;

  /**
   * Delete a cargo record from the POC-3 shared backend
   * (`DELETE /api/cargo/{container_number}` → 200). Resolves on success; a missing
   * container surfaces as a 404 {@link CargoApiError}. Optional: implemented only
   * on the Poc3CargoAdapter path.
   */
  deleteCargo?(containerNo: string): Promise<void>;

  // -- POC-3 extended Cargo APIs (Jayesh handover). All optional: implemented on
  //    the Poc3CargoAdapter path and delegated by SimAdapter; undefined when cargo
  //    is served from the mock/sim, so callers guard with `if (!adapter.x) …`. -----

  /** Raise a stakeholder notification (`POST /api/cargo/notifications`). */
  createCargoNotification?(input: CargoNotificationCreateInput): Promise<CargoNotification>;
  /** List stakeholder notifications (`GET /api/cargo/notifications`). */
  getCargoNotifications?(filter?: CargoNotificationFilter): Promise<CargoNotification[]>;

  /** Trigger / approve / reject a container's workflow (`POST /api/cargo/{id}/workflow`). */
  triggerCargoWorkflow?(containerNo: string, input: CargoWorkflowActionInput): Promise<CargoWorkflowState>;
  /** Append-only workflow history (`GET /api/cargo/{id}/workflow/history`). */
  getCargoWorkflowHistory?(containerNo: string): Promise<CargoWorkflowHistoryEntry[]>;

  /** Allocate a planned yard position (`POST /api/cargo/yard-planning`). */
  createYardPlan?(input: YardPlanningInput): Promise<YardPlanningResult>;
  /** Yard optimization snapshot (`GET /api/cargo/yard-optimization`). */
  getYardOptimization?(): Promise<YardOptimization>;

  /** Create a rake plan (`POST /api/cargo/rake-planning`). */
  createRakePlan?(input: RakePlanInput): Promise<RakePlan>;
  /** List rake plans (`GET /api/cargo/rake-planning`). */
  getRakePlans?(): Promise<RakePlan[]>;

  /** Allocate a reefer slot with temperature/power requirements (`POST /api/cargo/reefer-planning`). */
  createReeferPlan?(input: ReeferPlanInput): Promise<ReeferPlan>;

  /** Cargo lifecycle events (`GET /api/cargo/events`), optionally scoped to one container. */
  getCargoEvents?(containerNo?: string): Promise<CargoLifecycleEvent[]>;

  /**
   * NLDS Logistics Data Bank inland-transit track for one container
   * (`GET /api/ldb/container/search?cntrNo=&searchType=39`). Optional — wired
   * when an LDB base URL / Vite `/ldb` proxy is configured.
   */
  getNldsContainerTrack?(containerNo: string): Promise<import('./ldb-track.js').NldsContainerTrack>;

  /** Live AIS vessel data from the marine API (`GET /api/marine/vessels/live`). Optional: implemented only on the Poc3CargoAdapter path. */
  getLiveVessels?(): Promise<LiveVesselDTO[]>;

  /** Filed import manifests (`GET /api/customs/igm`). Optional: POC-3 path only. */
  getIgmManifests?(filter?: IgmContainerFilter): Promise<IgmManifest[]>;
  /** Containers declared on one manifest (`GET /api/customs/igm/{igm_no}/containers`). Optional: POC-3 path only. */
  getIgmContainers?(igmNo: string | number, filter?: IgmContainerFilter): Promise<IgmContainer[]>;

  /** RMS container-scanning selection lists (`GET /api/customs/rms`). Optional: POC-3 path only. */
  getRmsScanLists?(filter?: IgmContainerFilter): Promise<RmsScanList[]>;
  /** Containers selected for scanning on one list (`GET /api/customs/rms/{igm_no}/containers`). Optional: POC-3 path only. */
  getRmsScanContainers?(igmNo: string | number, filter?: IgmContainerFilter): Promise<RmsScanContainer[]>;

  /** Which mode this adapter is operating in (for the UI badge). */
  readonly mode: 'mock' | 'live';
}
