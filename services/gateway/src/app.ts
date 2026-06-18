/**
 * Gateway application (prompt §1 BFF, §13 gate feed, §14 security). Wires the
 * data source (MockAdapter — or the live connectors in DATA_MODE=live), the
 * scenario engine, the notification service, and the gate-automation feed behind
 * authN/Z (claim-based RBAC), per-consumer rate-limit, and audit logging.
 *
 * Exposed as a pure `handle(method, path, headers, body)` so it is unit-testable
 * without binding a socket; server.ts adapts Node http to it.
 */
import type { CargoEvent, Role } from '@jnpa/schemas';
import { PORT_WIDE_ROLES } from '@jnpa/schemas';
import { InMemoryEventBus } from '@jnpa/sim';
import { MockAdapter, type DataAdapter } from '@jnpa/data';
import type { BaselinesConfig } from '@jnpa/kpi';
import { ScenarioEngine } from '@jnpa/scenarios';
import { NotificationService } from '@jnpa/notifications';
import { verifyToken } from './auth/jwt.js';
import { AuditLog, RateLimiter } from './middleware.js';
import { decideGate, type GateAutomationContext, type GateDecisionRequest } from './gate-automation.js';

export interface GatewayConfig {
  terminalsConfig: ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
  baselines: BaselinesConfig;
  jwtSecret: string;
  audience: string;
  seed?: number;
  /** Override the clock for deterministic tests. */
  nowSec?: () => number;
  nowIso?: () => string;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
}

export class Gateway {
  readonly adapter: DataAdapter;
  private scenarios: ScenarioEngine;
  private notifications: NotificationService;
  private bus = new InMemoryEventBus();
  private limiter = new RateLimiter();
  readonly audit = new AuditLog();
  private cfg: GatewayConfig;
  private gateCtx: GateAutomationContext;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    const mock = new MockAdapter({ terminalsConfig: cfg.terminalsConfig, baselines: cfg.baselines, seed: cfg.seed });
    this.adapter = mock;
    this.scenarios = new ScenarioEngine({
      terminalsConfig: cfg.terminalsConfig, baselines: cfg.baselines, bus: this.bus, seed: cfg.seed,
    });
    this.notifications = new NotificationService(this.bus);

    // Build the gate-automation context from the mock dataset.
    const snapshot = mock.gateAutomationSnapshot();
    const eventsByContainer = new Map<string, CargoEvent[]>();
    for (const m of snapshot.events) {
      const arr = eventsByContainer.get(m.containerNo) ?? [];
      arr.push(m);
      eventsByContainer.set(m.containerNo, arr);
    }
    this.gateCtx = {
      eventsByContainer,
      validAppointments: new Set(snapshot.appointmentRefs),
      now: cfg.nowIso ?? (() => new Date().toISOString()),
    };

    // Pre-seed notifications from the dataset so the centre is populated.
    this.notifications.ingestBatch(snapshot.events);
  }

  private nowSec(): number {
    return this.cfg.nowSec ? this.cfg.nowSec() : Math.floor(Date.now() / 1000);
  }

  /** Verify bearer token → claims, or null. */
  private auth(headers: Record<string, string | undefined>): { sub: string; role: Role; facilities?: string[] } | null {
    const authz = headers['authorization'] ?? headers['Authorization'];
    if (!authz?.startsWith('Bearer ')) return null;
    const res = verifyToken(authz.slice(7), { secret: this.cfg.jwtSecret, audience: this.cfg.audience, nowSec: this.nowSec() });
    if (!res.valid || !res.claims) return null;
    return { sub: res.claims.sub, role: res.claims.role, facilities: res.claims.facilities };
  }

  async handle(
    method: string,
    path: string,
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<GatewayResponse> {
    // public endpoints
    if (method === 'GET' && path === '/health') return { status: 200, body: { ok: true, mode: this.adapter.mode } };

    // rate limit per consumer (token sub or IP-ish header)
    const consumer = headers['x-consumer'] ?? headers['authorization'] ?? 'anon';
    if (!this.limiter.allow(consumer)) {
      return { status: 429, body: { error: 'rate limit exceeded' } };
    }

    // auth required for all /api/*
    const claims = this.auth(headers);
    if (!claims) {
      this.audit.record({ action: `${method} ${path}`, outcome: 'DENIED', resource: path });
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const role = claims.role;
    this.audit.record({ actor: claims.sub, role, action: `${method} ${path}`, outcome: 'OK', resource: path });

    const win = { from: new Date(0).toISOString(), to: new Date(Date.now() + 1e12).toISOString() };

    try {
      // ---- read endpoints (role-scoped via the adapter) ------------------
      if (method === 'GET' && path === '/api/terminals') return ok(await this.adapter.getTerminals());
      if (method === 'GET' && path === '/api/facilities') return ok(await this.adapter.getFacilities(role));
      if (method === 'GET' && path === '/api/kpis') return ok(await this.adapter.getKPIs());
      if (method === 'GET' && path === '/api/integration-health') return ok(await this.adapter.getIntegrationHealth());
      if (method === 'GET' && path === '/api/scan-queue') return ok(await this.adapter.getScanQueue());
      if (method === 'GET' && path === '/api/empty-pool') return ok(await this.adapter.getEmptyPool());
      if (method === 'GET' && path === '/api/pendency') return ok(await this.adapter.getPendency(true));
      if (method === 'GET' && path === '/api/gate-ops') return ok(await this.adapter.getGateOps(win));
      if (method === 'GET' && path === '/api/itrho') return ok(await this.adapter.getITRHO(win));
      if (method === 'GET' && path === '/api/notifications') return ok(this.notifications.forRole(role).length
        ? this.notifications.forRole(role)
        : await this.adapter.getNotifications(role));

      const railMatch = path.match(/^\/api\/rail-side\/(T1|T2)$/);
      if (method === 'GET' && railMatch) return ok(await this.adapter.getRailSide(railMatch[1] as 'T1' | 'T2', win));

      const fcMatch = path.match(/^\/api\/gate-queue-forecast\/(.+)$/);
      if (method === 'GET' && fcMatch) return ok(await this.adapter.getGateQueueForecast(decodeURIComponent(fcMatch[1]!)));

      const rfMatch = path.match(/^\/api\/rake-forecast\/(.+)$/);
      if (method === 'GET' && rfMatch) return ok(await this.adapter.getRakeForecast(decodeURIComponent(rfMatch[1]!)));

      // ---- container movements (POST filter) ----------------------------
      if (method === 'POST' && path === '/api/container-movements') {
        const filter = (body as Record<string, unknown>) ?? {};
        return ok(await this.adapter.getContainerMovements({ ...filter, role }));
      }

      // ---- scenarios (POST) — DTCCC_ADMIN + JNPA roles only -------------
      const scMatch = path.match(/^\/api\/scenarios\/([A-Za-z0-9-]+)$/);
      if (method === 'POST' && scMatch) {
        if (!PORT_WIDE_ROLES.has(role)) return { status: 403, body: { error: 'scenario run forbidden for role' } };
        return ok(this.scenarios.run(scMatch[1]!, (body as Record<string, unknown>) ?? {}));
      }

      // ---- gate-automation decision feed (§13) -------------------------
      if (method === 'POST' && path === '/api/gate-decision') {
        const decision = decideGate(body as GateDecisionRequest, this.gateCtx);
        return ok(decision);
      }

      // ---- ack a notification ------------------------------------------
      const ackMatch = path.match(/^\/api\/notifications\/([^/]+)\/ack$/);
      if (method === 'POST' && ackMatch) {
        const okAck = this.notifications.ack(decodeURIComponent(ackMatch[1]!), claims.sub, this.gateCtx.now());
        return okAck ? ok({ acked: true }) : { status: 404, body: { error: 'notification not found' } };
      }

      // ---- audit (admin only) ------------------------------------------
      if (method === 'GET' && path === '/api/audit') {
        if (role !== 'DTCCC_ADMIN') return { status: 403, body: { error: 'admin only' } };
        return ok(this.audit.recent());
      }

      return { status: 404, body: { error: 'not found' } };
    } catch (e) {
      this.audit.record({ actor: claims.sub, role, action: `${method} ${path}`, outcome: 'ERROR' });
      return { status: 500, body: { error: e instanceof Error ? e.message : 'internal error' } };
    }
  }
}

function ok(body: unknown): GatewayResponse {
  return { status: 200, body };
}
