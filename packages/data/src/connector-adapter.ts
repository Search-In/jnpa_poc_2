/**
 * ConnectorAdapter — routes the Integration health cards through the six real
 * connector services, and falls back to the simulator **visibly** (UC2-040).
 *
 * A decorator, like AiForecastAdapter: it overrides exactly one read and
 * delegates everything else, so nothing else in the dashboard changes shape.
 *
 * The acceptance is behavioural, exactly as UC2-015's was — stop a connector
 * container and its card must visibly change, proving the wire is real. So the
 * fallback is not a silent safety net; it is the demonstration. A card that says
 * CONNECTOR came from a service that answered. A card that says SIMULATED says
 * why it did not.
 *
 * ⚠ Capability preservation. This sits between Poc3CargoAdapter and SimAdapter,
 * the exact position where AiForecastAdapter silently dropped 67 optional
 * methods and blanked half the dashboard. It therefore adopts the wrapped
 * adapter's methods dynamically for the same reason and by the same mechanism —
 * see `adoptOptional`. Do not replace this with a hand-written list.
 */
import type { IntegrationHealth } from '@jnpa/schemas';
import type { DataAdapter } from './interface.js';
import {
  CONNECTORS, connectorHealth, injectFault, pollConnector, publishedEvents,
  type ConnectorDeps, type ConnectorPollBody, type PublishedEvent,
} from './connectors.js';

export interface ConnectorAdapterDeps {
  /**
   * Base URL for a connector slug, e.g. `(s) => '/connectors/' + s`. Relative by
   * default so the dev proxy (and a same-origin reverse proxy in a deployed
   * build) can reach containers that are not internet-facing.
   */
  baseUrlFor?: (slug: string) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ConnectorAdapter implements DataAdapter {
  private base: DataAdapter;
  private conn: ConnectorDeps;

  constructor(base: DataAdapter, deps: ConnectorAdapterDeps = {}) {
    this.base = base;
    this.conn = {
      baseUrlFor: deps.baseUrlFor ?? ((slug: string) => `/connectors/${slug}`),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
    };
    this.adoptOptional(base);
  }

  get mode() {
    return this.base.mode;
  }

  /**
   * The one overridden read.
   *
   * Probes all six connectors CONCURRENTLY and per-source: a partial outage is
   * the interesting case, and probing them as a batch that fails together would
   * hide exactly the state the chaos drill (UC2-041) exists to show. Each source
   * that answers is badged CONNECTOR; each that does not falls back to the
   * wrapped adapter's card for that source, restamped SIMULATED with the reason.
   *
   * Deliberately NOT cached, unlike AiForecastAdapter's one-shot health probe.
   * There the probe decided a badge for a curve computed once; here the card IS
   * the data, and the panel refetches precisely to watch a connector die and
   * recover. A cache would make the drill show a stale traffic light.
   */
  async getIntegrationHealth(): Promise<IntegrationHealth[]> {
    const fallback = await this.base.getIntegrationHealth();
    const bySource = new Map(fallback.map((h) => [h.sourceSystem, h]));

    const probes = await Promise.all(CONNECTORS.map(async ({ slug, sourceSystem }) => ({
      sourceSystem,
      card: await connectorHealth(this.conn, slug, sourceSystem),
    })));

    const live = new Map(probes.filter((p) => p.card).map((p) => [p.sourceSystem, p.card!]));
    // Keep the wrapped adapter's ORDER and membership, so the panel never gains
    // or loses a card just because a connector went down.
    const merged = fallback.map((h) => live.get(h.sourceSystem) ?? ConnectorAdapter.simulated(h));
    // A source the connectors report but the base does not know about is still
    // real news — append rather than discard it.
    for (const [sourceSystem, card] of live) {
      if (!bySource.has(sourceSystem)) merged.push(card);
    }
    return merged;
  }

  /** Re-stamp a simulator card so it can never read as a connector's own report. */
  private static simulated(h: IntegrationHealth): IntegrationHealth {
    return {
      ...h,
      source: 'SIMULATED',
      fallbackReason: `The ${h.sourceSystem} connector did not answer its health check.`,
    };
  }

  // -- the other three endpoints WS3 §1 claims, finally callable --------------
  /**
   * Inject (or clear, with null) a fault on one connector and return what it
   * then reports. Null when the connector is unreachable — the caller must not
   * pretend the injection landed.
   */
  async injectConnectorFault(
    sourceSystem: IntegrationHealth['sourceSystem'],
    level: 'AMBER' | 'RED' | null,
  ): Promise<IntegrationHealth | null> {
    const c = CONNECTORS.find((x) => x.sourceSystem === sourceSystem);
    if (!c) return null;
    return injectFault(this.conn, c.slug, c.sourceSystem, level);
  }

  /** Run one fallback-chain cycle and report which tier served. */
  async pollConnector(
    sourceSystem: IntegrationHealth['sourceSystem'],
  ): Promise<ConnectorPollBody | null> {
    const c = CONNECTORS.find((x) => x.sourceSystem === sourceSystem);
    return c ? pollConnector(this.conn, c.slug) : null;
  }

  /** The CloudEvents a connector actually emitted — the evidence, not the claim. */
  async getPublishedEvents(
    sourceSystem: IntegrationHealth['sourceSystem'],
  ): Promise<PublishedEvent[] | null> {
    const c = CONNECTORS.find((x) => x.sourceSystem === sourceSystem);
    return c ? publishedEvents(this.conn, c.slug) : null;
  }

  /**
   * Forward every method the wrapped adapter has that this one does not.
   *
   * Identical to AiForecastAdapter.adoptOptional and for the identical reason:
   * `DataAdapter`'s ~49 optional methods make dropping one a legal, silent,
   * type-clean way to blank a panel. Keys already on `this` are left alone, so
   * the override above wins.
   */
  private adoptOptional(base: DataAdapter): void {
    const self = this as unknown as Record<string, unknown>;
    for (let o: object | null = base; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        if (key in self) continue;
        const desc = Object.getOwnPropertyDescriptor(o, key);
        if (!desc || typeof desc.value !== 'function') continue;
        const fn = desc.value as (...a: unknown[]) => unknown;
        self[key] = (...a: unknown[]) => fn.apply(base, a);
      }
    }
  }

  // -- the required surface, delegated -----------------------------------------
  getFacilities: DataAdapter['getFacilities'] = (...a) => this.base.getFacilities(...a);
  getTerminals: DataAdapter['getTerminals'] = (...a) => this.base.getTerminals(...a);
  getContainerMovements: DataAdapter['getContainerMovements'] = (...a) => this.base.getContainerMovements(...a);
  getGateOps: DataAdapter['getGateOps'] = (...a) => this.base.getGateOps(...a);
  getPendency: DataAdapter['getPendency'] = (...a) => this.base.getPendency(...a);
  getRailSide: DataAdapter['getRailSide'] = (...a) => this.base.getRailSide(...a);
  getRakeForecast: DataAdapter['getRakeForecast'] = (...a) => this.base.getRakeForecast(...a);
  getGateQueueForecast: DataAdapter['getGateQueueForecast'] = (...a) => this.base.getGateQueueForecast(...a);
  getITRHO: DataAdapter['getITRHO'] = (...a) => this.base.getITRHO(...a);
  getScanQueue: DataAdapter['getScanQueue'] = (...a) => this.base.getScanQueue(...a);
  getEmptyPool: DataAdapter['getEmptyPool'] = (...a) => this.base.getEmptyPool(...a);
  getKPIs: DataAdapter['getKPIs'] = (...a) => this.base.getKPIs(...a);
  getNotifications: DataAdapter['getNotifications'] = (...a) => this.base.getNotifications(...a);
  runScenario: DataAdapter['runScenario'] = (...a) => this.base.runScenario(...a);
}
