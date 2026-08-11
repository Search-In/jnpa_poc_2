/**
 * MockAdapter (prompt §5) — backed by @jnpa/sim's deterministic dataset and the
 * @jnpa/kpi engine. Implements every DataAdapter method so `pnpm dev` runs the
 * whole dashboard offline with ZERO credentials. Role scoping is enforced here
 * too, mirroring the gateway's row-level filtering (§9).
 */
import type {
  CargoEvent,
  Container,
  Facility,
  IntegrationHealth,
  KpiResult,
  Notification,
  Rake,
  Role,
  ScanEvent,
  ShippingDocType,
  SidingId,
  Terminal,
  ITRHOMovement,
} from '@jnpa/schemas';
import { FACILITY_SCOPED_ROLES } from '@jnpa/schemas';
import { SimWorld } from '@jnpa/sim';
import type { BaselinesConfig } from '@jnpa/kpi';
import { computeAllKpis } from '@jnpa/kpi';

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
import type { ReferenceCargoOverride } from './reference/index.js';
import { roleVisibleFacilityIds } from './rbac-scope.js';
import { simpleGateQueueForecast } from './forecasts.js';
import { buildNotifications } from './notifications-derive.js';
import { runMockScenario } from './scenarios-mock.js';

export interface MockAdapterDeps {
  terminalsConfig: ConstructorParameters<typeof SimWorld>[0];
  baselines: BaselinesConfig;
  seed?: number;
  /**
   * Optional JNPA reference-package cargo override. When present, the mock
   * dataset's container set + a prepended reference event stream come from the
   * reference data (via SimWorld's cargoOverride seam) instead of the synthetic
   * generator; all other domains stay synthetic. Absent → pure synthetic mock.
   */
  cargoOverride?: ReferenceCargoOverride;
}

const HOUR = 3_600_000;

export class MockAdapter implements DataAdapter {
  readonly mode = 'mock' as const;
  private sim: SimWorld;
  private baselines: BaselinesConfig;
  private asOf: string;

  constructor(deps: MockAdapterDeps) {
    this.sim = new SimWorld(deps.terminalsConfig, {
      seed: deps.seed ?? 20260615,
      ...(deps.cargoOverride ? { cargoOverride: deps.cargoOverride } : {}),
    });
    this.baselines = deps.baselines;
    this.asOf = new Date(this.sim.startMs + this.sim.windowHours * HOUR).toISOString();
  }

  // -- spatial backdrop -----------------------------------------------------
  async getFacilities(role?: Role): Promise<Facility[]> {
    const all = this.sim.world.facilities;
    if (!role || !FACILITY_SCOPED_ROLES.has(role)) return all;
    const visible = roleVisibleFacilityIds(role, all);
    return all.filter((f) => visible.has(f.facilityId));
  }

  async getTerminals(): Promise<Terminal[]> {
    return this.sim.world.terminals;
  }

  // -- container movements --------------------------------------------------
  async getContainerMovements(filter: ContainerMovementFilter): Promise<ContainerMovementDTO[]> {
    const { containers, events } = this.sim.dataset;
    const eventsByContainer = new Map<string, typeof events>();
    for (const e of events) {
      const arr = eventsByContainer.get(e.containerNo) ?? [];
      arr.push(e);
      eventsByContainer.set(e.containerNo, arr);
    }

    let scoped = containers;
    if (filter.originStream) scoped = scoped.filter((c) => c.originStream === filter.originStream);
    // Exact container-number search parity with the POC-3 Cargo API (Container
    // Search). Normalised the same way (upper, de-spaced) so a lookup matches.
    if (filter.containerNo) {
      const norm = filter.containerNo.trim().toUpperCase().replace(/\s+/g, '');
      scoped = scoped.filter((c) => c.containerNo === norm);
    }
    // Vessel-name search has no answer here: the simulator models no vessel per
    // container (the Movements Vessel column reads "—" in mock cargo mode), so
    // nothing can match. Returning the unfiltered list instead would report every
    // container in the port as sailing on whatever vessel was typed.
    if (filter.vesselName?.trim()) scoped = [];

    const roleFacilities =
      filter.role && FACILITY_SCOPED_ROLES.has(filter.role)
        ? roleVisibleFacilityIds(filter.role, this.sim.world.facilities)
        : null;

    const out: ContainerMovementDTO[] = [];
    for (const c of scoped) {
      const trail = (eventsByContainer.get(c.containerNo) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
      const last = trail[trail.length - 1];
      const facilityId = last?.facilityId ?? '';
      if (filter.facilityId && facilityId !== filter.facilityId) continue;
      if (filter.terminalId && !trail.some((e) => e.terminalId === filter.terminalId)) continue;
      if (roleFacilities && !trail.some((e) => roleFacilities.has(e.facilityId))) continue;
      if (filter.window) {
        const inWin = trail.some((e) => e.ts >= filter.window!.from && e.ts < filter.window!.to);
        if (!inWin) continue;
      }
      out.push({
        container: c,
        lastEventType: last?.eventType ?? 'EXPECTED',
        lastEventTs: last?.ts ?? c.lastUpdatedTs,
        facilityId,
        trail: trail.map((e) => ({
          eventType: e.eventType, ts: e.ts, facilityId: e.facilityId, sourceSystem: e.sourceSystem,
        })),
      });
    }
    return out;
  }

  // -- gate ops -------------------------------------------------------------
  async getGateOps(window: TimeWindow): Promise<GateOpsDTO[]> {
    const txns = this.sim.dataset.gateTransactions.filter(
      (g) => g.arrivalTs >= window.from && g.arrivalTs < window.to,
    );
    const terminals = this.sim.world.terminals;
    const gateToTerminal = new Map<string, string>();
    for (const t of terminals) for (const g of t.gates) gateToTerminal.set(g, t.terminalId);

    const byGate = new Map<string, typeof txns>();
    for (const g of txns) {
      const arr = byGate.get(g.gateId) ?? [];
      arr.push(g);
      byGate.set(g.gateId, arr);
    }
    const out: GateOpsDTO[] = [];
    for (const [gateId, list] of byGate) {
      const completed = list.filter((g) => g.endTs);
      const avg =
        completed.length === 0
          ? 0
          : completed.reduce((s, g) => s + (new Date(g.endTs!).getTime() - new Date(g.startTs).getTime()) / 60000, 0) /
            completed.length;
      // queue length = arrivals not yet ended as of window end
      const queue = list.filter((g) => !g.endTs || g.endTs >= window.to).length;
      out.push({
        gateId,
        terminalId: gateToTerminal.get(gateId) ?? 'UNKNOWN',
        queueLength: queue,
        transactions: list,
        avgTxnTimeMin: Math.round(avg * 10) / 10,
      });
    }
    return out;
  }

  async getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO> {
    return simpleGateQueueForecast(gateId, this.sim.dataset.gateTransactions, this.asOf);
  }

  // -- pendency -------------------------------------------------------------
  async getPendency(): Promise<PendencyDTO[]> {
    const kpis = this.computeKpis();
    const pend = kpis.find((k) => k.key === 'containerPendency');
    const byFacility = new Map(pend?.byFacility?.map((b) => [b.facilityId, b.value]) ?? []);
    // Predominant filterable shipping-doc type (IAL/EAL/DO) per facility — same
    // predominant-doc logic as getEmptyPool, but joined facility←container←doc so
    // the panel's doc-type filter can scope rows (EmptyPool joins by lineId).
    const docByContainer = new Map<string, ShippingDocType>();
    for (const d of this.sim.dataset.shippingDocs) {
      if (d.type === 'IAL' || d.type === 'EAL' || d.type === 'DO') {
        for (const cn of d.containerNos) docByContainer.set(cn, d.type);
      }
    }
    const counts: Record<string, Partial<Record<ShippingDocType, number>>> = {};
    for (const e of this.sim.dataset.events) {
      const dt = docByContainer.get(e.containerNo);
      if (!dt) continue;
      const c = (counts[e.facilityId] ??= {});
      c[dt] = (c[dt] ?? 0) + 1;
    }
    const RANK: ShippingDocType[] = ['IAL', 'EAL', 'DO'];
    const primaryDocByFacility: Record<string, ShippingDocType> = {};
    for (const [fac, c] of Object.entries(counts)) {
      primaryDocByFacility[fac] = RANK.reduce((best, t) => (c[t] ?? 0) > (c[best] ?? 0) ? t : best, RANK[0]!);
    }
    return this.sim.world.facilities
      .filter((f) => ['CFS', 'ICD', 'TERMINAL', 'DPD'].includes(f.type))
      .map((f) => ({
        facilityId: f.facilityId,
        facilityType: f.type,
        facilityName: f.name,
        pendency: byFacility.get(f.facilityId) ?? 0,
        geom: f.geom,
        ...(primaryDocByFacility[f.facilityId] ? { primaryDoc: primaryDocByFacility[f.facilityId] } : {}),
      }));
  }

  // -- rail side ------------------------------------------------------------
  async getRailSide(siding: SidingId, window: TimeWindow): Promise<RailSideDTO> {
    const rakes = this.sim.dataset.rakes.filter(
      (r) => r.sidingId === siding && r.arrivalTs >= window.from && r.arrivalTs < window.to,
    );
    const rakeIds = new Set(rakes.map((r) => r.rakeId));
    const wagons = this.sim.dataset.wagons.filter((w) => rakeIds.has(w.rakeId));
    return { siding, rakes, wagons };
  }

  async getRakeForecast(rakeId: string): Promise<RakeForecastDTO> {
    const rake = this.sim.dataset.rakes.find((r) => r.rakeId === rakeId);
    if (!rake) return { rakeId };
    // simple forecast: if not yet placed/removed, project from arrival + medians
    return {
      rakeId,
      etaPlacement: rake.placementTs ?? new Date(new Date(rake.arrivalTs).getTime() + 2 * HOUR).toISOString(),
      etaRemoval: rake.removalTs ?? new Date(new Date(rake.arrivalTs).getTime() + 6 * HOUR).toISOString(),
      etaDeparture: rake.departureTs ?? new Date(new Date(rake.arrivalTs).getTime() + 8.5 * HOUR).toISOString(),
    };
  }

  // -- itrho / scans / empty ------------------------------------------------
  async getITRHO(window: TimeWindow): Promise<ITRHOMovement[]> {
    return this.sim.dataset.itrho.filter((m) => m.requestedTs >= window.from && m.requestedTs < window.to);
  }

  async getScanQueue(): Promise<ScanEvent[]> {
    // "queue" = scans not yet ended, plus recently completed. Enrich each row with
    // the container's e-seal (universal e-seal reader) number + a pre-document-
    // processing status derived from the existing ESEAL_AFFIX / ESEAL_BREAK events
    // (sourceSystem 'ESEAL'). No new API — extra fields ride on the ScanEvent row.
    const { scans, containers, events } = this.sim.dataset;
    const sealByContainer = new Map(containers.map((c) => [c.containerNo, c.currentSealNo] as const));
    const affixed = new Set<string>();
    const broken = new Set<string>();
    for (const e of events) {
      if (e.eventType === 'ESEAL_AFFIX') affixed.add(e.containerNo);
      else if (e.eventType === 'ESEAL_BREAK') broken.add(e.containerNo);
    }
    return scans.map((s) => ({
      ...s,
      sealNo: sealByContainer.get(s.containerNo),
      preDoc: broken.has(s.containerNo) ? 'TAMPER' : affixed.has(s.containerNo) ? 'VERIFIED' : 'PENDING',
    })) as ScanEvent[];
  }

  async getEmptyPool(): Promise<EmptyPoolDTO> {
    // Classify each line by its predominant filterable shipping-doc type
    // (IAL/EAL/DO), joined by lineId, so the panel's doc-type filter scopes rows.
    const counts: Record<string, Partial<Record<ShippingDocType, number>>> = {};
    for (const d of this.sim.dataset.shippingDocs) {
      if (d.type !== 'IAL' && d.type !== 'EAL' && d.type !== 'DO') continue;
      const c = (counts[d.lineId] ??= {});
      c[d.type] = (c[d.type] ?? 0) + 1;
    }
    const RANK: ShippingDocType[] = ['IAL', 'EAL', 'DO'];
    const primaryDocByLine: Record<string, ShippingDocType> = {};
    for (const [line, c] of Object.entries(counts)) {
      primaryDocByLine[line] = RANK.reduce((best, t) => (c[t] ?? 0) > (c[best] ?? 0) ? t : best, RANK[0]!);
    }
    return { pools: this.sim.dataset.emptyPools, primaryDocByLine };
  }

  // -- KPIs -----------------------------------------------------------------
  private computeKpis(): KpiResult[] {
    return computeAllKpis({
      asOf: this.asOf,
      containers: this.sim.dataset.containers,
      events: this.sim.dataset.events,
      gateTransactions: this.sim.dataset.gateTransactions,
      rakes: this.sim.dataset.rakes,
      itrho: this.sim.dataset.itrho,
      scans: this.sim.dataset.scans,
      baselines: this.baselines,
      bufferDwellThresholdHours: 24,
    });
  }

  async getKPIs(): Promise<KpiResult[]> {
    return this.computeKpis();
  }

  // -- notifications --------------------------------------------------------
  async getNotifications(role: Role): Promise<Notification[]> {
    const all = buildNotifications(this.sim.dataset, this.sim.world);
    return all.filter((n) => n.audienceRoles.includes(role));
  }

  // -- integration health ---------------------------------------------------
  async getIntegrationHealth(): Promise<IntegrationHealth[]> {
    // In mock mode every source is SYNTHETIC + GREEN unless a fault is injected.
    const sources: IntegrationHealth['sourceSystem'][] = ['ULIP', 'ICEGATE', 'TOS', 'FOIS', 'ESEAL', 'SHIPLINE'];
    return sources.map((sourceSystem) => ({
      sourceSystem,
      lastGoodPollTs: this.asOf,
      errorCount: 0,
      degradation: 'GREEN',
      mode: 'SYNTHETIC',
      note: 'PoC mock mode — schema-accurate simulator',
    }));
  }

  // -- scenarios ------------------------------------------------------------
  async runScenario(id: string, params: ScenarioParams): Promise<ScenarioResultDTO> {
    return runMockScenario(id, params, {
      dataset: this.sim.dataset,
      world: this.sim.world,
      baselines: this.baselines,
      asOf: this.asOf,
      seed: this.sim.seed,
    });
  }

  // -- helpers exposed for adapters/tests -----------------------------------
  get window(): TimeWindow {
    return { from: new Date(this.sim.startMs).toISOString(), to: this.asOf };
  }
  get rakesForTest(): Rake[] {
    return this.sim.dataset.rakes;
  }
  get containersForTest(): Container[] {
    return this.sim.dataset.containers;
  }
  /** Raw event spine + valid appointment refs — for the gate-automation feed (§13). */
  gateAutomationSnapshot(): { events: CargoEvent[]; appointmentRefs: string[] } {
    const appointmentRefs = this.sim.dataset.gateTransactions
      .map((g) => g.appointmentRef)
      .filter((r): r is string => Boolean(r));
    return { events: this.sim.dataset.events, appointmentRefs };
  }
}
