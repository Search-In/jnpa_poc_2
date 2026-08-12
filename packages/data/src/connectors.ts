/**
 * Client for the six UC-2 connector services (ticket UC2-040).
 *
 * ⚠ WHY THIS EXISTS — the same defect as UC2-015, in a different subsystem.
 * `services/connectors/connectors_common/base.py` has implemented all four
 * endpoints the tender's WS3 §1 claims — `/health`, `/poll`, `/inject-fault`,
 * `/published` — since the beginning, and `07_WS_Claims_vs_Implementation.md`
 * lists that claim as **verified**. It is verified in the sense that the code
 * exists. It was not reachable: `docker-compose.yml` declares all six connector
 * containers with no `ports:`, so nothing outside the compose network could call
 * them, and the dashboard's Integration tab drove a `localStorage` fault store
 * instead. An evaluator running one `curl` against `/inject-fault` would have
 * found the gap.
 *
 * The browser fault console is NOT deleted. It stays as the labelled fallback —
 * a demo laptop with no Docker must still be able to show the degradation story.
 * What changes is that the card now says WHICH answered, so a simulated health
 * card can never again be presented as a connector's own report.
 *
 * Service contract (`connectors_common/base.py :: build_app`):
 *   GET  /health        → {sourceSystem, lastGoodPollTs, errorCount, degradation, mode, upstream, note}
 *   POST /poll          → {emitted, tier, health}
 *   POST /inject-fault  → {level: "AMBER"|"RED"|null, repoll?} → the health dict
 *   POST /drill         → {sourceSystem, liveUpstreamConfigured, steps[], allMatched}
 *   GET  /published     → [{topic, event}]  (last 50)
 */
import type { Degradation, IntegrationHealth, IntegrationMode, SourceSystem } from '@jnpa/schemas';

/**
 * The six connector families (WS3 §2), lower-case as the container names and
 * URL segments have them, paired with the SourceSystem they report as.
 *
 * ⚠ Order and membership must match `MockAdapter.getIntegrationHealth`, or the
 * live and fallback paths would show different source lists and the panel would
 * appear to gain or lose a source when a connector goes down.
 */
export const CONNECTORS: ReadonlyArray<{ slug: string; sourceSystem: SourceSystem }> = [
  { slug: 'ulip', sourceSystem: 'ULIP' },
  { slug: 'icegate', sourceSystem: 'ICEGATE' },
  { slug: 'tos', sourceSystem: 'TOS' },
  { slug: 'fois', sourceSystem: 'FOIS' },
  { slug: 'eseal', sourceSystem: 'ESEAL' },
  { slug: 'shipline', sourceSystem: 'SHIPLINE' },
] as const;

/** Raw `/health` body. Python spells these exactly as below. */
export interface ConnectorHealthBody {
  sourceSystem: string;
  lastGoodPollTs?: string | null;
  errorCount: number;
  degradation: string;
  mode: string;
  /** Which upstream served this tier (UC2-041); absent on an older connector. */
  upstream?: string | null;
  note?: string | null;
}

/** `POST /poll` result — how many events went out and on which fallback tier. */
export interface ConnectorPollBody {
  emitted: number;
  tier: string;
  health: ConnectorHealthBody;
}

/** One entry from `GET /published` — the CloudEvent the connector emitted. */
export interface PublishedEvent {
  topic: string;
  event: Record<string, unknown>;
}

export interface ConnectorDeps {
  /**
   * Base URL for a connector, given its slug. Relative in dev so the Vite proxy
   * can reach a container that is NOT internet-facing.
   */
  baseUrlFor: (slug: string) => string;
  fetchImpl?: typeof fetch;
  /**
   * Abort budget. A connector that is up but wedged must not hang the
   * Integration tab — past this the caller falls back to the simulator, which is
   * the whole point of keeping one.
   */
  timeoutMs?: number;
  /** Separate, larger budget for `POST /drill` — see {@link runDrill}. */
  drillTimeoutMs?: number;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

const DEGRADATIONS = new Set(['GREEN', 'AMBER', 'RED']);
const MODES = new Set(['LIVE', 'CACHED', 'SYNTHETIC']);

/**
 * Project a connector's `/health` onto the dashboard DTO.
 *
 * Returns null when the body does not match the contract. Null is deliberately
 * indiscriminate: a half-understood health card is worse than an absent one,
 * because the panel would render a confident traffic light nobody can trace.
 */
export function toIntegrationHealth(
  body: ConnectorHealthBody | null | undefined,
  sourceSystem: SourceSystem,
): IntegrationHealth | null {
  if (!body || typeof body !== 'object') return null;
  const degradation = String(body.degradation ?? '').toUpperCase();
  const mode = String(body.mode ?? '').toUpperCase();
  if (!DEGRADATIONS.has(degradation) || !MODES.has(mode)) return null;
  if (typeof body.errorCount !== 'number') return null;
  return {
    // Trust OUR mapping for the source name, not the body's: the slug→source
    // pairing is what the panel keys on, and a connector misreporting its own
    // name would otherwise create a seventh card or overwrite another's.
    sourceSystem,
    ...(body.lastGoodPollTs ? { lastGoodPollTs: body.lastGoodPollTs } : {}),
    errorCount: body.errorCount,
    degradation: degradation as Degradation,
    mode: mode as IntegrationMode,
    ...(body.note ? { note: body.note } : {}),
    ...(body.upstream ? { upstream: body.upstream } : {}),
    source: 'CONNECTOR',
  };
}

/** `GET /health` for one connector. Null on anything that is not a usable card. */
export async function connectorHealth(
  deps: ConnectorDeps,
  slug: string,
  sourceSystem: SourceSystem,
): Promise<IntegrationHealth | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 2500, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrlFor(slug).replace(/\/$/, '')}/health`, { signal });
      if (!res.ok) return null;
      return toIntegrationHealth((await res.json()) as ConnectorHealthBody, sourceSystem);
    });
  } catch {
    // Unreachable, wedged or non-JSON — all mean "cannot badge this as a connector".
    return null;
  }
}

/**
 * `POST /inject-fault` — the endpoint the tender's WS3 §1 claims and nothing
 * called until now.
 *
 * `level` null CLEARS the fault, which is how the recovery half of the chaos
 * drill (UC2-041) is driven. Returns the connector's post-injection health so
 * the caller renders what the service actually reports rather than what it
 * asked for — the difference matters when the request is accepted but the
 * fallback chain lands somewhere unexpected.
 */
export async function injectFault(
  deps: ConnectorDeps,
  slug: string,
  sourceSystem: SourceSystem,
  level: 'AMBER' | 'RED' | null,
): Promise<IntegrationHealth | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 4000, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrlFor(slug).replace(/\/$/, '')}/inject-fault`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level }),
        signal,
      });
      if (!res.ok) return null;
      return toIntegrationHealth((await res.json()) as ConnectorHealthBody, sourceSystem);
    });
  } catch {
    return null;
  }
}

/** One step of the chaos rehearsal, as the connector reports it. */
export interface ConnectorDrillStep {
  step: string;
  injected: 'AMBER' | 'RED' | null;
  expectedTier: string;
  tier: string;
  matched: boolean;
  emitted: number;
  mode: string;
  degradation: string;
  upstream: string | null;
  note: string | null;
  why: string;
}

/** The whole rehearsal transcript for one source. */
export interface ConnectorDrillReport {
  sourceSystem: string;
  liveUpstreamConfigured: boolean;
  steps: ConnectorDrillStep[];
  allMatched: boolean;
}

/**
 * `POST /drill` — the UC2-041 rehearsal, run inside the connector.
 *
 * Server-side on purpose. Walking the tiers from the browser would mean four
 * round-trips whose ordering the network could disturb, and the transcript would
 * be assembled by the thing being tested. Here the connector performs four real
 * polls under four real injected conditions and hands back what happened,
 * including the steps that did NOT reach their tier.
 *
 * The budget is generous because a drill is four polls, each of which may make a
 * live upstream call — this is the one endpoint that is allowed to take seconds.
 */
export async function runDrill(
  deps: ConnectorDeps,
  slug: string,
): Promise<ConnectorDrillReport | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.drillTimeoutMs ?? 30000, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrlFor(slug).replace(/\/$/, '')}/drill`, {
        method: 'POST', signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ConnectorDrillReport;
      // A transcript with no steps proves nothing and must not render as a pass.
      return Array.isArray(body?.steps) && body.steps.length > 0 ? body : null;
    });
  } catch {
    return null;
  }
}

/** `POST /poll` — run one fallback-chain cycle and report which tier served. */
export async function pollConnector(
  deps: ConnectorDeps,
  slug: string,
): Promise<ConnectorPollBody | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 8000, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrlFor(slug).replace(/\/$/, '')}/poll`, {
        method: 'POST', signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as ConnectorPollBody;
      return typeof body?.emitted === 'number' ? body : null;
    });
  } catch {
    return null;
  }
}

/**
 * `GET /published` — the CloudEvents the connector actually emitted.
 *
 * This is the evidence half of the ticket: a health card is a claim, whereas the
 * published events are what downstream would have consumed. Returns [] rather
 * than null on an empty feed, because "connected and quiet" and "not connected"
 * are different states and only the caller's health probe distinguishes them.
 */
export async function publishedEvents(
  deps: ConnectorDeps,
  slug: string,
): Promise<PublishedEvent[] | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 4000, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrlFor(slug).replace(/\/$/, '')}/published`, { signal });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return null;
      return body.filter((e): e is PublishedEvent =>
        Boolean(e) && typeof (e as PublishedEvent).topic === 'string');
    });
  } catch {
    return null;
  }
}
