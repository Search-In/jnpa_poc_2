/**
 * LiveAdapter (prompt §5) — calls the gateway BFF, which aggregates the
 * connector services (ULIP, ICEGATE, TOS, FOIS, e-seal, shipline) and the AI
 * model endpoints. Same DataAdapter interface as MockAdapter, so the UI is
 * unchanged when DATA_MODE=live. Auth token is injected per request.
 */
import type {
  Facility,
  IntegrationHealth,
  ITRHOMovement,
  KpiResult,
  Notification,
  Role,
  ScanEvent,
  SidingId,
  Terminal,
} from '@jnpa/schemas';
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

export interface LiveAdapterDeps {
  gatewayBaseUrl: string;
  /** Returns the current bearer token (OIDC/JWT). */
  getToken?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export class LiveAdapter implements DataAdapter {
  readonly mode = 'live' as const;
  private base: string;
  private getToken: () => string | undefined;
  private fetchImpl: typeof fetch;

  constructor(deps: LiveAdapterDeps) {
    this.base = deps.gatewayBaseUrl.replace(/\/$/, '');
    this.getToken = deps.getToken ?? (() => undefined);
    // `fetch` must stay bound to its global, else the browser throws
    // "Illegal invocation" when called off a property. Bind defensively.
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /**
   * Build a request URL. `base` may be relative (e.g. "/gateway" behind a dev
   * proxy) or absolute. `new URL()` needs an origin for relative bases, so we
   * resolve against window.location.origin in the browser (or a placeholder in
   * node, which is only hit when query params need encoding).
   */
  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const isAbsolute = /^https?:\/\//i.test(this.base);
    const origin =
      typeof globalThis !== 'undefined' && (globalThis as { location?: { origin?: string } }).location?.origin
        ? (globalThis as { location: { origin: string } }).location.origin
        : 'http://localhost';
    const url = new URL(this.base + path, isAbsolute ? undefined : origin);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    // Preserve a relative base in the returned string so the browser hits the
    // proxy path, not an absolute origin it may not be served from.
    return isAbsolute ? url.toString() : url.pathname + url.search;
  }

  private async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const target = this.buildUrl(path, query);
    const token = this.getToken();
    const res = await this.fetchImpl(target, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`Gateway ${path} → ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = this.getToken();
    const res = await this.fetchImpl(this.base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gateway ${path} → ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  getFacilities(role?: Role): Promise<Facility[]> {
    return this.get('/api/facilities', { role });
  }
  getTerminals(): Promise<Terminal[]> {
    return this.get('/api/terminals');
  }
  getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    return this.post('/api/container-movements', filter);
  }
  getGateOps(window: TimeWindow): Promise<GateOpsDTO[]> {
    return this.get('/api/gate-ops', { from: window.from, to: window.to });
  }
  getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO> {
    return this.get(`/api/gate-queue-forecast/${encodeURIComponent(gateId)}`);
  }
  getPendency(byFacility?: boolean): Promise<PendencyDTO[]> {
    return this.get('/api/pendency', { byFacility: byFacility ? 'true' : undefined });
  }
  getRailSide(siding: SidingId, window: TimeWindow): Promise<RailSideDTO> {
    return this.get(`/api/rail-side/${siding}`, { from: window.from, to: window.to });
  }
  getRakeForecast(rakeId: string): Promise<RakeForecastDTO> {
    return this.get(`/api/rake-forecast/${encodeURIComponent(rakeId)}`);
  }
  getITRHO(window: TimeWindow): Promise<ITRHOMovement[]> {
    return this.get('/api/itrho', { from: window.from, to: window.to });
  }
  getScanQueue(): Promise<ScanEvent[]> {
    return this.get('/api/scan-queue');
  }
  getEmptyPool(): Promise<EmptyPoolDTO> {
    return this.get('/api/empty-pool');
  }
  getKPIs(): Promise<KpiResult[]> {
    return this.get('/api/kpis');
  }
  getNotifications(role: Role): Promise<Notification[]> {
    return this.get('/api/notifications', { role });
  }
  getIntegrationHealth(): Promise<IntegrationHealth[]> {
    return this.get('/api/integration-health');
  }
  runScenario(id: string, params: ScenarioParams): Promise<ScenarioResultDTO> {
    return this.post(`/api/scenarios/${encodeURIComponent(id)}`, params);
  }
}
