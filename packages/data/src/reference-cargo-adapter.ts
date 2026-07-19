/**
 * ReferenceCargoAdapter — a transparent decorator (same pattern as
 * {@link Poc3CargoAdapter}) that re-sources ONLY the container-movement read from
 * the JNPA reference data package, delegating every other method to the wrapped
 * base adapter (mock or live). This is what keeps VITE_CARGO_SOURCE=reference
 * scoped to cargo: the base adapter — and therefore every non-cargo panel (gate,
 * rail, KPI, pendency, …) — is chosen purely by DATA_MODE and is untouched.
 *
 * The reference dataset is loaded at runtime by the host (a JSON fetched only in
 * reference mode) and handed in via {@link ReferenceCargoAdapterDeps.getOverride};
 * until it resolves, getContainerMovements returns [] (reference cargo, or none —
 * never synthetic cargo). Folding/filtering reuses MockAdapter unchanged, so no
 * movement logic is duplicated. Optional cargo methods (create/update/… ) are
 * forwarded to the base only when the base actually implements them, so mock and
 * live behaviour is preserved exactly.
 */
import type {
  Facility, IntegrationHealth, ITRHOMovement, KpiResult, Notification, Role,
  ScanEvent, SidingId, Terminal,
} from '@jnpa/schemas';
import type { BaselinesConfig } from '@jnpa/kpi';
import type {
  ContainerMovementDTO,
  ContainerMovementFilter,
  DataAdapter,
  EmptyPoolDTO,
  GateOpsDTO,
  GateQueueForecastDTO,
  PendencyDTO,
  RailSideDTO,
  RakeForecastDTO,
  ScenarioParams,
  ScenarioResultDTO,
  TimeWindow,
} from './interface.js';
import { MockAdapter } from './mock-adapter.js';
import type { ReferenceCargoOverride } from './reference/index.js';

export interface ReferenceCargoAdapterDeps {
  terminalsConfig: ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
  baselines: BaselinesConfig;
  /** Returns the loaded reference dataset, or undefined until it is fetched. */
  getOverride: () => ReferenceCargoOverride | undefined;
}

export class ReferenceCargoAdapter implements DataAdapter {
  private base: DataAdapter;
  private deps: ReferenceCargoAdapterDeps;
  private cargoSource?: MockAdapter;
  private cargoSig?: ReferenceCargoOverride;

  // Optional cargo methods are forwarded from the base only when it provides
  // them, so their presence (and thus the UI's write affordances) matches the
  // base adapter exactly. Reference re-sources reads, never writes.
  createCargo?: DataAdapter['createCargo'];
  updateCargo?: DataAdapter['updateCargo'];
  deleteCargo?: DataAdapter['deleteCargo'];
  createCargoNotification?: DataAdapter['createCargoNotification'];
  getCargoNotifications?: DataAdapter['getCargoNotifications'];
  triggerCargoWorkflow?: DataAdapter['triggerCargoWorkflow'];
  getCargoWorkflowHistory?: DataAdapter['getCargoWorkflowHistory'];
  createYardPlan?: DataAdapter['createYardPlan'];
  getYardOptimization?: DataAdapter['getYardOptimization'];
  createRakePlan?: DataAdapter['createRakePlan'];
  getRakePlans?: DataAdapter['getRakePlans'];
  createReeferPlan?: DataAdapter['createReeferPlan'];
  getCargoEvents?: DataAdapter['getCargoEvents'];

  constructor(base: DataAdapter, deps: ReferenceCargoAdapterDeps) {
    this.base = base;
    this.deps = deps;
    if (base.createCargo) this.createCargo = base.createCargo.bind(base);
    if (base.updateCargo) this.updateCargo = base.updateCargo.bind(base);
    if (base.deleteCargo) this.deleteCargo = base.deleteCargo.bind(base);
    if (base.createCargoNotification) this.createCargoNotification = base.createCargoNotification.bind(base);
    if (base.getCargoNotifications) this.getCargoNotifications = base.getCargoNotifications.bind(base);
    if (base.triggerCargoWorkflow) this.triggerCargoWorkflow = base.triggerCargoWorkflow.bind(base);
    if (base.getCargoWorkflowHistory) this.getCargoWorkflowHistory = base.getCargoWorkflowHistory.bind(base);
    if (base.createYardPlan) this.createYardPlan = base.createYardPlan.bind(base);
    if (base.getYardOptimization) this.getYardOptimization = base.getYardOptimization.bind(base);
    if (base.createRakePlan) this.createRakePlan = base.createRakePlan.bind(base);
    if (base.getRakePlans) this.getRakePlans = base.getRakePlans.bind(base);
    if (base.createReeferPlan) this.createReeferPlan = base.createReeferPlan.bind(base);
    if (base.getCargoEvents) this.getCargoEvents = base.getCargoEvents.bind(base);
  }

  /** Cargo comes from the reference dataset, but the base still labels app mode. */
  get mode() {
    return this.base.mode;
  }

  /** Build (once) an internal MockAdapter over the loaded reference dataset. */
  private cargo(): MockAdapter | undefined {
    const ov = this.deps.getOverride();
    if (!ov) return undefined;
    if (this.cargoSource && this.cargoSig === ov) return this.cargoSource;
    this.cargoSource = new MockAdapter({
      terminalsConfig: this.deps.terminalsConfig,
      baselines: this.deps.baselines,
      cargoOverride: ov,
    });
    this.cargoSig = ov;
    return this.cargoSource;
  }

  // -- the ONE re-sourced read ------------------------------------------------
  getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    const src = this.cargo();
    return src ? src.getContainerMovements(filter) : Promise.resolve([]);
  }

  // -- everything else passes straight through to the base adapter -----------
  getFacilities(role?: Role): Promise<Facility[]> {
    return this.base.getFacilities(role);
  }
  getTerminals(): Promise<Terminal[]> {
    return this.base.getTerminals();
  }
  getGateOps(window: TimeWindow): Promise<GateOpsDTO[]> {
    return this.base.getGateOps(window);
  }
  getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO> {
    return this.base.getGateQueueForecast(gateId);
  }
  getPendency(byFacility?: boolean): Promise<PendencyDTO[]> {
    return this.base.getPendency(byFacility);
  }
  getRailSide(siding: SidingId, window: TimeWindow): Promise<RailSideDTO> {
    return this.base.getRailSide(siding, window);
  }
  getRakeForecast(rakeId: string): Promise<RakeForecastDTO> {
    return this.base.getRakeForecast(rakeId);
  }
  getITRHO(window: TimeWindow): Promise<ITRHOMovement[]> {
    return this.base.getITRHO(window);
  }
  getScanQueue(): Promise<ScanEvent[]> {
    return this.base.getScanQueue();
  }
  getEmptyPool(): Promise<EmptyPoolDTO> {
    return this.base.getEmptyPool();
  }
  getKPIs(): Promise<KpiResult[]> {
    return this.base.getKPIs();
  }
  getNotifications(role: Role): Promise<Notification[]> {
    return this.base.getNotifications(role);
  }
  getIntegrationHealth(): Promise<IntegrationHealth[]> {
    return this.base.getIntegrationHealth();
  }
  runScenario(id: string, params: ScenarioParams): Promise<ScenarioResultDTO> {
    return this.base.runScenario(id, params);
  }
}
