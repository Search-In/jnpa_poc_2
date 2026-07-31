/**
 * Poc3CargoAdapter — a transparent decorator around the real DataAdapter (mock
 * or live) that re-sources the entire cargo lifecycle from the POC-3 shared Cargo
 * API. Reads (`GET /api/cargo`, `GET /api/cargo/{id}`) and writes (`POST`, `PUT`,
 * `DELETE /api/cargo/{id}`) all go to the single common backend; every other
 * method delegates to the wrapped base adapter, so the non-cargo panels (gate,
 * rail, KPIs, …) keep their existing behaviour while cargo becomes a single
 * source of truth. POC-2 owns no cargo store.
 *
 * Contract (POC-3 gateway/routers/cargo.py — do NOT change on the backend):
 *   POST   /api/cargo                    → 201 (409 on duplicate)
 *   GET    /api/cargo                    → 200 list (filter + paginate)
 *   GET    /api/cargo/{container_number} → 200 one (404 if absent)
 *   PUT    /api/cargo/{container_number} → 200 updated (404 if absent)  [NOT PATCH]
 *   DELETE /api/cargo/{container_number} → 200 deleted (404 if absent)
 *
 * Every request carries `Authorization: Bearer <POC-3 JWT>` when a token is
 * available (the deployed gateway runs with AUTH_ENABLED). On a 401 the adapter
 * re-mints the token once (via {@link Poc3CargoAdapterDeps.refreshToken}) and
 * retries, so an expired/absent token self-heals instead of surfacing as an error.
 */
import type {
  Facility, IntegrationHealth, ITRHOMovement, KpiResult, Notification, Role,
  ScanEvent, SidingId, Terminal,
} from '@jnpa/schemas';
import { isValidContainerNo } from '@jnpa/schemas';
import type {
  CargoCreateInput,
  CargoLifecycleEvent,
  CargoNotification,
  CargoNotificationCreateInput,
  CargoNotificationFilter,
  CargoRecord,
  CargoUpdateInput,
  CargoWorkflowActionInput,
  CargoWorkflowHistoryEntry,
  CargoWorkflowState,
  ContainerMovementDTO,
  ContainerMovementFilter,
  DataAdapter,
  EmptyPoolDTO,
  GateOpsDTO,
  GateQueueForecastDTO,
  LiveVesselDTO,
  PendencyDTO,
  RailSideDTO,
  RakeForecastDTO,
  RakePlan,
  RakePlanInput,
  ReeferPlan,
  ReeferPlanInput,
  ScenarioParams,
  ScenarioResultDTO,
  TimeWindow,
  YardOptimization,
  YardPlanningInput,
  YardPlanningResult,
} from './interface.js';
import { mapCargoToMovement, mapCargoToScanEvent } from './cargo-mapper.js';

/**
 * Typed error for every non-2xx response from the POC-3 Cargo API. Carries the
 * HTTP `status` so the UI can render a specific message per case (401/404/409/500)
 * and `userMessage` gives that ready-made, human-readable string.
 */
export class CargoApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail?: string;

  constructor(status: number, path: string, detail?: string) {
    super(`POC-3 Cargo API ${path} → ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'CargoApiError';
    this.status = status;
    this.path = path;
    this.detail = detail;
  }

  /** A human-readable message for the panel notices, keyed on the HTTP status. */
  get userMessage(): string {
    switch (this.status) {
      case 401:
        return 'Not authorised — the Cargo API session could not be established. Reload to re-authenticate with POC-3.';
      case 403:
        return 'Your role is not permitted to perform this Cargo operation.';
      case 404:
        return 'Container not found in the shared Cargo backend.';
      case 409:
        return 'A cargo record with this container number already exists.';
      case 400:
        return this.detail || 'Invalid cargo details — check the container number (ISO-6346) and field values.';
      case 500:
        return 'The shared Cargo backend encountered an error. Please retry.';
      default:
        return this.detail || `Cargo request failed (HTTP ${this.status}).`;
    }
  }
}

export interface Poc3CargoAdapterDeps {
  /** Base URL of the POC-3 gateway. Relative (e.g. "/poc3" behind a dev proxy) or absolute. */
  cargoBaseUrl: string;
  /** Returns the current bearer token when the gateway runs with AUTH_ENABLED. */
  getToken?: () => string | undefined;
  /** Persist a token freshly minted after a 401 so later calls reuse it. */
  setToken?: (token: string | undefined) => void;
  /** Re-mint a POC-3 JWT (called once on a 401 before retrying the request). */
  refreshToken?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
}

export class Poc3CargoAdapter implements DataAdapter {
  private base: DataAdapter;
  private cargoBase: string;
  private getToken: () => string | undefined;
  private setToken: (token: string | undefined) => void;
  private refreshToken?: () => Promise<string | undefined>;
  private fetchImpl: typeof fetch;

  constructor(base: DataAdapter, deps: Poc3CargoAdapterDeps) {
    this.base = base;
    this.cargoBase = deps.cargoBaseUrl.replace(/\/$/, '');
    this.getToken = deps.getToken ?? (() => undefined);
    this.setToken = deps.setToken ?? (() => {});
    this.refreshToken = deps.refreshToken;
    // Keep `fetch` bound to its global (a bare property call throws "Illegal
    // invocation" in the browser). Mirrors LiveAdapter.
    this.fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /** Cargo now comes from POC-3, but the wrapped base still labels the app mode. */
  get mode() {
    return this.base.mode;
  }

  // -- POC-3 fetch plumbing ----------------------------------------------------
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

  /**
   * Single request entry point: attaches the bearer token to EVERY call, and on a
   * 401 re-mints the token once and retries so an absent/expired token self-heals
   * (this is what guarantees no cargo request is left permanently unauthenticated).
   * Callers map the returned Response; a non-ok status becomes a {@link CargoApiError}.
   */
  private async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, opts.query);
    const send = (token: string | undefined) =>
      this.fetchImpl(url, {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      });

    let res = await send(this.getToken());
    // Self-heal a 401: re-mint the POC-3 JWT once, store it, and retry the request
    // with the fresh bearer. Covers the initial-race and token-expiry cases.
    if (res.status === 401 && this.refreshToken) {
      const fresh = await this.refreshToken();
      if (fresh) {
        this.setToken(fresh);
        res = await send(fresh);
      }
    }
    return res;
  }

  /** Throw a typed error for a non-ok response, extracting the backend `detail`. */
  private static async fail(res: Response, path: string): Promise<never> {
    let detail: string | undefined;
    try {
      const body = (await res.json()) as { detail?: unknown };
      detail = typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : undefined;
    } catch {
      /* non-JSON error body — status alone drives the message */
    }
    throw new CargoApiError(res.status, path, detail);
  }

  private async getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const res = await this.request('GET', path, { query });
    if (!res.ok) return Poc3CargoAdapter.fail(res, path);
    return (await res.json()) as T;
  }

  /** POST/PUT with a JSON body; both return the affected CargoRecord. */
  private async writeJson<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    const res = await this.request(method, path, { body });
    if (!res.ok) return Poc3CargoAdapter.fail(res, path);
    return (await res.json()) as T;
  }

  // -- reads (GET /api/cargo, GET /api/cargo/{id}) ----------------------------
  async getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    // Container Search: an exact ISO-6346 lookup goes to the single-record
    // endpoint (never a local array scan). A 404 is an empty result, not an
    // error, so the panel shows its graceful empty state.
    if (filter.containerNo) {
      const norm = filter.containerNo.trim().toUpperCase().replace(/\s+/g, '');
      if (!isValidContainerNo(norm)) return [];
      try {
        const one = await this.getJson<CargoRecord>(`/api/cargo/${encodeURIComponent(norm)}`);
        return [mapCargoToMovement(one)];
      } catch (err) {
        if (err instanceof CargoApiError && err.status === 404) return [];
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

  // -- create (POST /api/cargo → 201) -----------------------------------------
  async createCargo(record: CargoCreateInput): Promise<ContainerMovementDTO> {
    const body: CargoCreateInput = {
      ...record,
      container_number: record.container_number.trim().toUpperCase().replace(/\s+/g, ''),
    };
    const created = await this.writeJson<CargoRecord>('POST', '/api/cargo', body);
    return mapCargoToMovement(created);
  }

  // -- update (PUT /api/cargo/{id} → 200) -------------------------------------
  /**
   * Update the EXISTING cargo record with only the required fields (e.g.
   * `{ yard_block }` on discharge, `{ is_released: true }` on release). The
   * backend exposes PUT for updates (PATCH is not supported), and applies a
   * partial update via `exclude_unset`, so a single-field body works.
   */
  async updateCargo(containerNo: string, patch: CargoUpdateInput): Promise<ContainerMovementDTO> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    const updated = await this.writeJson<CargoRecord>('PUT', `/api/cargo/${encodeURIComponent(norm)}`, patch);
    return mapCargoToMovement(updated);
  }

  // -- delete (DELETE /api/cargo/{id} → 200) ----------------------------------
  async deleteCargo(containerNo: string): Promise<void> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    const path = `/api/cargo/${encodeURIComponent(norm)}`;
    const res = await this.request('DELETE', path);
    if (!res.ok) await Poc3CargoAdapter.fail(res, path);
  }

  // -- POC-3 extended Cargo APIs (Jayesh handover — additive) ----------------
  //
  // Every method below reuses the SAME request()/getJson()/writeJson() plumbing
  // as the core cargo CRUD, so each call carries the bearer token and self-heals a
  // 401 exactly like the reads/writes above. POC-3 owns all the business logic;
  // these are thin, faithful consumers. GET list endpoints tolerate either a bare
  // array or a `{ items | data | results: [...] }` envelope so a paginated wrapper
  // does not break the panels.

  /** Normalise a list response that may be a bare array or a common list envelope. */
  private static asList<T>(body: unknown): T[] {
    if (Array.isArray(body)) return body as T[];
    if (body && typeof body === 'object') {
      const o = body as Record<string, unknown>;
      for (const key of ['items', 'data', 'results', 'notifications', 'events', 'plans', 'history']) {
        if (Array.isArray(o[key])) return o[key] as T[];
      }
    }
    return [];
  }

  private async getList<T>(path: string, query?: Record<string, string | undefined>): Promise<T[]> {
    const res = await this.request('GET', path, { query });
    if (!res.ok) return Poc3CargoAdapter.fail(res, path);
    return Poc3CargoAdapter.asList<T>(await res.json());
  }

  // 1) Stakeholder Notification APIs (UC2 intended-use 2) ---------------------
  async createCargoNotification(input: CargoNotificationCreateInput): Promise<CargoNotification> {
    return this.writeJson<CargoNotification>('POST', '/api/cargo/notifications', input);
  }
  async getCargoNotifications(filter: CargoNotificationFilter = {}): Promise<CargoNotification[]> {
    return this.getList<CargoNotification>('/api/cargo/notifications', {
      severity: filter.severity,
      status: filter.status,
      stakeholder: filter.stakeholder,
      container_number: filter.container_number,
      limit: filter.limit == null ? undefined : String(filter.limit),
      offset: filter.offset == null ? undefined : String(filter.offset),
    });
  }

  // 2) Workflow APIs (UC2 automated workflows) --------------------------------
  async triggerCargoWorkflow(containerNo: string, input: CargoWorkflowActionInput): Promise<CargoWorkflowState> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.writeJson<CargoWorkflowState>('POST', `/api/cargo/${encodeURIComponent(norm)}/workflow`, input);
  }
  async getCargoWorkflowHistory(containerNo: string): Promise<CargoWorkflowHistoryEntry[]> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.getList<CargoWorkflowHistoryEntry>(`/api/cargo/${encodeURIComponent(norm)}/workflow/history`);
  }

  // 3) + 4) Yard Planning / Optimization (UC2-R5 yard planning) ---------------
  /**
   * The deployed POC-3 yard-planning contract expects `preferred_block` to be the
   * ZONE LETTER only (e.g. "B"), not a full block/slot value like "A-12" (verified
   * from the API's "expected a letter zone" validation error). This reduces the
   * incoming block value to its leading zone letter(s) in the REQUEST PAYLOAD ONLY —
   * the UI is untouched, and every other API (yard-assignment, cargo update, etc.)
   * keeps using the full `yard_block` value.
   */
  private static yardZone(block: string): string {
    const norm = block.trim().toUpperCase();
    return norm.match(/^[A-Z]+/)?.[0] ?? norm; // "A-12" → "A", "B" → "B"
  }
  async createYardPlan(input: YardPlanningInput): Promise<YardPlanningResult> {
    const body: YardPlanningInput = {
      ...input,
      container_number: input.container_number.trim().toUpperCase().replace(/\s+/g, ''),
      ...(input.preferred_block != null ? { preferred_block: Poc3CargoAdapter.yardZone(input.preferred_block) } : {}),
    };
    return this.writeJson<YardPlanningResult>('POST', '/api/cargo/yard-planning', body);
  }
  async getYardOptimization(): Promise<YardOptimization> {
    return this.getJson<YardOptimization>('/api/cargo/yard-optimization');
  }

  // 5) Rail Rake Planning APIs (UC2-R5 CTO/FOIS rake visibility) --------------
  async createRakePlan(input: RakePlanInput): Promise<RakePlan> {
    return this.writeJson<RakePlan>('POST', '/api/cargo/rake-planning', input);
  }
  async getRakePlans(): Promise<RakePlan[]> {
    return this.getList<RakePlan>('/api/cargo/rake-planning');
  }

  // 6) Reefer Planning API ----------------------------------------------------
  async createReeferPlan(input: ReeferPlanInput): Promise<ReeferPlan> {
    const body: ReeferPlanInput = {
      ...input,
      container_number: input.container_number.trim().toUpperCase().replace(/\s+/g, ''),
    };
    return this.writeJson<ReeferPlan>('POST', '/api/cargo/reefer-planning', body);
  }

  // 7) Cargo Lifecycle Events -------------------------------------------------
  async getCargoEvents(containerNo?: string): Promise<CargoLifecycleEvent[]> {
    const norm = containerNo?.trim().toUpperCase().replace(/\s+/g, '');
    return this.getList<CargoLifecycleEvent>('/api/cargo/events', norm ? { container_number: norm } : undefined);
  }

  // 8) Marine API — Live Vessels -----------------------------------------------
  /**
   * Fetch live AIS vessel data from the marine API. Uses the same request plumbing
   * as cargo calls, so the bearer token is attached and 401 self-heals automatically.
   */
  async getLiveVessels(): Promise<LiveVesselDTO[]> {
    return this.getList<LiveVesselDTO>('/api/marine/vessels/live');
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
  /**
   * The customs scan queue is re-sourced from POC-3 cargo too (single source of
   * truth): every row is a real, in-port (not-yet-released) container, so the
   * panel's Release write (`PUT /api/cargo/{id} { is_released: true }`) always
   * targets an existing record instead of a simulated one that 404s.
   */
  async getScanQueue(): Promise<ScanEvent[]> {
    const rows = await this.getJson<CargoRecord[]>('/api/cargo', {
      is_released: 'false',
      limit: '100',
      offset: '0',
    });
    return rows.map(mapCargoToScanEvent);
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
