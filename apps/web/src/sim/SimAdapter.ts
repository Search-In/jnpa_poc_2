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
  DataAdapter, CargoRecord, ContainerMovementDTO, ContainerMovementFilter, GateOpsDTO,
  GateQueueForecastDTO, PendencyDTO, RailSideDTO, RakeForecastDTO, EmptyPoolDTO,
  TimeWindow, ScenarioParams, ScenarioResultDTO,
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
  /** Cargo write passes straight through to the base (Poc3CargoAdapter). */
  updateCargo(containerNo: string, patch: Partial<CargoRecord>): Promise<ContainerMovementDTO> {
    if (!this.base.updateCargo) return Promise.reject(new Error('Cargo write is unavailable in this data mode.'));
    return this.base.updateCargo(containerNo, patch);
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
