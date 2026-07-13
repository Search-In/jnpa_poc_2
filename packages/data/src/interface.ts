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

  /** Which mode this adapter is operating in (for the UI badge). */
  readonly mode: 'mock' | 'live';
}
