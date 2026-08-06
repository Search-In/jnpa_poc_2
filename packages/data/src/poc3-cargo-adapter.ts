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
  AdvanceListContainer,
  AdvanceListFilter,
  CfsEcyChainStats,
  CfsEcyDwellItem,
  CfsEcyFacility,
  CfsEcyStats,
  ContainerMovementDTO,
  ContainerMovementFilter,
  DataAdapter,
  EdoDetail,
  EdoRecord,
  EirTransaction,
  EmptyPoolDTO,
  GateMovement,
  GateMovementGate,
  GateOpsDTO,
  GateQueueForecastDTO,
  IgmContainer,
  IgmContainerFilter,
  IgmManifest,
  LiveVesselDTO,
  OocDetail,
  OocRecord,
  PendencyDTO,
  PinTicket,
  RailSideDTO,
  RakeForecastDTO,
  RakePlan,
  RakePlanInput,
  ReeferPlan,
  ReeferPlanInput,
  RmsScanContainer,
  RmsScanList,
  ScenarioParams,
  ScenarioResultDTO,
  CoarriMove,
  CoprarItem,
  Form11Entry,
  ShippingBillRecord,
  SourceGateDocument,
  SyntheticChain,
  VesselCutoff,
  VesselDeparture,
  TerminalYardStatus,
  LeoRecord,
  SmtpRecord,
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
  /**
   * Current data-SOURCE mode — the provenance filter the backend applies via the
   * `X-Data-Mode` header. 'LIVE' returns JNPA-API-sourced rows, 'DEMO' the
   * manually-imported pre-loaded rows. When omitted (or it returns undefined) no
   * header is sent and the backend leaves the data unfiltered.
   */
  getDataMode?: () => 'LIVE' | 'DEMO' | undefined;
  fetchImpl?: typeof fetch;
}

export class Poc3CargoAdapter implements DataAdapter {
  private base: DataAdapter;
  private cargoBase: string;
  private getToken: () => string | undefined;
  private setToken: (token: string | undefined) => void;
  private refreshToken?: () => Promise<string | undefined>;
  private getDataMode: () => 'LIVE' | 'DEMO' | undefined;
  private fetchImpl: typeof fetch;

  constructor(base: DataAdapter, deps: Poc3CargoAdapterDeps) {
    this.base = base;
    this.cargoBase = deps.cargoBaseUrl.replace(/\/$/, '');
    this.getToken = deps.getToken ?? (() => undefined);
    this.setToken = deps.setToken ?? (() => {});
    this.refreshToken = deps.refreshToken;
    this.getDataMode = deps.getDataMode ?? (() => undefined);
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
    // Data-source provenance filter (LIVE = JNPA-API rows, DEMO = pre-loaded).
    // Omitted when unset so the backend leaves the data unfiltered.
    const dataMode = this.getDataMode();
    const send = (token: string | undefined) =>
      this.fetchImpl(url, {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(dataMode ? { 'x-data-mode': dataMode } : {}),
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

  /**
   * In-flight GET de-duplication. Two identical GETs issued before the first
   * settles share one network request and one parsed result.
   *
   * This is what stops React 18 StrictMode's deliberate mount→unmount→remount
   * from firing every panel's fetch twice in development. It is NOT a response
   * cache: the entry is dropped as soon as the request settles, so a refetch
   * after a write still goes to the network and always sees fresh data.
   *
   * GET only — writes must never be collapsed, since two POSTs are two intents.
   */
  private readonly inflightGets = new Map<string, Promise<unknown>>();

  private dedupeGet<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflightGets.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = run().finally(() => {
      this.inflightGets.delete(key);
    });
    this.inflightGets.set(key, pending);
    return pending;
  }

  private async getJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    return this.dedupeGet(`GET ${this.buildUrl(path, query)}`, async () => {
      const res = await this.request('GET', path, { query });
      if (!res.ok) return Poc3CargoAdapter.fail(res, path);
      return (await res.json()) as T;
    });
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
    return this.dedupeGet(`GET ${this.buildUrl(path, query)}`, async () => {
      const res = await this.request('GET', path, { query });
      if (!res.ok) return Poc3CargoAdapter.fail(res, path);
      return Poc3CargoAdapter.asList<T>(await res.json());
    });
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

  // 8) Customs API — IGM (Import General Manifest, ICEGATE CHPOI03) -----------
  /**
   * Step 1 of the import container lifecycle: the manifests the shipping lines
   * filed before arrival, and the containers declared on each. Served by the
   * POC-3 customs layer, which parses the official CHPOI03 XML — nothing here is
   * synthesised. Both endpoints return the `{items, total, limit, offset, count}`
   * page envelope, which getList() already unwraps via its `items` key.
   *
   * NOTE: `/api/customs` is RBAC-scoped to CONTROL_ROOM + CUSTOMS on POC-3, so a
   * token minted for another role gets a 403 and the panel shows that message.
   */
  async getIgmManifests(filter: IgmContainerFilter = {}): Promise<IgmManifest[]> {
    return this.getList<IgmManifest>('/api/customs/igm', {
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    });
  }

  /**
   * Containers on one manifest. POC-3 caps this endpoint at 2000 rows per page but
   * a real manifest can declare more (the largest in the corpus declares 2 794), so
   * an explicit `limit` fetches exactly that page while the default pages through
   * until the manifest is exhausted. Without this the drill-down would silently
   * truncate a large manifest and read as if it had fewer containers than it does.
   */
  async getIgmContainers(igmNo: string | number, filter: IgmContainerFilter = {}): Promise<IgmContainer[]> {
    const key = encodeURIComponent(String(igmNo).trim());
    const path = `/api/customs/igm/${key}/containers`;
    const PAGE = 2000; // the backend's documented per-request maximum

    // Caller asked for a specific page — honour it verbatim, no paging.
    if (filter.limit != null) {
      return this.getList<IgmContainer>(path, {
        limit: String(filter.limit),
        offset: String(filter.offset ?? 0),
      });
    }

    const all: IgmContainer[] = [];
    let offset = filter.offset ?? 0;
    // Bounded so a backend that ignores `offset` can never spin forever.
    for (let page = 0; page < 20; page += 1) {
      const batch = await this.getList<IgmContainer>(path, {
        limit: String(PAGE),
        offset: String(offset),
      });
      all.push(...batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    return all;
  }

  // 9) Customs API — RMS container scanning -----------------------------------
  /**
   * The scanning branch that applies between discharge and delivery. A list with
   * `selected_count: 0` is a real outcome ("No container selected for scanning"),
   * so an empty container response is never treated as an error here.
   */
  async getRmsScanLists(filter: IgmContainerFilter = {}): Promise<RmsScanList[]> {
    return this.getList<RmsScanList>('/api/customs/rms', {
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    });
  }

  async getRmsScanContainers(igmNo: string | number, filter: IgmContainerFilter = {}): Promise<RmsScanContainer[]> {
    const key = encodeURIComponent(String(igmNo).trim());
    return this.getList<RmsScanContainer>(`/api/customs/rms/${key}/containers`, {
      limit: String(filter.limit ?? 500),
      offset: String(filter.offset ?? 0),
    });
  }

  // 10) Customs API — OOC (Bill of Entry / Out-Of-Charge) ---------------------
  /** The Bills of Entry with their customs-release (out-of-charge) facts. */
  async getOocRecords(filter: IgmContainerFilter = {}): Promise<OocRecord[]> {
    return this.getList<OocRecord>('/api/customs/ooc', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  /**
   * One BE with its containers and every invoice line item. A 404 (unknown BE)
   * resolves to null so the caller renders an empty state, not an error.
   */
  async getOocDetail(beNo: string | number): Promise<OocDetail | null> {
    const key = encodeURIComponent(String(beNo).trim());
    try {
      return await this.getJson<OocDetail>(`/api/customs/ooc/${key}/items`);
    } catch (err) {
      if (err instanceof CargoApiError && err.status === 404) return null;
      throw err;
    }
  }

  // 11) Shipping-lines API — E-DO (Electronic Delivery Order) -----------------
  /** The delivery orders that authorise release of a container to its consignee. */
  async getEdoRecords(filter: IgmContainerFilter = {}): Promise<EdoRecord[]> {
    return this.getList<EdoRecord>('/api/shipping-lines/edo', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  /** One DO with its container lines. A 404 resolves to null (unknown DO). */
  async getEdoDetail(doNumber: string): Promise<EdoDetail | null> {
    const key = encodeURIComponent(String(doNumber).trim());
    try {
      return await this.getJson<EdoDetail>(`/api/shipping-lines/edo/${key}`);
    } catch (err) {
      if (err instanceof CargoApiError && err.status === 404) return null;
      throw err;
    }
  }

  // 12) Gate-documents API — EIR gate transactions ----------------------------
  /**
   * The truck-level gate transactions. Terminal is free text on the EIR
   * ("Gateway (GTI)"), so callers match it against a terminal code themselves
   * rather than relying on an exact-match server filter.
   */
  async getEirTransactions(filter: IgmContainerFilter = {}): Promise<EirTransaction[]> {
    return this.getList<EirTransaction>('/api/gate-docs/eir', {
      limit: String(filter.limit ?? 500),
      offset: String(filter.offset ?? 0),
    });
  }

  /** The terminal pickup tickets (PIN) a trucker presents at the gate. */
  async getPinTickets(filter: IgmContainerFilter = {}): Promise<PinTicket[]> {
    return this.getList<PinTicket>('/api/gate-docs/pin', {
      limit: String(filter.limit ?? 500),
      offset: String(filter.offset ?? 0),
    });
  }

  // 13) Shipping-lines API — CODECO gate-out movements ------------------------
  /**
   * The final lifecycle step: the box leaving on a truck. Read straight from the
   * CODECO messages rather than through the delivery-order join, because a
   * container can be gated out with no E-DO on file.
   */
  async getGateMovementGates(): Promise<GateMovementGate[]> {
    const body = await this.getJson<{ gates?: GateMovementGate[] }>('/api/shipping-lines/gates');
    return Array.isArray(body?.gates) ? body.gates : [];
  }

  /**
   * `gateId` is the dashboard gate identifier (terminal code + gate number, e.g.
   * "NSICT-G1"); it is split into the two filters the API expects. Pass "ALL" (or
   * nothing) for every gate. A gate id that does not split simply falls back to a
   * gate-number filter, so an unexpected shape degrades rather than erroring.
   */
  async getGateMovements(gateId?: string, filter: IgmContainerFilter = {}): Promise<GateMovement[]> {
    const raw = (gateId ?? '').trim();
    const scoped = raw && raw.toUpperCase() !== 'ALL';
    const split = scoped ? /^(.*)-G(\w+)$/i.exec(raw) : null;
    return this.getList<GateMovement>('/api/shipping-lines/gate-movements', {
      terminal_code: split ? split[1] : undefined,
      gate_no: split ? split[2] : (scoped ? raw : undefined),
      limit: String(filter.limit ?? 500),
      offset: String(filter.offset ?? 0),
    });
  }

  // 12b) Shipping-lines API — advance lists (IAL / EAL) ----------------------
  /**
   * The terminal load list. `list_type: 'EAL'` gives the export side — 5,743 rows
   * across 5 vessel visits. Filters are applied server-side, so a container search
   * hits the whole list rather than the loaded page.
   */
  async getAdvanceList(filter: AdvanceListFilter = {}): Promise<AdvanceListContainer[]> {
    return this.getList<AdvanceListContainer>('/api/shipping-lines', {
      list_type: filter.list_type,
      terminal: filter.terminal,
      category: filter.category,
      freight_kind: filter.freight_kind,
      shipping_line: filter.shipping_line,
      container: filter.container,
      bl: filter.bl,
      q: filter.q,
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  // 12b2) Export-chain API — the steps that had no read endpoint ------------
  /** Form 11 rail pre-advice. ⚠ One row per source workbook (templates). */
  async getForm11(container?: string): Promise<Form11Entry[]> {
    return this.getList<Form11Entry>('/api/export-chain/form11', { container, limit: '200' });
  }

  /** COPRAR advance load list. ⚠ Corpus sample is Kolkata/Haldia, not JNPA. */
  async getCoprarItems(): Promise<CoprarItem[]> {
    return this.getList<CoprarItem>('/api/export-chain/load-list', { limit: '200' });
  }

  /**
   * Vessel gate-open / cut-off windows — the EC-1 input.
   * ⚠ Vessel-level only; see the note on VesselCutoff before adding a per-box column.
   */
  async getVesselCutoffs(): Promise<VesselCutoff[]> {
    return this.getList<VesselCutoff>('/api/export-chain/cutoffs', { limit: '300' });
  }

  /** COARRI load confirmations. ⚠ Corpus sample is Vizag; 150 of 200 items landed. */
  async getCoarriMoves(): Promise<CoarriMove[]> {
    return this.getList<CoarriMove>('/api/export-chain/load-confirmations', { limit: '200' });
  }

  /**
   * Vessel departures — the final export step. Served by the EXISTING
   * `/api/marine/calls`, filtered client-side to calls with a real `atd`, since
   * the endpoint has no has-departed filter.
   */
  async getVesselDepartures(): Promise<VesselDeparture[]> {
    const all = await this.getList<VesselDeparture>('/api/marine/calls', { limit: '500' });
    return all
      .filter((c) => !!c.atd)
      .sort((a, b) => String(b.atd).localeCompare(String(a.atd)));
  }

  /**
   * ⚠⚠ SYNTHETIC chains. The response envelope carries `synthetic: true` and a
   * `notice`; both are asserted here so a backend that ever stopped stamping them
   * fails loudly rather than leaking unlabelled demo data into the UI.
   */
  async getSyntheticChains(): Promise<SyntheticChain[]> {
    const body = await this.getJson<{ synthetic?: boolean; items?: SyntheticChain[] }>(
      '/api/export-chain/synthetic', { limit: '100' });
    if (body?.synthetic !== true) {
      throw new Error('Refusing to render /api/export-chain/synthetic: the response is not stamped synthetic:true.');
    }
    return Array.isArray(body.items) ? body.items : [];
  }

  // 12c) Gate-docs API — parsed source documents ----------------------------
  /**
   * The customer's own Form 13 / EIR / PIN documents, as filed.
   *
   * ⚠ Deliberately NOT `/api/gate-docs/form13`: that endpoint reads
   * `core.gate_capture`, where 202 of 203 rows are seeded and carry synthetic
   * shipping-bill numbers. Anything presented as document evidence must come
   * from here.
   */
  async getSourceGateDocuments(category?: string, container?: string): Promise<SourceGateDocument[]> {
    return this.getList<SourceGateDocument>('/api/gate-docs/documents', {
      category, container, limit: '100',
    });
  }

  // 13a) Performance API — terminal yard / pendency snapshot -----------------
  /**
   * Detection signal for the yard-congestion edge case (WS1 EC-3): utilisation
   * per terminal plus the pendency ledger, from the JNPA daily status reports.
   * Omit `reportDate` for the latest published day.
   */
  async getTerminalYardStatus(reportDate?: string): Promise<TerminalYardStatus[]> {
    return this.getList<TerminalYardStatus>('/api/performance/daily/status', {
      date: reportDate,
      limit: '50',
    });
  }

  // 13b) Customs API — export documents (Shipping Bill, LEO, SMTP) -----------
  /**
   * The three customs families that had no client until now (WS4 §2).
   *
   * ⚠ `getShippingBills` and `getLeoRecords` return DISJOINT document sets: the
   * filed SBs and the granted LEOs share no `sb_no` in this dataset. Never join
   * them client-side and never render one as the other's status.
   */
  async getShippingBills(filter: IgmContainerFilter = {}): Promise<ShippingBillRecord[]> {
    return this.getList<ShippingBillRecord>('/api/customs/shipping-bills', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  async getLeoRecords(filter: IgmContainerFilter = {}): Promise<LeoRecord[]> {
    return this.getList<LeoRecord>('/api/customs/leo', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  async getSmtpRecords(filter: IgmContainerFilter = {}): Promise<SmtpRecord[]> {
    return this.getList<SmtpRecord>('/api/customs/smtp', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  // 14) CFS/ECY API — off-dock gate movements --------------------------------
  /**
   * Port-wide throughput and dwell for the off-dock leg (ECY → CFS → terminal).
   *
   * ⚠ These three calls return POPULATION statistics only. The CFS/ECY feed shares
   * no container numbers with the manifests, advance lists or gate documents in the
   * same corpus, so nothing here may be joined to, or drilled into from, a named
   * container elsewhere in the dashboard. See markdowns/04_Export_Build_Plan.md §1.1.
   */
  async getCfsEcyStats(facility?: CfsEcyFacility): Promise<CfsEcyStats> {
    return this.getJson<CfsEcyStats>('/api/cfs-ecy/stats', { facility });
  }

  /**
   * Chain KPIs. `by_anomaly` is absent when nothing is anomalous, so it is
   * normalised to an array here rather than at every call site.
   */
  async getCfsEcyChainStats(): Promise<CfsEcyChainStats> {
    const body = await this.getJson<CfsEcyChainStats>('/api/cfs-ecy/chains/stats');
    return { ...body, by_anomaly: Array.isArray(body?.by_anomaly) ? body.by_anomaly : [] };
  }

  /** Per-container CFS dwell rows. Paged like the other list endpoints. */
  async getCfsEcyDwell(filter: IgmContainerFilter = {}): Promise<CfsEcyDwellItem[]> {
    return this.getList<CfsEcyDwellItem>('/api/cfs-ecy/dwell', {
      limit: String(filter.limit ?? 200),
      offset: String(filter.offset ?? 0),
    });
  }

  // 15) Marine API — Live Vessels ----------------------------------------------
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
