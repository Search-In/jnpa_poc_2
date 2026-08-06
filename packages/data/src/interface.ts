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
  /**
   * Position in the forward-only UC-II lifecycle:
   * `CREATED → VESSEL_DISCHARGED → YARD_ASSIGNED → VERIFIED → RELEASED`
   * (plus optional planning states, and the export-leg states from migration 0115).
   *
   * The UI gates its lifecycle ACTIONS on this — a transition is only offered from a
   * state it is legal from, so the server's 409 becomes a button that isn't shown
   * rather than an error the operator has to read.
   */
  lifecycle_status?: string | null;
  /**
   * Which leg this container is on: `IMPORT` | `EXPORT` | `TRANSHIPMENT`.
   *
   * The two legs run DIFFERENT state machines off the same `lifecycle_status`
   * column — import goes `… → VESSEL_DISCHARGED → YARD_ASSIGNED → … → RELEASED`,
   * export goes `… → EXPORT_BOOKED → … → VESSEL_LOADED`. Both start at `CREATED`,
   * so status alone cannot tell you which transitions are meaningful; the UI must
   * read direction as well before offering a leg-specific action.
   */
  direction?: string | null;
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
  /**
   * IMDG hazard class as declared on the manifest line, e.g. "3", "8", "5.1".
   * **218** of the 4,276 manifest lines carry a real class; the rest declare the
   * sentinel `ZZZ` ("none"), which the backend normalises to NULL.
   *
   * Null/blank means the line was not declared hazardous — it does NOT mean
   * "unknown", so absence must render as ordinary cargo, never as a warning.
   * Treat `ZZZ` as absent too: a backend that has not yet picked up the
   * normalisation will still send it. Drives the WS1 EC-4 hazardous flow.
   */
  imdg_class?: string | null;
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

// ---- OOC (Out-Of-Charge / Bill of Entry, ICEGATE CHPOI10) ------------------
//
// Customs clearance: the Bill of Entry and the out-of-charge grant that releases
// the cargo. Sourced from POC-3:
//   GET /api/customs/ooc              -> the Bills of Entry
//   GET /api/customs/ooc/{be}/items   -> one BE + its containers + invoice items

/** One Bill of Entry with its out-of-charge grant, from `GET /api/customs/ooc`. */
export interface OocRecord {
  /** Bill of Entry number, e.g. 9259230. */
  bill_of_entry_no: number | string;
  bill_of_entry_date?: string | null;
  document_type?: string | null;
  igm_no?: number | string | null;
  line_no?: number | null;
  subline_no?: number | null;
  /** Out-of-charge number, e.g. 2071217438 — the customs release. */
  out_of_charge_no?: string | null;
  out_of_charge_date?: string | null;
  importer_name?: string | null;
  /** Importer Exporter Code. */
  ie_code?: string | null;
  /** Customs House Agent code. */
  cha_code?: string | null;
  country_of_origin?: string | null;
  no_of_packages?: number | null;
  /** Decimal STRING on the wire (Postgres numeric). */
  quantity_out_of_charged?: number | string | null;
  unit_of_quantity?: string | null;
  assessable_value?: number | string | null;
  cif_value?: number | string | null;
  total_customs_duty?: number | string | null;
  /** Distinct containers covered by this BE. */
  container_count?: number | null;
}

/** One invoice line item on a Bill of Entry. */
export interface OocInvoiceItem {
  container_no?: string | null;
  invoice_number?: string | null;
  item_sr_no?: number | null;
  /** Goods description, e.g. "STANTEX S 7645(424359)". */
  item_description?: string | null;
  /** HS classification, e.g. 34039100. */
  hs_classification?: string | null;
  cif_value?: number | string | null;
  assessable_value?: number | string | null;
}

/** Full view of one BE from `GET /api/customs/ooc/{be_no}/items`. */
export interface OocDetail {
  bill_of_entry_no: number | string;
  /** BE + out-of-charge header. Additional importer/address fields beyond OocRecord. */
  ooc?: (OocRecord & {
    importer_address?: string | null;
    importer_city?: string | null;
    pin_code?: string | null;
    nature_of_cargo?: string | null;
  }) | null;
  /** Containers this BE covers. */
  containers?: string[];
  items?: OocInvoiceItem[];
}

// ---- E-DO (Electronic Delivery Order, AGDORD) ------------------------------
//
// The shipping line's authority to release the container to the consignee, filed
// after customs clearance and before the box leaves on a truck. Sourced from
// POC-3:
//   GET /api/shipping-lines/edo             -> the delivery orders
//   GET /api/shipping-lines/edo/{do_number} -> one DO + its container lines

/** One Electronic Delivery Order (header level). */
export interface EdoRecord {
  /** Delivery order number, e.g. 120260611441759. */
  do_number: string;
  do_date?: string | null;
  /** Last day the DO is valid for pickup. */
  valid_upto?: string | null;
  /** Vessel call number, e.g. INNSA1GT0S0554. */
  vcn?: string | null;
  imo_no?: string | null;
  voyage_no?: string | null;
  /** IGM the DO cites — the link back to the filed manifest. */
  igm_no?: number | string | null;
  igm_date?: string | null;
  /** Issuing agency, e.g. "EMIRATES SHIPPING LINE (ESA1)". */
  agency_name?: string | null;
  /** Terminal holding the box, e.g. INNSA1GTI1. */
  custodian_code?: string | null;
  delivery_type?: string | null;
  notify_email?: string | null;
  total_weight?: number | string | null;
  weight_unit?: string | null;
  /** Containers on the DO. */
  container_count?: number | null;
  /**
   * True when at least one container on this DO also appears on a filed IGM.
   * The only cross-document join that resolves in the current corpus.
   */
  manifest_linked?: boolean | null;
}

/** One container line on a delivery order. */
export interface EdoLine {
  line_no?: number | null;
  container_no?: string | null;
  seal_no?: string | null;
  iso_code?: string | null;
  bl_no?: string | null;
  bl_date?: string | null;
  consignee_name?: string | null;
  consignee_addr?: string | null;
  cargo_desc?: string | null;
  packages?: number | null;
  package_code?: string | null;
  gross_weight?: number | string | null;
  pol?: string | null;
  pod?: string | null;
  return_empty_by?: string | null;
  /** IGM line the DO itself cites. */
  igm_line_no?: number | null;
  igm_subline_no?: number | null;
  /** Set when this container is actually found on a filed manifest. */
  manifest_igm_no?: number | string | null;
  manifest_line_no?: number | null;
}

/** Full view of one DO from `GET /api/shipping-lines/edo/{do_number}`. */
export interface EdoDetail {
  do_number: string;
  header?: EdoRecord | null;
  lines?: EdoLine[];
}

// ---- EIR (Equipment Interchange Report) ------------------------------------
//
// The gate transaction itself: a truck entering the terminal, taking or dropping
// a container, and leaving. Sourced from POC-3 `GET /api/gate-docs/eir`.

/** One EIR gate transaction. */
export interface EirTransaction {
  id?: number;
  /** EIR reference, e.g. E-GTI-2. */
  eir_no?: string | null;
  eir_type?: string | null;
  /** Free-text terminal as printed on the EIR, e.g. "Gateway (GTI)". */
  terminal?: string | null;
  /**
   * Canonical terminal code (NSICT, GTI, NSFT…) resolved server-side through
   * core.ref_terminal_alias. Use this to match a dashboard gate — the free-text
   * `terminal` does not reliably contain the code ("Nhava Sheva IGT" is NSIGT).
   */
  terminal_code?: string | null;
  container_number?: string | null;
  iso_valid?: boolean | null;
  /** Vessel the box came off, e.g. ONE RECOGNITION. */
  vessel?: string | null;
  /** Vessel visit/VIA number, e.g. S0475. */
  via_no?: string | null;
  seal_number?: string | null;
  bat_lane?: string | null;
  truck_no?: string | null;
  driver_name?: string | null;
  /** Driving licence number. */
  driver_licence?: string | null;
  /** Gate-in: when the truck entered. */
  truck_in_time?: string | null;
  /** Gate-out: when the truck left. */
  truck_out_time?: string | null;
  /** Turnaround minutes; decimal STRING on the wire. */
  tat_minutes?: number | string | null;
  gross_weight_mt?: number | string | null;
  /** Transport company. */
  company?: string | null;
  cfs_from?: string | null;
  cfs_to?: string | null;
  /** CFS group code, e.g. BLC. */
  group_code?: string | null;
  /** Customs scan stamp on the paper EIR, e.g. "SCANNED CLEAN". */
  scanner_stamp?: string | null;
  remarks?: string | null;
}

// ---- PIN pickup ticket -----------------------------------------------------
//
// The terminal's pickup ticket: the PIN a trucker quotes at the gate to collect
// a specific container, naming the lane, yard position and haulier. Sourced from
// POC-3 `GET /api/gate-docs/pin`.
//
// NOTE: the source ticket also carries a TRANSACTION number and the SHIPPING
// LINE code, but `core.pin_ticket` has no column for either yet, so they are not
// modelled here. Add them to the table first, then to this type.

/** One PIN pickup ticket (one row per move leg). */
export interface PinTicket {
  id?: number;
  /** PIN quoted at the gate, e.g. 230283. */
  pin_number?: string | null;
  ticket_type?: string | null;
  /** Terminal that issued the ticket, free text. */
  terminal?: string | null;
  /** Canonical terminal code resolved via core.ref_terminal_alias. Match on this. */
  terminal_code?: string | null;
  /** Truck registration, e.g. MH43CQ2814. */
  truck_no?: string | null;
  /** Trucking company, e.g. TRANSTAR. */
  company?: string | null;
  container_number?: string | null;
  iso_valid?: boolean | null;
  /** CFS group code. */
  group_code?: string | null;
  /** Yard position the box is stacked at, e.g. 2P08D.1. */
  yard_location?: string | null;
  /** Gate lane the ticket routes the truck to, e.g. "Gate 10". */
  gate?: string | null;
  move_type?: string | null;
  /** Sequence when a pickup spans several legs. */
  leg_seq?: number | null;
  issued_at?: string | null;
  remarks?: string | null;
}

// ---- CODECO gate-out movements ---------------------------------------------
//
// The last step of the import lifecycle: the container physically leaving the
// terminal on a truck, as reported by the terminal's CODECO message. Sourced
// from POC-3:
//   GET /api/shipping-lines/gates           -> gates that have movements
//   GET /api/shipping-lines/gate-movements  -> the movements (filter by gate_no)

/** One gate-out movement — a container leaving on a truck. */
export interface GateMovement {
  id?: number;
  /** ISO-6346 container number. */
  container_no: string;
  /** Vessel call number, e.g. INNSA1NS0S0552. */
  vcn?: string | null;
  imo_no?: string | null;
  /** Shipping agent code on the CODECO header. */
  /**
   * ⚠ The CONTAINER-level party (CODECO `CACode`), NOT the header shipping agent
   * (`ShippingAgentCode`) — the two differ on 3 of the 5 corpus messages, and
   * `core.codeco_movement` has no column for the header value, so it is not
   * persisted. It is the HEADER agent that joins to the berthing report; do not
   * label this field "Agent" without qualification. See
   * markdowns/04_Export_Build_Plan.md §2.4.
   */
  agent_code?: string | null;
  /** FCL / MTY (empty). */
  equipment_status?: string | null;
  cargo_type?: string | null;
  /** ISO 6346 size-type as stated on the CODECO (may differ from the IGM's). */
  iso_code?: string | null;
  pol?: string | null;
  final_pod?: string | null;
  receipt_date?: string | null;
  /** Vessel arrival timestamp carried on the same message. */
  arrival_ts?: string | null;
  /** Gate pass number, e.g. 16387383. */
  gate_pass_no?: string | null;
  /** When the gate pass was issued — the gate-out moment. */
  gate_pass_ts?: string | null;
  /** Truck registration, e.g. MH46H6948. */
  vehicle_no?: string | null;
  gate_no?: string | null;
  /** G = gate delivery. */
  delivery_mode?: string | null;
  seal_status?: string | null;
  /**
   * Terminal the gate belongs to (e.g. NSICT), resolved server-side through the
   * vessel call the CODECO message cites. The message itself names only a gate
   * NUMBER, so this is what ties a movement to a dashboard gate like NSICT-G1.
   */
  terminal_code?: string | null;
  /** PCS code of that terminal, e.g. INNSA1NSI1. */
  terminal_pcs_code?: string | null;
  /** Derived server-side: arrival -> gate pass, in hours. Null if either is absent. */
  dwell_hours?: number | string | null;
}

/** One gate with its movement count, from `GET /api/shipping-lines/gates`. */
export interface GateMovementGate {
  gate_no: string;
  /** Terminal the gate belongs to, e.g. NSICT. */
  terminal_code?: string | null;
  /** Dashboard-shaped gate id (terminal + gate number), e.g. NSICT-G1. */
  gate_id?: string | null;
  movements?: number | null;
}

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

// ---- Data upload (ingest) ---------------------------------------------------
//
// Every ingest module on POC-3 exposes the SAME two-step contract, which is what
// makes one shared dialog possible:
//
//   POST /api/{module}/validate  -> dry-run: parse + preview, writes nothing
//   POST /api/{module}/upload    -> persist valid rows, idempotent by row hash
//
// Both take multipart `file` plus ONE discriminator naming the document kind,
// whose form field differs per module (`list_type` / `doc_type` / `facility`).
// Mirrors the POC-1 upload panels, which drive the same endpoints.
//
// ⚠ Uploads are RBAC-gated server-side (CONTROL_ROOM / CUSTOMS / ADMIN). A role
// without the right claim gets 403 `upload_forbidden` — surface it, don't hide it.

/** Which ingest module a panel's Import button targets, and as what document. */
export interface UploadTarget {
  /** URL segment: 'shipping-lines' | 'gate-docs' | 'cfs-ecy'. */
  module: string;
  /** The multipart field naming the document kind, e.g. 'list_type'. */
  param: string;
  /** The value for `param`, e.g. 'EAL'. */
  value: string;
  /** `accept` hint for the OS file dialog. The backend detects format by content. */
  accept?: string;
  /** Human label shown in the dialog, e.g. "EAL — Export Advance List". */
  label?: string;
}

/**
 * One rejected row. Field names verified against a live
 * `POST /api/shipping-lines/validate` response — a missing-column rejection comes
 * back as `{row_number: null, column_name: 'Container Number',
 * error_code: 'missing_column', error_detail: '…download the latest template'}`.
 */
export interface UploadParseError {
  row_number?: number | null;
  column_name?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
  raw_value?: string | null;
}

/** Row counts, as the parser reported them. Never recomputed client-side. */
export interface UploadSummary {
  rows?: number | null;
  valid?: number | null;
  invalid?: number | null;
  duplicates?: number | null;
  importable?: number | null;
  errors?: number | null;
  warnings?: number | null;
  rejected?: boolean | null;
  valid_bool?: boolean | null;
}

/**
 * The validate/upload response. `status` distinguishes outcomes the UI must NOT
 * conflate: VALIDATED (dry run passed) · SUCCESS · PARTIAL · SKIPPED_DUPLICATE
 * (already imported — idempotency working, not a failure) · REJECTED / FAILED.
 *
 * ⚠ Counts live under `summary`, and the import step reports `imported`/`skipped`
 * at the top level. Both shapes are modelled here because one dialog renders both.
 */
export interface UploadResult {
  status?: string | null;
  valid?: boolean | null;
  file_id?: number | string | null;
  summary?: UploadSummary | null;
  /** Import step only: rows actually persisted / skipped as duplicates. */
  imported?: number | null;
  skipped?: number | null;
  invalid?: number | null;
  errors?: UploadParseError[] | null;
  warnings?: UploadParseError[] | null;
  preview?: unknown[] | null;
  [k: string]: unknown;
}

// ---- Per-container import chain views --------------------------------------
//
// The import lifecycle (markdowns/02_Import_Container_Lifecycle.md) runs
// `IGM -> arrival -> discharge -> yard -> [RMS] -> OOC -> E-DO -> PIN -> EIR ->
// CODECO gate-out`, but the dashboard only ever showed those documents in
// separate REGISTERS on four different tabs. These two container-keyed reads are
// what turns them back into one chain:
//
//   GET /api/customs/containers/{container_no}   -> IGM line, OOC, SMTP, RMS
//   GET /api/gate-docs/container/{container_no}  -> EIR, PIN, Form 13
//
// Both already existed on POC-3 with no client at all. Neither invents a join:
// each is a by-value lookup on the container number, so a box with no document of
// a given kind comes back with an empty array — which is the honest answer, and
// exactly what the Import tab renders as a documented gap.

/** Derived customs stage flags for one container. */
export interface ContainerCustomsStatus {
  container_no?: string | null;
  igm_no?: number | string | null;
  declared_igm?: boolean | null;
  rms_selected?: boolean | null;
  ooc_cleared?: boolean | null;
  smtp_bonded?: boolean | null;
}

/** The manifest line this container was declared on. */
export interface ContainerIgmLine {
  igm_no: number | string;
  line_no?: number | string | null;
  container_no?: string | null;
  seal_no?: string | null;
  container_agent_code?: string | null;
  container_status?: string | null;
  iso_size_type?: string | null;
}

/** The bill of entry + out-of-charge granted against this container. */
export interface ContainerOocLine {
  bill_of_entry_no: number | string;
  out_of_charge_no?: string | null;
  out_of_charge_date?: string | null;
  importer_name?: string | null;
}

/** A transhipment permit naming this container. */
export interface ContainerSmtpLine {
  smtp_no: number | string;
  bond_no?: string | null;
  destination_code?: string | null;
  consignee_name?: string | null;
}

/** An RMS scanning selection for this container. */
export interface ContainerRmsLine {
  igm_no?: number | string | null;
  /** "D" (drive-through) or "M" (mobile). */
  scan_machine?: string | null;
  scan_location?: string | null;
  cfs_name?: string | null;
}

/**
 * Everything the customs layer holds for one container, from
 * `GET /api/customs/containers/{container_no}`.
 *
 * ⚠ `vessel` is the manifest's vessel, joined container → cargo line → IGM. It is
 * the ONLY vessel binding available per box on the import leg; there is no COARRI
 * discharge for a JNPA call to corroborate it.
 */
export interface ContainerCustomsView {
  container_no: string;
  status?: ContainerCustomsStatus | null;
  vessel?: {
    igm_no?: number | string | null;
    igm_date?: string | null;
    imo_code?: string | null;
    vessel_code?: string | null;
    voyage_no?: string | null;
    shipping_line_code?: string | null;
    terminal_operator_code?: string | null;
    port_of_arrival?: string | null;
    expected_arrival?: string | null;
    entry_inward?: string | null;
  } | null;
  igm: ContainerIgmLine[];
  ooc: ContainerOocLine[];
  smtp: ContainerSmtpLine[];
  rms: ContainerRmsLine[];
  /** The ICEGATE message envelope that delivered the manifest, when linkable. */
  message?: {
    message_id_code?: string | null;
    message_type?: string | null;
    sent_ts?: string | null;
    source_file?: string | null;
  } | null;
}

/**
 * Every gate document referencing one container, from
 * `GET /api/gate-docs/container/{container_no}` — the PIN → EIR → gate steps.
 */
export interface ContainerGateDocs {
  container_no?: string;
  eir: EirTransaction[];
  pin: PinTicket[];
  form13: Array<Record<string, unknown>>;
  total?: number;
}

// ---- Export customs documents: Shipping Bill, LEO, SMTP --------------------
//
// The three customs document families named in WS4 §2 ("Customs views: IGM,
// Shipping Bill, LEO, OOC, SMTP") that had no client until now. Served by POC-3:
//   GET /api/customs/shipping-bills  -> export declarations
//   GET /api/customs/leo             -> Let Export Orders
//   GET /api/customs/smtp            -> Sub-Manifest Transhipment Permits (CHPOI13)
//
// ⚠ Shipping Bill and LEO DO NOT JOIN in this dataset. The filed SBs are June
// 2026 numbered 4.00–4.04M; the LEOs are April 2026 numbered 2.05–2.38M; the
// intersection on `sb_no` is empty (verified against the live DB). They are two
// disjoint document sets, not two ends of one chain — the UI must say so rather
// than implying a join. See markdowns/04_Export_Build_Plan.md §3.3.

/** One filed export declaration, from `GET /api/customs/shipping-bills`. */
export interface ShippingBillRecord {
  /** Shipping bill number, e.g. 4014226. */
  sb_no: number | string;
  sb_date?: string | null;
  /** Filing site, e.g. INJNP1. */
  site_id?: string | null;
}

/** One Let Export Order, from `GET /api/customs/leo`. */
export interface LeoRecord {
  /** The shipping bill the LEO was granted against. */
  sb_no: number | string;
  sb_date?: string | null;
  site_id?: string | null;
  /** Vessel rotation number, e.g. 1180983. */
  rotation_no?: string | null;
  /** Date the Let Export Order was granted — the customs-clearance timestamp. */
  leo_date?: string | null;
}

/** One Sub-Manifest Transhipment Permit (ICEGATE CHPOI13). */
export interface SmtpRecord {
  /** Permit number, e.g. 2697411. */
  smtp_no: number | string;
  smtp_date?: string | null;
  /** Manifest the permit was raised against. */
  igm_no?: number | string | null;
  igm_date?: string | null;
  /** Destination ICD code, e.g. INDHA6. */
  destination_code?: string | null;
  /** Carrier PAN. */
  carrier_code?: string | null;
  bond_no?: string | null;
  terminal_operator_code?: string | null;
  /**
   * Containers named on the permit, derived by the backend from
   * `core.smtp_container`. There is no per-permit container endpoint yet, so
   * this is a count only — do not render it as a drill-down.
   */
  line_count?: number | null;
}

// ---- Export-chain steps that had no read endpoint --------------------------
//
//   GET /api/export-chain/form11              rail pre-advice
//   GET /api/export-chain/load-list           COPRAR
//   GET /api/export-chain/load-confirmations  COARRI
//   GET /api/export-chain/synthetic           SYNTHETIC end-to-end chains
//   GET /api/marine/calls                     departures (already existed; carries `atd`)

/** Form 11 — the rail-origin export pre-advice. ⚠ One row per source workbook. */
export interface Form11Entry {
  form11_id: number;
  template?: string | null;
  /** Terminal vessel visit / VIA. */
  visit_no?: string | null;
  container_no?: string | null;
  iso_code?: string | null;
  size_ft?: number | null;
  booking_no?: string | null;
  preadvice_type?: string | null;
  trade_type?: string | null;
  /** 'R' = rail. */
  arrival_mode?: string | null;
  origin_port?: string | null;
  pod?: string | null;
  final_destination?: string | null;
  origin_type?: string | null;
  vgm_kg?: number | string | null;
  commodity?: string | null;
  line_code?: string | null;
  status?: string | null;
  line_seal?: string | null;
  customs_seal?: string | null;
  extras?: unknown;
}

/** One COPRAR line — a container ordered for loading. ⚠ Corpus sample is Kolkata/Haldia. */
export interface CoprarItem {
  id: number;
  vcn?: string | null;
  voyage_no?: string | null;
  rotation_no?: string | null;
  container_no?: string | null;
  equipment_status?: string | null;
  container_status?: string | null;
  iso_code?: string | null;
  tare_weight?: number | string | null;
  gross_weight?: number | string | null;
  port_of_origin?: string | null;
  pol?: string | null;
  pod?: string | null;
  final_pod?: string | null;
  igm_line_no?: number | null;
  igm_subline_no?: number | null;
  cargo_type?: string | null;
  imdg_class?: string | null;
  disposal_mode?: string | null;
  arrival_mode?: string | null;
}

/** One COARRI move — what was actually loaded/discharged. ⚠ Corpus sample is Vizag. */
export interface CoarriMove {
  id: number;
  vcn?: string | null;
  imo_no?: string | null;
  terminal_code?: string | null;
  container_no?: string | null;
  equipment_status?: string | null;
  line_code?: string | null;
  iso_code?: string | null;
  customs_seal?: string | null;
  shipper_seal?: string | null;
  icd_indicator?: string | null;
  shipped_ts?: string | null;
  landed_ts?: string | null;
  berthing_ts?: string | null;
  /** Damage recorded at the move. */
  damage_flag?: string | null;
  damage_desc?: string | null;
}

/**
 * A vessel's gate-open → cut-off window — the precondition of WS1 edge case EC-1.
 *
 * ⚠ VESSEL-LEVEL ONLY. EC-1 as specified is a per-container shutout-risk list, and
 * that is NOT derivable here: no container in the corpus reaches a vessel with a
 * cut-off. The export advance lists' vessel visits (KMIS0276, S0071, KMIR3458,
 * KMRA/R3494) appear in neither `core.berthing_report_vessel` nor
 * `core.vessel_call` — all three join paths return zero. Do not add a
 * "containers at risk" column; it would be empty on every row.
 *
 * Only NSICT and NSIGT publish these times, so this covers 139 of 775 vessel
 * rows, 46 of which carry a cut-off.
 */
export interface VesselCutoff {
  id: number;
  vessel_name?: string | null;
  via_no?: string | null;
  section?: string | null;
  eta?: string | null;
  /** When the terminal opened its gate for this call's export cargo. */
  gate_open_ts?: string | null;
  /** Dry-cargo cut-off — the deadline EC-1 measures a scan ETA against. */
  cutoff_dry_ts?: string | null;
  /** Reefer cut-off, usually later than dry. */
  cutoff_reefer_ts?: string | null;
  service?: string | null;
  line_code?: string | null;
  report_date?: string | null;
  terminal_code?: string | null;
}

/** A vessel departure — `atd` from core.vessel_call, the final export step. */
export interface VesselDeparture {
  call_id?: number | null;
  vcn?: string | null;
  via_no?: string | null;
  vessel_name?: string | null;
  imo_no?: string | null;
  voyage_no?: string | null;
  terminal_code?: string | null;
  eta?: string | null;
  etd?: string | null;
  ata?: string | null;
  /** Actual time of departure — populated from the VESDEP messages. */
  atd?: string | null;
  status?: string | null;
}

/** One step on a synthetic chain. */
export interface SyntheticChainStep {
  step_no: number;
  step_code: string;
  step_label: string;
  event_ts: string;
  doc_ref?: string | null;
}

/**
 * ⚠⚠ SYNTHETIC — generated demo data, NOT customer data.
 * Exists only because no real container traverses the full export lifecycle.
 * Container prefix `SYNU` is not an allocated BIC owner code. Any view rendering
 * these MUST carry a visible synthetic badge.
 */
export interface SyntheticChain {
  container_no: string;
  iso_code?: string | null;
  line_code?: string | null;
  booking_no?: string | null;
  origin_port?: string | null;
  origin_type?: string | null;
  arrival_mode?: string | null;
  cfs_name?: string | null;
  transporter?: string | null;
  truck_no?: string | null;
  pod?: string | null;
  vgm_kg?: number | string | null;
  line_seal?: string | null;
  customs_seal?: string | null;
  shipping_bill_no?: number | string | null;
  shipping_bill_date?: string | null;
  leo_no?: number | string | null;
  leo_date?: string | null;
  leo_rotation_no?: string | null;
  gate_pass_no?: string | null;
  gate_no?: string | null;
  /** REAL vessel call this synthetic chain terminates in. */
  vcn?: string | null;
  vessel_name?: string | null;
  via_no?: string | null;
  /** REAL departure timestamp — verifiable against core.vessel_call.atd. */
  departed_at?: string | null;
  steps?: SyntheticChainStep[];
}

// ---- Parsed source gate documents ------------------------------------------
//
// The customer's own gate documents — Form 13, EIR and PIN tickets — parsed
// verbatim from the shared corpus, with the full as-filed payload in `attrs`.
//   GET /api/gate-docs/documents
//
// ⚠ NOT the same store as `GET /api/gate-docs/form13`, which reads
// `core.gate_capture` — 202 of those 203 rows are seeded (`source_mode='sim'`)
// and carry synthetic shipping-bill numbers. These 13 are real. Use this
// endpoint wherever a document is shown as evidence.

/** One parsed source gate document (Form 13 / EIR / PIN ticket). */
export interface SourceGateDocument {
  doc_id: number;
  /** 'FORM13' | 'EIR' | 'PIN_TICKET'. */
  doc_category: string;
  /** Which physical document this was, e.g. form13_nsict_egate. */
  doc_variant?: string | null;
  /** The document's own reference (e-gate number, EIR number, approval no). */
  doc_ref?: string | null;
  pin_no?: string | null;
  visit_id?: string | null;
  doc_ts?: string | null;
  container_no?: string | null;
  iso_code?: string | null;
  load_status?: string | null;
  gross_weight_kg?: number | string | null;
  seal1?: string | null;
  seal2?: string | null;
  vehicle_no?: string | null;
  bat_no?: string | null;
  driver_name?: string | null;
  driver_licence?: string | null;
  transporter_name?: string | null;
  truck_in_ts?: string | null;
  truck_out_ts?: string | null;
  gate_no?: string | null;
  yard_position?: string | null;
  vessel_name?: string | null;
  voyage?: string | null;
  pol?: string | null;
  pod?: string | null;
  booking_no?: string | null;
  cfs?: string | null;
  group_code?: string | null;
  /**
   * Every field as it appeared on the document, keyed by the source label.
   * This is the "as filed" record — render it verbatim rather than remapping.
   */
  attrs?: Record<string, unknown> | null;
}

// ---- Shipping-line advance lists (IAL / EAL) -------------------------------
//
// The terminal load list. `list_type = 'EAL'` is the export side — the containers
// a line has declared to a terminal for a named vessel visit; 'IAL' is the import
// equivalent. Served by POC-3:
//   GET /api/shipping-lines?list_type=EAL&terminal=…&container=…
//
// 5,743 EAL rows across 5 terminal visits. ⚠ The BMCT list carries no vessel
// column at all (`vessel_visit` is null on all 588 of its rows) — that is how the
// file was supplied, not a parse failure, so the UI must show it as "not stated"
// rather than dropping those rows or inventing a visit.

/** One line on a shipping-line advance list (IAL import / EAL export). */
export interface AdvanceListContainer {
  id?: number;
  /** 'EAL' (export) or 'IAL' (import). */
  list_type?: string | null;
  /** Terminal code, e.g. NSICT. */
  terminal?: string | null;
  container_no: string;
  iso_code?: string | null;
  /** False when the container number fails ISO 6346 check-digit validation. */
  container_valid_iso?: boolean | null;
  /** 'FULL' or 'EMPTY'. */
  freight_kind?: string | null;
  /** Cargo category as filed, e.g. 'E' export, 'T' transhipment. */
  category?: string | null;
  /** Decimal STRING on the wire (Postgres numeric). */
  gross_weight_kg?: number | string | null;
  weight_source_uom?: string | null;
  pol?: string | null;
  pod?: string | null;
  destination?: string | null;
  shipping_line_code?: string | null;
  /** Terminal vessel visit / VIA, e.g. S0071. Null on the BMCT list — see above. */
  vessel_visit?: string | null;
  voyage?: string | null;
  bill_of_lading?: string | null;
  seal_no?: string | null;
  reefer_status?: string | null;
  reefer_temp?: number | string | null;
  /** IMDG class from the DG slot, when the line declared one. */
  imdg_code?: string | null;
  un_number?: string | null;
  group_code?: string | null;
  client_code?: string | null;
  departure_mode?: string | null;
  nominated_cfs?: string | null;
  iec_code?: string | null;
  gst_no?: string | null;
  commodity_code?: string | null;
}

/** Filters accepted by `GET /api/shipping-lines`. */
export interface AdvanceListFilter {
  list_type?: 'EAL' | 'IAL';
  terminal?: string;
  category?: string;
  freight_kind?: string;
  shipping_line?: string;
  container?: string;
  bl?: string;
  /** Free-text search across the indexed columns. */
  q?: string;
  limit?: number;
  offset?: number;
}

// ---- Terminal yard / pendency snapshot (WS1 EC-3) --------------------------
//
// The detection signal for the yard-congestion edge case: yard utilisation per
// terminal plus the pendency ledger. Parsed from the JNPA daily status reports.
//   GET /api/performance/daily/status
//
// `terminal_code = 'TOTAL'` is a port-wide roll-up row, NOT a terminal — filter
// it out of any per-terminal list or it double-counts.

/** One terminal's yard / gate / pendency snapshot for one report date. */
export interface TerminalYardStatus {
  report_date: string;
  /** Terminal code, e.g. NSICT — or 'TOTAL' for the port-wide roll-up row. */
  terminal_code: string;
  /** Numerics arrive as decimal STRINGS (Postgres numeric) — coerce before maths. */
  yard_occupancy_pct?: number | string | null;
  yard_total_teus?: number | string | null;
  yard_usable_capacity_teus?: number | string | null;
  yard_import_teus?: number | string | null;
  yard_export_teus?: number | string | null;
  yard_transhipment_teus?: number | string | null;
  /** Pendency awaiting rail evacuation. */
  icd_pendency_teus?: number | string | null;
  /** Pendency awaiting CFS evacuation. */
  cfs_pendency_teus?: number | string | null;
  gate_in_teus?: number | string | null;
  gate_out_teus?: number | string | null;
  gate_total_teus?: number | string | null;
  reefer_total_slots?: number | null;
  reefer_occupied_slots?: number | null;
  reefer_available_slots?: number | null;
}

// ---- CFS / ECY off-dock gate movements -------------------------------------
//
// The off-dock leg of the export chain: a container is released from an Empty
// Container Yard, trucked to a Container Freight Station for stuffing, and later
// leaves the CFS for the terminal gate. Sourced from POC-3, which parses the
// CFS-CODECO / ECY-CODECO feeds:
//   GET /api/cfs-ecy/stats         -> throughput + dwell aggregates
//   GET /api/cfs-ecy/chains/stats  -> ECY→CFS repositioning chain KPIs
//   GET /api/cfs-ecy/dwell         -> per-container CFS dwell rows
//
// ⚠ POPULATION-LEVEL ONLY. This feed shares ZERO container numbers with the
// manifests, advance lists and gate documents in the same corpus (verified: the
// intersection with every EAL/IAL list is empty). It therefore supports port-wide
// throughput and dwell statistics, and must NEVER be presented as one named
// container's history, nor linked from a container row on another tab. See
// markdowns/04_Export_Build_Plan.md §1.1.

/** Which off-dock facility a movement belongs to. */
export type CfsEcyFacility = 'CFS' | 'ECY';

/** One day of gate throughput, from the `daily_throughput` array on the stats call. */
export interface CfsEcyDailyThroughput {
  /** ISO date, e.g. "2026-07-14". */
  day: string;
  in_count: number;
  out_count: number;
}

/** Throughput + dwell aggregates from `GET /api/cfs-ecy/stats`. */
export interface CfsEcyStats {
  total_in: number;
  total_out: number;
  total_events: number;
  /** Distinct containers seen across the feed. */
  container_count: number;
  /** Containers currently in — gated in with no matching gate-out. */
  active_containers: number;
  /** Rows whose container number failed ISO 6346 validation. */
  iso_invalid: number;
  average_dwell_hours?: number | null;
  median_dwell_hours?: number | null;
  /** Containers that had a computable dwell (both an IN and an OUT). */
  dwell_count: number;
  daily_throughput: CfsEcyDailyThroughput[];
}

/** One anomaly bucket on the chain stats. */
export interface CfsEcyAnomalyCount {
  /** Machine code, e.g. NO_CFS_IN. Look up prose in `anomaly_labels`. */
  code: string;
  chains: number;
}

/**
 * ECY→CFS repositioning chain KPIs from `GET /api/cfs-ecy/chains/stats`.
 * A chain is COMPLETE when an ECY gate-out is followed by a CFS gate-in and a
 * CFS gate-out; PARTIAL when the sequence stops short.
 */
export interface CfsEcyChainStats {
  chains: number;
  complete_chains: number;
  partial_chains: number;
  anomaly_chains: number;
  /** Road leg, ECY-out → CFS-in. Decimal STRING on the wire (Postgres numeric). */
  avg_transit_hours?: number | string | null;
  /** Time inside the CFS, in → out. */
  avg_dwell_hours?: number | string | null;
  /** Whole cycle, ECY-out → CFS-out. */
  avg_cycle_hours?: number | string | null;
  median_cycle_hours?: number | string | null;
  by_anomaly?: CfsEcyAnomalyCount[];
  /** Machine code → prose, supplied by the backend so the UI invents no wording. */
  anomaly_labels?: Record<string, string>;
  last_rebuilt_at?: string | null;
}

/** One container's CFS dwell, from `GET /api/cfs-ecy/dwell`. */
export interface CfsEcyDwellItem {
  container_number?: string | null;
  facility_type?: CfsEcyFacility | string | null;
  first_in_ts?: string | null;
  last_out_ts?: string | null;
  in_events?: number | null;
  out_events?: number | null;
  dwell_hours?: number | string | null;
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

  /** Bills of Entry with their out-of-charge grants (`GET /api/customs/ooc`). Optional: POC-3 path only. */
  getOocRecords?(filter?: IgmContainerFilter): Promise<OocRecord[]>;
  /** One BE with its containers and invoice items (`GET /api/customs/ooc/{be}/items`). Optional: POC-3 path only. */
  getOocDetail?(beNo: string | number): Promise<OocDetail | null>;

  /** Electronic Delivery Orders (`GET /api/shipping-lines/edo`). Optional: POC-3 path only. */
  getEdoRecords?(filter?: IgmContainerFilter): Promise<EdoRecord[]>;
  /** One DO with its container lines (`GET /api/shipping-lines/edo/{do}`). Optional: POC-3 path only. */
  getEdoDetail?(doNumber: string): Promise<EdoDetail | null>;

  /** EIR gate transactions (`GET /api/gate-docs/eir`). Optional: POC-3 path only. */
  getEirTransactions?(filter?: IgmContainerFilter): Promise<EirTransaction[]>;
  /** PIN pickup tickets (`GET /api/gate-docs/pin`). Optional: POC-3 path only. */
  getPinTickets?(filter?: IgmContainerFilter): Promise<PinTicket[]>;

  /** Gates that have CODECO gate-out movements (`GET /api/shipping-lines/gates`). Optional: POC-3 path only. */
  getGateMovementGates?(): Promise<GateMovementGate[]>;
  /** CODECO gate-out movements, optionally for one gate (`GET /api/shipping-lines/gate-movements`). Optional: POC-3 path only. */
  getGateMovements?(gateNo?: string, filter?: IgmContainerFilter): Promise<GateMovement[]>;

  /** Form 11 rail pre-advice (`GET /api/export-chain/form11`). Optional: POC-3 path only. */
  getForm11?(container?: string): Promise<Form11Entry[]>;
  /** COPRAR advance load list (`GET /api/export-chain/load-list`). Optional: POC-3 path only. */
  getCoprarItems?(): Promise<CoprarItem[]>;
  /** COARRI load confirmations (`GET /api/export-chain/load-confirmations`). Optional: POC-3 path only. */
  getCoarriMoves?(): Promise<CoarriMove[]>;
  /** Vessel gate-open / cut-off windows (`GET /api/export-chain/cutoffs`). Optional: POC-3 path only. */
  getVesselCutoffs?(): Promise<VesselCutoff[]>;
  /** Vessel departures with a real `atd` (`GET /api/marine/calls`). Optional: POC-3 path only. */
  getVesselDepartures?(): Promise<VesselDeparture[]>;
  /** ⚠ SYNTHETIC end-to-end chains (`GET /api/export-chain/synthetic`). Optional: POC-3 path only. */
  getSyntheticChains?(): Promise<SyntheticChain[]>;

  /** Parsed source gate documents, as filed (`GET /api/gate-docs/documents`). Optional: POC-3 path only. */
  getSourceGateDocuments?(category?: string, container?: string): Promise<SourceGateDocument[]>;

  /** Shipping-line advance-list lines, IAL or EAL (`GET /api/shipping-lines`). Optional: POC-3 path only. */
  getAdvanceList?(filter?: AdvanceListFilter): Promise<AdvanceListContainer[]>;

  /**
   * The same read, plus the register's row count from the `Page` envelope.
   *
   * ⚠ Any panel that displays a count must use this, not `getAdvanceList().length`
   * — the EAL register holds 5,743 rows, so a page length is not the population.
   * `total` is null when the endpoint answered with a bare array.
   */
  getAdvanceListPage?(
    filter?: AdvanceListFilter,
  ): Promise<{ items: AdvanceListContainer[]; total: number | null }>;

  /** Per-terminal yard / pendency snapshot (`GET /api/performance/daily/status`). Optional: POC-3 path only. */
  getTerminalYardStatus?(reportDate?: string): Promise<TerminalYardStatus[]>;

  /**
   * The container movement list PLUS the filtered total from `X-Total-Count`.
   *
   * ⚠ Any panel that shows a count must use this. `/api/cargo` returns a bare
   * array, so `items.length` is the PAGE SIZE (default 100) — not the population.
   */
  getContainerMovementsPage?(
    filter: ContainerMovementFilter,
  ): Promise<{ items: ContainerMovementDTO[]; total: number | null }>;

  /**
   * Dry-run a data upload — `POST /api/{module}/validate`. Writes NOTHING, so it is
   * safe to call every time the user re-picks a file. A structurally invalid file
   * RESOLVES with `status: 'REJECTED'` rather than rejecting the promise.
   */
  validateUpload?(target: UploadTarget, file: File): Promise<UploadResult>;

  /**
   * Persist a data upload — `POST /api/{module}/upload`. Idempotent: byte-identical
   * content resolves with `status: 'SKIPPED_DUPLICATE'`, and content-hashed rows
   * collapse on re-import, so a double-click cannot duplicate data.
   */
  importUpload?(target: UploadTarget, file: File): Promise<UploadResult>;

  /**
   * Yard assignment — `PUT /api/cargo/{cn}/yard-assignment`. The second mandatory
   * gate; lenient on the source state so a row whose `yard_block` was set directly
   * (without the transition) can be caught up.
   */
  assignYard?(containerNo: string, yardBlock: string): Promise<CargoRecord>;

  /**
   * Scan verification — `POST /api/cargo/{cn}/verify`. The scan OUTCOME, and the
   * gate Release waits on. `verified: false` records a failed check without
   * advancing the lifecycle.
   */
  verifyCargo?(
    containerNo: string,
    input?: { verified?: boolean; remarks?: string },
  ): Promise<{ container_number: string; verified: boolean; lifecycle_status: string }>;

  /**
   * Release — `POST /api/cargo/{cn}/release`, the final gate and the UC-III
   * handover. Requires `VERIFIED`. Use this rather than `PUT {is_released:true}`:
   * both face the same gate, but only this one reads as the transition it is.
   */
  releaseCargo?(containerNo: string, note?: string): Promise<CargoRecord>;

  /**
   * Vessel discharge — `POST /api/cargo/{cn}/discharge`, the FIRST mandatory gate
   * of the UC-II lifecycle (`CREATED -> VESSEL_DISCHARGED`).
   *
   * Why this matters beyond one button: the cargo lifecycle is a forward-only
   * state machine whose mandatory gates are CREATED → VESSEL_DISCHARGED →
   * YARD_ASSIGNED → VERIFIED → RELEASED. Nothing downstream — yard assignment,
   * the scan queue, release, and UC-III's truck-job assignment — can be reached
   * until discharge is recorded, so leaving this unwired stalled every container
   * at CREATED.
   *
   * The transition also emits `cargo.vessel_discharged`, which is one of the few
   * events distributed on the shared bus (Kafka + WebSocket) rather than only
   * logged — it is the handover signal UC-III listens for.
   *
   * Rejects with 409 when the container is not in a dischargeable state (already
   * discharged or further along); 404 when unknown.
   */
  dischargeCargo?(
    containerNo: string,
    input?: { vessel_name?: string; discharge_time?: string },
  ): Promise<{ container_number: string; lifecycle_status: string; status: string }>;

  /**
   * The customs layer's full view of ONE container (`GET /api/customs/containers/{cn}`)
   * — manifest line, out-of-charge, transhipment permit and RMS selection together.
   * Resolves to null when the box appears in no customs document (the API 404s),
   * which the Import tab reports as "not in the customs corpus", never as an error.
   */
  getContainerCustoms?(containerNo: string): Promise<ContainerCustomsView | null>;

  /**
   * Every gate document for ONE container (`GET /api/gate-docs/container/{cn}`) —
   * the PIN pickup ticket, the EIR and any Form 13. Null when the box has none.
   */
  getContainerGateDocs?(containerNo: string): Promise<ContainerGateDocs | null>;

  /** Delivery orders naming ONE container (`GET /api/shipping-lines/edo?container_no=`). */
  getEdoForContainer?(containerNo: string): Promise<EdoRecord[]>;

  /** Filed export declarations (`GET /api/customs/shipping-bills`). Optional: POC-3 path only. */
  getShippingBills?(filter?: IgmContainerFilter): Promise<ShippingBillRecord[]>;
  /** Let Export Orders (`GET /api/customs/leo`). Optional: POC-3 path only. */
  getLeoRecords?(filter?: IgmContainerFilter): Promise<LeoRecord[]>;
  /** Sub-Manifest Transhipment Permits (`GET /api/customs/smtp`). Optional: POC-3 path only. */
  getSmtpRecords?(filter?: IgmContainerFilter): Promise<SmtpRecord[]>;

  /** Off-dock CFS/ECY throughput + dwell aggregates (`GET /api/cfs-ecy/stats`). Optional: POC-3 path only. */
  getCfsEcyStats?(facility?: CfsEcyFacility): Promise<CfsEcyStats>;
  /** ECY→CFS repositioning chain KPIs (`GET /api/cfs-ecy/chains/stats`). Optional: POC-3 path only. */
  getCfsEcyChainStats?(): Promise<CfsEcyChainStats>;
  /** Per-container CFS dwell rows (`GET /api/cfs-ecy/dwell`). Optional: POC-3 path only. */
  getCfsEcyDwell?(filter?: IgmContainerFilter): Promise<CfsEcyDwellItem[]>;

  /** Which mode this adapter is operating in (for the UI badge). */
  readonly mode: 'mock' | 'live';
}
