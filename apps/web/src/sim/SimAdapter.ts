/**
 * SimAdapter — a transparent wrapper around the real DataAdapter (mock or live)
 * that overlays the current simStore overrides onto every read. Because the
 * whole UI binds to the adapter (prompt §5), wrapping it here means *every* tab
 * — GateOps, Pendency, RailSide, Movements, Scan, Empty — reflects the live sim
 * state automatically, with no per-panel changes.
 *
 * It reads simStore.getState() at call time, so each useAsync refetch picks up
 * the latest overrides; the Dashboard re-keys its panels on the sim tick so they
 * refetch while the clock runs. Writes/scenarios pass straight through.
 */
import type {
  DataAdapter, CargoCreateInput, CargoUpdateInput, ContainerMovementDTO, ContainerMovementFilter,
  GateOpsDTO, GateQueueForecastDTO, PendencyDTO, RailSideDTO, RakeForecastDTO, EmptyPoolDTO,
  TimeWindow, ScenarioParams, ScenarioResultDTO,
  CargoNotification, CargoNotificationCreateInput, CargoNotificationFilter,
  CargoWorkflowActionInput, CargoWorkflowHistoryEntry, CargoWorkflowState,
  YardPlanningInput, YardPlanningResult, YardOptimization,
  RakePlan, RakePlanInput, ReeferPlan, ReeferPlanInput, CargoLifecycleEvent, LiveVesselDTO,
  IgmManifest, IgmContainer, IgmContainerFilter, RmsScanList, RmsScanContainer,
  GateMovement, GateMovementGate, OocRecord, OocDetail, EdoRecord, EdoDetail, EirTransaction, PinTicket,
  CfsEcyChainStats, CfsEcyDwellItem, CfsEcyFacility, CfsEcyStats,
} from '@jnpa/data';
import type {
  Facility, Terminal, Role, SidingId, ITRHOMovement, ScanEvent,
  KpiResult, Notification, IntegrationHealth,
} from '@jnpa/schemas';
import { simStore } from './simStore.js';
import { faultStore, applyIntegrationFaults } from '../console/faultStore.js';
import {
  applyGateOps, applyPendency, applyRail, applyKpis, applyScanQueue, applyEmptyPool,
} from './applySim.js';

export class SimAdapter implements DataAdapter {
  constructor(private readonly base: DataAdapter) {}

  get mode() {
    return this.base.mode;
  }

  getFacilities(role?: Role): Promise<Facility[]> {
    return this.base.getFacilities(role);
  }
  getTerminals(): Promise<Terminal[]> {
    return this.base.getTerminals();
  }
  getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    return this.base.getContainerMovements(filter);
  }
  /** Cargo writes pass straight through to the base (Poc3CargoAdapter) — the
   *  simulator never overlays cargo, which is sourced solely from POC-3. */
  createCargo(record: CargoCreateInput): Promise<ContainerMovementDTO> {
    if (!this.base.createCargo) return Promise.reject(new Error('Cargo write is unavailable in this data mode.'));
    return this.base.createCargo(record);
  }
  updateCargo(containerNo: string, patch: CargoUpdateInput): Promise<ContainerMovementDTO> {
    if (!this.base.updateCargo) return Promise.reject(new Error('Cargo write is unavailable in this data mode.'));
    return this.base.updateCargo(containerNo, patch);
  }
  deleteCargo(containerNo: string): Promise<void> {
    if (!this.base.deleteCargo) return Promise.reject(new Error('Cargo write is unavailable in this data mode.'));
    return this.base.deleteCargo(containerNo);
  }

  /** POC-3 extended Cargo APIs pass straight through to the base (Poc3CargoAdapter);
   *  the simulator never overlays cargo, which is sourced solely from POC-3. Each
   *  guards the optional base method so mock/sim mode rejects with a clear message. */
  private static unavailable(): Promise<never> {
    return Promise.reject(new Error('Cargo API is unavailable in this data mode.'));
  }
  createCargoNotification(input: CargoNotificationCreateInput): Promise<CargoNotification> {
    return this.base.createCargoNotification ? this.base.createCargoNotification(input) : SimAdapter.unavailable();
  }
  getCargoNotifications(filter?: CargoNotificationFilter): Promise<CargoNotification[]> {
    return this.base.getCargoNotifications ? this.base.getCargoNotifications(filter) : SimAdapter.unavailable();
  }
  triggerCargoWorkflow(containerNo: string, input: CargoWorkflowActionInput): Promise<CargoWorkflowState> {
    return this.base.triggerCargoWorkflow ? this.base.triggerCargoWorkflow(containerNo, input) : SimAdapter.unavailable();
  }
  getCargoWorkflowHistory(containerNo: string): Promise<CargoWorkflowHistoryEntry[]> {
    return this.base.getCargoWorkflowHistory ? this.base.getCargoWorkflowHistory(containerNo) : SimAdapter.unavailable();
  }
  createYardPlan(input: YardPlanningInput): Promise<YardPlanningResult> {
    return this.base.createYardPlan ? this.base.createYardPlan(input) : SimAdapter.unavailable();
  }
  getYardOptimization(): Promise<YardOptimization> {
    return this.base.getYardOptimization ? this.base.getYardOptimization() : SimAdapter.unavailable();
  }
  createRakePlan(input: RakePlanInput): Promise<RakePlan> {
    return this.base.createRakePlan ? this.base.createRakePlan(input) : SimAdapter.unavailable();
  }
  getRakePlans(): Promise<RakePlan[]> {
    return this.base.getRakePlans ? this.base.getRakePlans() : SimAdapter.unavailable();
  }
  createReeferPlan(input: ReeferPlanInput): Promise<ReeferPlan> {
    return this.base.createReeferPlan ? this.base.createReeferPlan(input) : SimAdapter.unavailable();
  }
  getCargoEvents(containerNo?: string): Promise<CargoLifecycleEvent[]> {
    return this.base.getCargoEvents ? this.base.getCargoEvents(containerNo) : SimAdapter.unavailable();
  }
  getLiveVessels(): Promise<LiveVesselDTO[]> {
    return this.base.getLiveVessels ? this.base.getLiveVessels() : SimAdapter.unavailable();
  }
  /** IGM manifests are filed customs documents — the simulator never overlays them. */
  getIgmManifests(filter?: IgmContainerFilter): Promise<IgmManifest[]> {
    return this.base.getIgmManifests ? this.base.getIgmManifests(filter) : SimAdapter.unavailable();
  }
  getIgmContainers(igmNo: string | number, filter?: IgmContainerFilter): Promise<IgmContainer[]> {
    return this.base.getIgmContainers ? this.base.getIgmContainers(igmNo, filter) : SimAdapter.unavailable();
  }
  /** RMS scan selections are filed customs documents — never overlaid by the simulator. */
  getRmsScanLists(filter?: IgmContainerFilter): Promise<RmsScanList[]> {
    return this.base.getRmsScanLists ? this.base.getRmsScanLists(filter) : SimAdapter.unavailable();
  }
  getRmsScanContainers(igmNo: string | number, filter?: IgmContainerFilter): Promise<RmsScanContainer[]> {
    return this.base.getRmsScanContainers ? this.base.getRmsScanContainers(igmNo, filter) : SimAdapter.unavailable();
  }
  /** OOC / Bill of Entry are filed customs documents — never simulated. */
  getOocRecords(filter?: IgmContainerFilter): Promise<OocRecord[]> {
    return this.base.getOocRecords ? this.base.getOocRecords(filter) : SimAdapter.unavailable();
  }
  getOocDetail(beNo: string | number): Promise<OocDetail | null> {
    return this.base.getOocDetail ? this.base.getOocDetail(beNo) : SimAdapter.unavailable();
  }
  /** E-DO delivery orders are filed shipping-line documents — never simulated. */
  getEdoRecords(filter?: IgmContainerFilter): Promise<EdoRecord[]> {
    return this.base.getEdoRecords ? this.base.getEdoRecords(filter) : SimAdapter.unavailable();
  }
  getEdoDetail(doNumber: string): Promise<EdoDetail | null> {
    return this.base.getEdoDetail ? this.base.getEdoDetail(doNumber) : SimAdapter.unavailable();
  }
  /** EIR gate transactions are filed gate documents — never simulated. */
  getEirTransactions(filter?: IgmContainerFilter): Promise<EirTransaction[]> {
    return this.base.getEirTransactions ? this.base.getEirTransactions(filter) : SimAdapter.unavailable();
  }
  getPinTickets(filter?: IgmContainerFilter): Promise<PinTicket[]> {
    return this.base.getPinTickets ? this.base.getPinTickets(filter) : SimAdapter.unavailable();
  }
  /** CODECO gate-out movements are filed terminal messages — never simulated. */
  getGateMovementGates(): Promise<GateMovementGate[]> {
    return this.base.getGateMovementGates ? this.base.getGateMovementGates() : SimAdapter.unavailable();
  }
  getGateMovements(gateNo?: string, filter?: IgmContainerFilter): Promise<GateMovement[]> {
    return this.base.getGateMovements ? this.base.getGateMovements(gateNo, filter) : SimAdapter.unavailable();
  }
  /**
   * CFS/ECY off-dock movements are filed CODECO messages — never simulated. These
   * are port-level aggregates over a container set disjoint from every other tab,
   * so there is nothing for the simulator's levers to overlay onto.
   */
  getCfsEcyStats(facility?: CfsEcyFacility): Promise<CfsEcyStats> {
    return this.base.getCfsEcyStats ? this.base.getCfsEcyStats(facility) : SimAdapter.unavailable();
  }
  getCfsEcyChainStats(): Promise<CfsEcyChainStats> {
    return this.base.getCfsEcyChainStats ? this.base.getCfsEcyChainStats() : SimAdapter.unavailable();
  }
  getCfsEcyDwell(filter?: IgmContainerFilter): Promise<CfsEcyDwellItem[]> {
    return this.base.getCfsEcyDwell ? this.base.getCfsEcyDwell(filter) : SimAdapter.unavailable();
  }

  async getGateOps(window: TimeWindow): Promise<GateOpsDTO[]> {
    return applyGateOps(await this.base.getGateOps(window), simStore.getState());
  }
  getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO> {
    return this.base.getGateQueueForecast(gateId);
  }
  async getPendency(byFacility?: boolean): Promise<PendencyDTO[]> {
    return applyPendency(await this.base.getPendency(byFacility), simStore.getState());
  }
  async getRailSide(siding: SidingId, window: TimeWindow): Promise<RailSideDTO> {
    return applyRail(await this.base.getRailSide(siding, window), simStore.getState(), siding);
  }
  getRakeForecast(rakeId: string): Promise<RakeForecastDTO> {
    return this.base.getRakeForecast(rakeId);
  }
  getITRHO(window: TimeWindow): Promise<ITRHOMovement[]> {
    return this.base.getITRHO(window);
  }
  async getScanQueue(): Promise<ScanEvent[]> {
    return applyScanQueue(await this.base.getScanQueue(), simStore.getState());
  }
  async getEmptyPool(): Promise<EmptyPoolDTO> {
    return applyEmptyPool(await this.base.getEmptyPool(), simStore.getState());
  }
  async getKPIs(): Promise<KpiResult[]> {
    return applyKpis(await this.base.getKPIs(), simStore.getState());
  }
  getNotifications(role: Role): Promise<Notification[]> {
    return this.base.getNotifications(role);
  }
  async getIntegrationHealth(): Promise<IntegrationHealth[]> {
    // Overlay the Integration Console's injected faults so the HealthCards tab +
    // Operator Banner react live when a source is degraded / killed / recovered.
    return applyIntegrationFaults(await this.base.getIntegrationHealth(), faultStore.getState());
  }
  runScenario(id: string, params: ScenarioParams): Promise<ScenarioResultDTO> {
    return this.base.runScenario(id, params);
  }
}
