/**
 * Poc3CargoAdapter — a transparent decorator around the real DataAdapter (mock
 * or live) that re-sources ONLY the cargo read (`getContainerMovements`) from
 * the POC-3 shared Cargo API (`GET /api/cargo`). Every other method delegates to
 * the wrapped base adapter, so the non-cargo panels (gate, rail, KPIs, …) keep
 * their existing behaviour while cargo becomes a single source of truth.
 *
 * POC-2 owns no cargo store: this adapter simply calls the POC-3 gateway and maps
 * its `CargoOut` record into the canonical DTO via {@link mapCargoToMovement}.
 * The URL/auth plumbing mirrors {@link LiveAdapter} (same `buildUrl` + bearer
 * token pattern) so there is one fetch idiom in the codebase, not two.
 */
import type {
  Facility, IntegrationHealth, ITRHOMovement, KpiResult, Notification, Role,
  ScanEvent, SidingId, Terminal,
} from '@jnpa/schemas';
import { isValidContainerNo } from '@jnpa/schemas';
import type {
  CargoRecord,
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
import { mapCargoToMovement } from './cargo-mapper.js';

export interface Poc3CargoAdapterDeps {
  /** Base URL of the POC-3 gateway. Relative (e.g. "/poc3" behind a dev proxy) or absolute. */
  cargoBaseUrl: string;
  /** Returns the current bearer token when the gateway runs with AUTH_ENABLED. */
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export class Poc3CargoAdapter implements DataAdapter {
  private base: DataAdapter;
  private cargoBase: string;
  private getToken: () => string | undefined;
  private fetchImpl: typeof fetch;

  constructor(base: DataAdapter, deps: Poc3CargoAdapterDeps) {
    this.base = base;
    this.cargoBase = deps.cargoBaseUrl.replace(/\/$/, '');
    this.getToken = deps.getToken ?? (() => undefined);
    // Keep `fetch` bound to its global (a bare property call throws "Illegal
    // invocation" in the browser). Mirrors LiveAdapter.
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /** Cargo now comes from POC-3, but the wrapped base still labels the app mode. */
  get mode() {
    return this.base.mode;
  }

  // -- POC-3 fetch plumbing (mirrors LiveAdapter.buildUrl/get) ----------------
  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const isAbsolute = /^https?:\/\//i.test(this.cargoBase);
    const origin =
      typeof globalThis !== 'undefined' && (globalThis as { location?: { origin?: string } }).location?.origin
        ? (globalThis as { location: { origin: string } }).location.origin
        : 'http://localhost';
    const url = new URL(this.cargoBase + path, isAbsolute ? undefined : origin);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    return isAbsolute ? url.toString() : url.pathname + url.search;
  }

  private async getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const token = this.getToken();
    const res = await this.fetchImpl(this.buildUrl(path, query), {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`POC-3 Cargo API ${path} → ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  // -- the one re-sourced method ---------------------------------------------
  async getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    // Container Search: an exact ISO-6346 lookup goes to the single-record
    // endpoint (Phase 6 — never a local array scan). A 404 is an empty result,
    // not an error, so the panel shows its graceful empty state.
    if (filter.containerNo) {
      const norm = filter.containerNo.trim().toUpperCase().replace(/\s+/g, '');
      if (!isValidContainerNo(norm)) return [];
      try {
        const one = await this.getJson<CargoRecord>(`/api/cargo/${encodeURIComponent(norm)}`);
        return [mapCargoToMovement(one)];
      } catch (err) {
        if (err instanceof Error && / → 404 /.test(err.message)) return [];
        throw err;
      }
    }

    const rows = await this.getJson<CargoRecord[]>('/api/cargo', {
      customs_status: filter.customsStatus,
      yard_block: filter.yardBlock,
      is_released: filter.isReleased == null ? undefined : String(filter.isReleased),
      vehicle_number: filter.vehicleNumber,
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    });
    return rows.map(mapCargoToMovement);
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
