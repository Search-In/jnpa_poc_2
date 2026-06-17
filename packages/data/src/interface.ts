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

  /** Which mode this adapter is operating in (for the UI badge). */
  readonly mode: 'mock' | 'live';
}
