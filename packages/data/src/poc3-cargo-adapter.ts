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
  EmptyTrtOverview,
  EmptyTrtChain,
  EmptyTrtChainFilter,
  EmptyTrtAnomalyDetail,
  EmptyTrtContainerDetail,
  DqSummary,
  DqIssue,
  DqFilter,
  CfsEcyFacility,
  CfsEcyStats,
  ContainerMovementDTO,
  ContainerMovementFilter,
  DataAdapter,
  EdoDetail,
  EdoRecord,
  EirTransaction,
  EmptyPoolDTO,
  GateEvent,
  GateEventFilter,
  GateMovement,
  GateMovementGate,
  GateOpsDTO,
  GateQueueForecastDTO,
  IgmContainer,
  IgmContainerFilter,
  IgmManifest,
  JnpaApiDefect,
  JnpaApiHealth,
  JnpaApiRun,
  LiveVesselDTO,
  OocDetail,
  ContainerCustomsView,
  ContainerGateDocs,
  UploadTarget,
  UploadResult,
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
 * The structured `detail` object the POC-3 gateway returns on a 4xx
 * (`gateway/routers/cargo.py`). `error` names WHICH situation this is — the same
 * HTTP status covers several — and the backend's own operator-ready sentence, when
 * it wrote one, arrives under `message` (the customs gate) or a NESTED `detail`
 * (the 400 validation_error). Both spellings are read; neither is guaranteed.
 */
export interface CargoErrorDetail {
  error?: string;
  message?: string;
  detail?: string;
  container_number?: string;
  customs_status?: string;
  current_status?: string;
  attempted_status?: string;
}

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

  /**
   * The backend's `detail` parsed back into the object it was sent as.
   * {@link Poc3CargoAdapter.fail} JSON-stringifies a structured detail so `detail`
   * stays a plain string for logging; the messages below need the fields back.
   */
  private get parsedDetail(): CargoErrorDetail | undefined {
    if (!this.detail || this.detail[0] !== '{') return undefined;
    try {
      const parsed: unknown = JSON.parse(this.detail);
      return parsed && typeof parsed === 'object' ? parsed as CargoErrorDetail : undefined;
    } catch {
      return undefined; /* not JSON after all — the raw string is the message */
    }
  }

  /**
   * The backend's own sentence, wherever it put it — `message` (the customs gate)
   * or a nested `detail` (the 400 validation_error) — else the raw detail string
   * when it was never structured. Never the JSON blob: a structured detail with
   * neither field has nothing human-readable in it, so the caller's own wording
   * is the better answer than showing the operator a serialised object.
   */
  private get detailMessage(): string | undefined {
    const d = this.parsedDetail;
    if (!d) return this.detail;
    return d.message ?? (typeof d.detail === 'string' ? d.detail : undefined);
  }

  /**
   * 409 is SEVERAL different situations on this API, and reporting them all as a
   * duplicate record sent operators looking for a duplicate that did not exist.
   *
   *   duplicate_container  POST /api/cargo only — the record already exists.
   *   customs_not_cleared  release refused because customs holds or is examining
   *                        the goods. NOT a lifecycle fault: the box has passed
   *                        every port gate, it is the goods that may not leave.
   *   illegal_transition   a lifecycle gate ahead of this one has not been passed.
   *
   * The customs case ships its own operator-ready sentence, so prefer the
   * backend's wording verbatim rather than paraphrasing it out of sync here.
   */
  private get conflictMessage(): string {
    const d = this.parsedDetail;
    const written = this.detailMessage;
    if (written) return written;
    switch (d?.error) {
      case 'duplicate_container':
        return 'A cargo record with this container number already exists.';
      case 'customs_not_cleared':
        return 'Customs has not released these goods'
          + `${d.customs_status ? ` (customs status ${d.customs_status})` : ''} — a container `
          + 'that is held or under examination cannot be released from the port.';
      case 'illegal_transition':
        return `This container is ${d.current_status || 'not in a state'} and cannot advance `
          + `to ${d.attempted_status || 'the requested state'} — the lifecycle gate before it `
          + 'has not been passed yet.';
      default:
        return "This operation conflicts with the container's current state.";
    }
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
        return this.conflictMessage;
      case 400:
        return this.detailMessage || 'Invalid cargo details — check the container number (ISO-6346) and field values.';
      case 500:
        return 'The shared Cargo backend encountered an error. Please retry.';
      default:
        return this.detailMessage || `Cargo request failed (HTTP ${this.status}).`;
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
  /**
   * The movement list. Every filter — Container Search included — is applied
   * SERVER-SIDE by {@link getContainerMovementsPage}.
   *
   * Search used to take a separate route here: an exact lookup against
   * `/api/cargo/{id}`, gated on the ISO-6346 check digit. That gate has been
   * dropped along with the branch. The New Cargo dialog deliberately accepts
   * numbers whose check digit fails, so validating on the way in made a container
   * you had just created impossible to find — and the failure was silent, because
   * an invalid number returned an empty array indistinguishable from "no match".
   */
  async getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    const { items } = await this.getContainerMovementsPage(filter);
    return items;
  }

  /**
   * The movement list PLUS the filtered row count from the `X-Total-Count` header.
   *
   * `/api/cargo` answers with a bare array, so the count is not in the body — a
   * panel that renders `rows.length` therefore reports its PAGE SIZE (100 by
   * default) as the population, on every filter, forever. Read the header instead.
   *
   * ⚠ `origin_stream` is passed through here. It previously was not, which meant
   * the Movements stream filter changed the UI state and nothing else — the same
   * rows came back every time.
   */
  async getContainerMovementsPage(
    filter: ContainerMovementFilter,
  ): Promise<{ items: ContainerMovementDTO[]; total: number | null }> {
    const query = {
      // Container Search. `/api/cargo` takes `container_number` as an EXACT match,
      // so the search runs server-side over the whole register and the row count in
      // X-Total-Count stays truthful.
      //
      // ⚠ Do not drop this again. The single-record branch in getContainerMovements
      // used to carry the search; when the paged read replaced it, this parameter
      // went with it and Search silently returned page 1 of everything — which
      // reads on screen as "no result".
      //
      // No ISO-6346 pre-check either: the New Cargo dialog deliberately allows
      // numbers that fail the check digit, so validating here would make a container
      // you just created unfindable. Let the server answer.
      container_number: filter.containerNo?.trim().toUpperCase().replace(/\s+/g, '') || undefined,
      customs_status: filter.customsStatus,
      yard_block: filter.yardBlock,
      is_released: filter.isReleased == null ? undefined : String(filter.isReleased),
      vehicle_number: filter.vehicleNumber,
      origin_stream: filter.originStream,
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    };
    const path = '/api/cargo';
    // Routed through dedupeGet like every other GET: two panels mounting at once
    // must still collapse to ONE network call. A distinct key prefix keeps this
    // from colliding with getJson's cache of the same URL, whose cached value is
    // the bare body and carries no header.
    return this.dedupeGet(`PAGE ${this.buildUrl(path, query)}`, async () => {
      const res = await this.request('GET', path, { query });
      if (!res.ok) return Poc3CargoAdapter.fail(res, path);
      const rows = Poc3CargoAdapter.asList<CargoRecord>(await res.json());
      const header = res.headers?.get?.('x-total-count');
      const total = header != null && header !== '' && !Number.isNaN(Number(header))
        ? Number(header)
        : null;
      return { items: rows.map(mapCargoToMovement), total };
    });
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

  /**
   * Same read as `getList`, but KEEPS the `total` from the `Page` envelope.
   *
   * `getList` deliberately flattens to a bare array, which is right for the small
   * registers, but it discards the row count for the paged ones — and a panel that
   * renders `rows.length` against a 5,743-row register then reports its page size
   * as the population. Use this wherever the count is shown on screen.
   *
   * `total` is null when the endpoint answered with a bare array (no envelope), so
   * a caller can tell "not paginated" apart from "0 rows".
   */
  private async getPage<T>(
    path: string,
    query?: Record<string, string | undefined>,
  ): Promise<{ items: T[]; total: number | null }> {
    return this.dedupeGet(`PAGE ${this.buildUrl(path, query)}`, async () => {
      const res = await this.request('GET', path, { query });
      if (!res.ok) return Poc3CargoAdapter.fail(res, path);
      const body: unknown = await res.json();
      const items = Poc3CargoAdapter.asList<T>(body);
      const total = body && typeof body === 'object' && !Array.isArray(body)
        && typeof (body as Record<string, unknown>).total === 'number'
        ? ((body as Record<string, unknown>).total as number)
        : null;
      return { items, total };
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

  // -- data upload (multipart) ----------------------------------------------
  /**
   * POST a multipart upload, reusing the same auth + 401-self-heal as every other
   * call. Note it does NOT go through `request()`: that helper sets a JSON
   * content-type and stringifies the body, and a `FormData` body must be left
   * alone so the browser can set its own multipart boundary.
   */
  private async postForm<T>(path: string, form: FormData): Promise<T> {
    const url = this.buildUrl(path);
    const dataMode = this.getDataMode();
    const send = (token: string | undefined) =>
      this.fetchImpl(url, {
        method: 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(dataMode ? { 'x-data-mode': dataMode } : {}),
        },
        body: form,
      });

    let res = await send(this.getToken());
    if (res.status === 401 && this.refreshToken) {
      const fresh = await this.refreshToken();
      if (fresh) {
        this.setToken(fresh);
        res = await send(fresh);
      }
    }
    if (!res.ok) return Poc3CargoAdapter.fail(res, path);
    return (await res.json()) as T;
  }

  /** Multipart body: the file plus the module's document-kind discriminator. */
  private static uploadForm(target: UploadTarget, file: File): FormData {
    const fd = new FormData();
    fd.append('file', file);
    // Only when the module HAS a discriminator. Customs routes on the filename,
    // so appending an unread field would look like a contract that isn't one.
    if (target.param && target.value != null) fd.append(target.param, target.value);
    return fd;
  }

  /** Dry run — parses and previews, writes nothing. */
  async validateUpload(target: UploadTarget, file: File): Promise<UploadResult> {
    return this.postForm<UploadResult>(
      `/api/${target.module}/validate`, Poc3CargoAdapter.uploadForm(target, file));
  }

  /** Persist — idempotent by row hash, so a re-import cannot duplicate rows. */
  async importUpload(target: UploadTarget, file: File): Promise<UploadResult> {
    return this.postForm<UploadResult>(
      `/api/${target.module}/upload`, Poc3CargoAdapter.uploadForm(target, file));
  }

  // -- discharge (POST /api/cargo/{id}/discharge → 200) ----------------------
  /**
   * The first mandatory lifecycle gate: `CREATED -> VESSEL_DISCHARGED`.
   *
   * A dedicated endpoint rather than `updateCargo`, because the transition is
   * validated by the server's state machine and emits `cargo.vessel_discharged`
   * on the shared bus — the signal UC-III's job assignment depends on. Patching
   * the row directly would move the status without raising the event.
   */
  async dischargeCargo(
    containerNo: string,
    input: { vessel_name?: string; discharge_time?: string } = {},
  ): Promise<{ container_number: string; lifecycle_status: string; status: string }> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.writeJson<{ container_number: string; lifecycle_status: string; status: string }>(
      'POST', `/api/cargo/${encodeURIComponent(norm)}/discharge`, input);
  }

  // 10b) Per-container import chain reads -----------------------------------
  //
  // The two container-keyed lookups the import lifecycle needs. Both are by-value
  // joins on the container number, so an empty array means "no document of this
  // kind names this box" — a fact worth showing, never an error to swallow.

  /**
   * The customs layer's whole view of one container: manifest line, out-of-charge,
   * transhipment permit and RMS selection.
   *
   * The API 404s when the box appears in NO customs document at all. That is a
   * legitimate answer for this corpus (the document families are disjoint), so it
   * resolves to null and the caller says so rather than raising.
   */
  async getContainerCustoms(containerNo: string): Promise<ContainerCustomsView | null> {
    const key = encodeURIComponent(containerNo.trim().toUpperCase().replace(/\s+/g, ''));
    try {
      return await this.getJson<ContainerCustomsView>(`/api/customs/containers/${key}`);
    } catch (err) {
      if (err instanceof CargoApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Every gate document naming one container — PIN ticket, EIR and Form 13. */
  async getContainerGateDocs(containerNo: string): Promise<ContainerGateDocs | null> {
    const key = encodeURIComponent(containerNo.trim().toUpperCase().replace(/\s+/g, ''));
    try {
      return await this.getJson<ContainerGateDocs>(`/api/gate-docs/container/${key}`);
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

  /**
   * The delivery orders naming one container. Filtered SERVER-SIDE — the E-DO
   * register is paged, so scanning `getEdoRecords()` client-side would miss a DO
   * past the first page.
   */
  async getEdoForContainer(containerNo: string): Promise<EdoRecord[]> {
    return this.getList<EdoRecord>('/api/shipping-lines/edo', {
      container_no: containerNo.trim().toUpperCase().replace(/\s+/g, ''),
      limit: '50',
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

  /**
   * Recorded gate crossings (`GET /api/gate/events`) — UC-III's `core.gate_event`.
   *
   * The missing half of the integration. UC-III's job flow writes the crossing
   * here and updates only `customs_status` on `core.cargo`, so a completed
   * gate-out never reached any UC-2 panel: the Gate tab reads `core.eir`,
   * `core.pin_ticket` and CODECO, none of which UC-III touches.
   *
   * Returns `{items, count}` rather than a bare array, so it cannot go through
   * `getList` (which also reads X-Total-Count — this endpoint sends none).
   */
  async getGateEvents(filter: GateEventFilter = {}): Promise<GateEvent[]> {
    const qs = new URLSearchParams();
    if (filter.containerNo) qs.set('container', filter.containerNo.trim().toUpperCase().replace(/\s+/g, ''));
    if (filter.plate) qs.set('plate', filter.plate);
    if (filter.jobId != null) qs.set('job_id', String(filter.jobId));
    qs.set('limit', String(filter.limit ?? 100));
    const body = await this.getJson<{ items?: GateEvent[] }>(`/api/gate/events?${qs.toString()}`);
    return Array.isArray(body?.items) ? body.items : [];
  }

  // 12b) Shipping-lines API — advance lists (IAL / EAL) ----------------------
  /**
   * The terminal load list. `list_type: 'EAL'` gives the export side — 5,743 rows
   * across 5 vessel visits. Filters are applied server-side, so a container search
   * hits the whole list rather than the loaded page.
   */
  async getAdvanceList(filter: AdvanceListFilter = {}): Promise<AdvanceListContainer[]> {
    return (await this.getAdvanceListPage(filter)).items;
  }

  /**
   * The advance list WITH the register's row count.
   *
   * A panel that shows a count must use this rather than `getAdvanceList().length`:
   * the EAL register is 5,743 rows and any sane page size is a small fraction of
   * it, so the page length is not the population. See ExportList's load-list view.
   */
  async getAdvanceListPage(
    filter: AdvanceListFilter = {},
  ): Promise<{ items: AdvanceListContainer[]; total: number | null }> {
    return this.getPage<AdvanceListContainer>('/api/shipping-lines', {
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

  // 14b) Empty-container TRT chains (UC2-010) --------------------------------
  /**
   * The whole cohort in one call: KPI, its definition, the chain census and the
   * anomaly classes.
   *
   * `anomalies` is normalised to an array here — the backend omits it when
   * nothing is anomalous, and a panel that maps over undefined is a crash where
   * "no anomalies" is the good news.
   */
  async getEmptyTrt(): Promise<EmptyTrtOverview> {
    const body = await this.getJson<EmptyTrtOverview>('/api/cfs-ecy/empty-trt');
    return { ...body, anomalies: Array.isArray(body?.anomalies) ? body.anomalies : [] };
  }

  /**
   * Chains, filterable by status or anomaly class.
   *
   * Paged with the count kept: the register is 1,202 chains and the COMPLETE
   * cohort is 242, so `items.length` is never the population — the same trap
   * `getAdvanceListPage` exists to avoid.
   */
  async getEmptyTrtChains(
    filter: EmptyTrtChainFilter = {},
  ): Promise<{ items: EmptyTrtChain[]; total: number | null }> {
    return this.getPage<EmptyTrtChain>('/api/cfs-ecy/empty-trt/chains', {
      container: filter.container,
      chain_status: filter.chainStatus,
      anomaly_code: filter.anomalyCode,
      // Only send the flag when set — the backend defaults it to false, and an
      // explicit 'false' would still be a filter the operator did not ask for.
      anomaly_only: filter.anomalyOnly ? 'true' : undefined,
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    });
  }

  /** The containers behind one anomaly class — the ledger's drill-down. */
  async getEmptyTrtAnomaly(
    code: string,
    filter: { limit?: number; offset?: number } = {},
  ): Promise<EmptyTrtAnomalyDetail> {
    const key = encodeURIComponent(code.trim());
    const body = await this.getJson<EmptyTrtAnomalyDetail>(
      `/api/cfs-ecy/empty-trt/anomalies/${key}`,
      { limit: String(filter.limit ?? 100), offset: String(filter.offset ?? 0) },
    );
    return { ...body, items: Array.isArray(body?.items) ? body.items : [] };
  }

  /** One container's legs, durations and raw events. */
  async getEmptyTrtContainer(containerNo: string): Promise<EmptyTrtContainerDetail> {
    const key = encodeURIComponent(containerNo.trim());
    const body = await this.getJson<EmptyTrtContainerDetail>(
      `/api/cfs-ecy/empty-trt/containers/${key}`);
    return { ...body, legs: Array.isArray(body?.legs) ? body.legs : [] };
  }

  // 14c) Data-quality ledger (UC2-012) ---------------------------------------
  /**
   * Roll-up by severity, source table and issue type.
   *
   * Takes the SAME filters as {@link getDqIssues} and is sent through the same
   * builder, so a tile and the list it opens can never be counting different
   * things — the defect that makes a quality dashboard worse than none.
   */
  async getDqSummary(filter: DqFilter = {}): Promise<DqSummary> {
    const body = await this.getJson<DqSummary>('/api/dq/summary', Poc3CargoAdapter.dqQuery(filter));
    return {
      ...body,
      by_source_table: Array.isArray(body?.by_source_table) ? body.by_source_table : [],
      by_issue_type: Array.isArray(body?.by_issue_type) ? body.by_issue_type : [],
    };
  }

  /** The findings themselves, paged and filtered. */
  async getDqIssues(filter: DqFilter = {}): Promise<{ items: DqIssue[]; total: number | null }> {
    return this.getPage<DqIssue>('/api/dq/issues', {
      ...Poc3CargoAdapter.dqQuery(filter),
      sort: filter.sort,
      order: filter.order,
      limit: String(filter.limit ?? 100),
      offset: String(filter.offset ?? 0),
    });
  }

  /** The filter half shared by both DQ calls. Kept in one place on purpose. */
  private static dqQuery(filter: DqFilter): Record<string, string | undefined> {
    return {
      source_table: filter.sourceTable,
      issue_type: filter.issueType,
      severity: filter.severity,
      file_id: filter.fileId != null ? String(filter.fileId) : undefined,
      q: filter.q,
    };
  }

  // 15) Marine API — Live Vessels ----------------------------------------------
  /**
   * Fetch live AIS vessel data from the marine API. Uses the same request plumbing
   * as cargo calls, so the bearer token is attached and 401 self-heals automatically.
   */
  async getLiveVessels(): Promise<LiveVesselDTO[]> {
    return this.getList<LiveVesselDTO>('/api/marine/vessels/live');
  }

  // 16) JNPA Simulated Port-Data API — the live source behind the LIVE badge ----
  /**
   * These three read the POLLER, not the port.
   *
   * UC-II's "LIVE" claim rests entirely on one external feed: JNPA's own
   * Simulated Port-Data API at `dt.jnpa.in/poc-api-data-access`, polled by the
   * shared backend and routed into the same `core.*` tables the corpus dump
   * fills. That makes "is it LIVE?" a question about the poller's state — is a
   * client key configured, when did each group last advance, did the last poll
   * fail — which is exactly what these expose.
   *
   * Deliberately unauthenticated-tolerant and never fatal to a page: the panel
   * that renders them treats an error as "cannot determine", because a broken
   * health check must not be able to paint a feed green.
   */
  async getJnpaApiHealth(): Promise<JnpaApiHealth> {
    const body = await this.getJson<JnpaApiHealth>('/api/integrations/jnpa/health');
    return { ...body, groups: Array.isArray(body?.groups) ? body.groups : [] };
  }

  /** Run audit trail, newest first. The source of the volume figures. */
  async getJnpaApiRuns(limit = 50): Promise<JnpaApiRun[]> {
    return this.getList<JnpaApiRun>('/api/integrations/jnpa/runs', { limit: String(limit) });
  }

  /** Observed deviations from API Reference v2.0. An empty list is a real answer. */
  async getJnpaApiDefects(limit = 100): Promise<JnpaApiDefect[]> {
    return this.getList<JnpaApiDefect>('/api/integrations/jnpa/defects', {
      format: 'json',
      limit: String(limit),
    });
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
    // Authoritative membership from the DOCUMENTED endpoint. This previously read
    // `/api/cargo?is_released=false&limit=100` and let the panel filter on
    // `yard_block` client-side, which only matched the real queue by luck: the
    // server's rule is "not released AND (yard-blocked OR lifecycle >=
    // YARD_ASSIGNED) AND NOT already VERIFIED/RELEASED", and a 100-row page of
    // ~11,900 non-released containers cannot be relied on to contain the queue.
    const queue = await this.getList<{ container_number: string }>(
      '/api/cargo/scan-queue', { limit: '200', offset: '0' });

    // Enrich each member with its full cargo record so the panel keeps its
    // columns — the queue endpoint returns only container / yard block / status.
    // A scan queue is a work list and is small by nature; the cap stops a
    // pathological queue from fanning out unbounded.
    const members = queue.slice(0, 100);
    const records = await Promise.all(members.map(async (q) => {
      try {
        return await this.getJson<CargoRecord>(
          `/api/cargo/${encodeURIComponent(q.container_number)}`);
      } catch {
        return null; // a member that vanished between the two calls is simply dropped
      }
    }));
    return records.filter((r): r is CargoRecord => r !== null).map(mapCargoToScanEvent);
  }

  // -- lifecycle gates the Scan tab drives ----------------------------------
  //
  // These are the three transitions between yard and gate-out. Each is its own
  // endpoint because each is a distinct, audited state change that emits its own
  // event — patching columns with PUT would move the row without raising them.

  /**
   * Yard assignment — `PUT /api/cargo/{cn}/yard-assignment`, the second mandatory
   * gate. Lenient by design: it accepts `CREATED`, `VESSEL_DISCHARGED` and
   * `PENDENCY`, which is what lets a legacy row whose `yard_block` was set
   * directly (without the transition) be caught up.
   */
  async assignYard(containerNo: string, yardBlock: string): Promise<CargoRecord> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.writeJson<CargoRecord>(
      'PUT', `/api/cargo/${encodeURIComponent(norm)}/yard-assignment`, { yard_block: yardBlock });
  }

  /**
   * Scan verification — `POST /api/cargo/{cn}/verify`. THE scan outcome.
   * `verified: true` advances to `VERIFIED` (requires yard-assignment, else 409);
   * `false` records the failed check WITHOUT advancing, which is how a held or
   * re-scan-required box is captured.
   */
  async verifyCargo(
    containerNo: string,
    input: { verified?: boolean; remarks?: string } = {},
  ): Promise<{ container_number: string; verified: boolean; lifecycle_status: string }> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.writeJson<{ container_number: string; verified: boolean; lifecycle_status: string }>(
      'POST', `/api/cargo/${encodeURIComponent(norm)}/verify`,
      { verified: input.verified ?? true, ...(input.remarks ? { remarks: input.remarks } : {}) });
  }

  /**
   * Release — `POST /api/cargo/{cn}/release`, the final gate and the UC-III
   * handover. It requires `VERIFIED`, and emits `cargo.released` carrying the yard
   * location and vehicle details.
   *
   * ⚠ NOT `PUT {is_released: true}`. That path faces the same VERIFY gate, so it
   * 409s identically — but it reads like a field patch, which is exactly why the
   * Scan tab's Release looked broken rather than blocked.
   */
  async releaseCargo(containerNo: string, note?: string): Promise<CargoRecord> {
    const norm = containerNo.trim().toUpperCase().replace(/\s+/g, '');
    return this.writeJson<CargoRecord>(
      'POST', `/api/cargo/${encodeURIComponent(norm)}/release`, note ? { note } : {});
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
