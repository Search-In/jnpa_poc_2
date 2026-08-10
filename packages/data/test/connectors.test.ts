/**
 * UC2-040 — the four connector endpoints must be real, and must say so.
 *
 * The defect being fixed: `connectors_common/base.py` has implemented `/health`,
 * `/poll`, `/inject-fault` and `/published` since day one, and
 * `07_WS_Claims_vs_Implementation.md` lists the WS3 §1 claim as **verified** on
 * that basis. But all six containers were declared with no `ports:`, so nothing
 * could call them, and the dashboard drove a localStorage fault store instead.
 * The code existed; the integration did not.
 *
 * The acceptance is behavioural — stopping a connector must visibly change its
 * card — so these tests exercise the kill: health down, partial outage, and a
 * malformed body, each of which must produce a labelled fallback rather than a
 * plausible-looking traffic light.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { MockAdapter } from '../src/mock-adapter.js';
import { ConnectorAdapter } from '../src/connector-adapter.js';
import { CONNECTORS, toIntegrationHealth } from '../src/connectors.js';

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;
const base = () => new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body } as unknown as Response;
}

/** A connector answering /health as the Python service does. */
function card(source: string, degradation = 'GREEN', mode = 'LIVE') {
  return {
    sourceSystem: source, lastGoodPollTs: '2026-07-20T09:00:00Z',
    errorCount: 0, degradation, mode, note: 'polled',
  };
}

/** All six up. */
function allUp(degradation = 'GREEN', mode: string = 'LIVE') {
  return vi.fn(async (url: unknown) => {
    const slug = String(url).split('/connectors/')[1]?.split('/')[0] ?? '';
    const c = CONNECTORS.find((x) => x.slug === slug);
    return c ? json(card(c.sourceSystem, degradation, mode)) : json({}, false);
  });
}

const adapter = (fetchImpl: unknown) =>
  new ConnectorAdapter(base(), { fetchImpl: fetchImpl as typeof fetch });

describe('the connector list', () => {
  it('covers exactly the six sources the mock adapter reports', async () => {
    // If these drifted, the panel would gain or lose a card the moment a
    // connector went down — which is precisely the state the drill must show
    // clearly rather than confuse.
    const mockSources = (await base().getIntegrationHealth()).map((h) => h.sourceSystem).sort();
    expect(CONNECTORS.map((c) => c.sourceSystem).sort()).toEqual(mockSources);
  });
});

describe('when the connectors answer', () => {
  it('badges every card CONNECTOR and carries the service’s own values', async () => {
    const health = await adapter(allUp('AMBER', 'CACHED')).getIntegrationHealth();

    expect(health).toHaveLength(6);
    expect(health.every((h) => h.source === 'CONNECTOR')).toBe(true);
    expect(health.every((h) => h.degradation === 'AMBER')).toBe(true);
    expect(health.every((h) => h.mode === 'CACHED')).toBe(true);
    expect(health.every((h) => h.fallbackReason === undefined)).toBe(true);
  });

  it('keeps mode and source as separate claims', async () => {
    // A real connector honestly reporting SYNTHETIC is NOT the same as a card
    // the browser invented, and the pair must be able to say so.
    const health = await adapter(allUp('GREEN', 'SYNTHETIC')).getIntegrationHealth();

    expect(health[0]!.mode).toBe('SYNTHETIC');
    expect(health[0]!.source).toBe('CONNECTOR');
  });

  it('probes every connector, not just the first', async () => {
    const fetchImpl = allUp();
    await adapter(fetchImpl).getIntegrationHealth();

    const probed = new Set(fetchImpl.mock.calls.map((c) => String(c[0])));
    expect(probed.size).toBe(6);
    for (const c of CONNECTORS) {
      expect([...probed].some((u) => u.includes(`/connectors/${c.slug}/health`))).toBe(true);
    }
  });
});

describe('when a connector is killed — the acceptance case', () => {
  it('degrades that ONE card to SIMULATED and says why', async () => {
    // Partial outage is the interesting case: a batch probe that failed together
    // would hide exactly what the chaos drill exists to show.
    const fetchImpl = vi.fn(async (url: unknown) => {
      const slug = String(url).split('/connectors/')[1]?.split('/')[0] ?? '';
      if (slug === 'icegate') throw new Error('ECONNREFUSED');
      const c = CONNECTORS.find((x) => x.slug === slug);
      return c ? json(card(c.sourceSystem)) : json({}, false);
    });

    const health = await adapter(fetchImpl).getIntegrationHealth();

    const icegate = health.find((h) => h.sourceSystem === 'ICEGATE')!;
    expect(icegate.source).toBe('SIMULATED');
    expect(icegate.fallbackReason).toMatch(/ICEGATE/);
    expect(health.filter((h) => h.source === 'CONNECTOR')).toHaveLength(5);
  });

  it('still shows all six cards when every connector is down', async () => {
    // A blank Integration tab would be worse; a silently simulated one worse still.
    const health = await adapter(vi.fn(async () => { throw new Error('down'); }))
      .getIntegrationHealth();

    expect(health).toHaveLength(6);
    expect(health.every((h) => h.source === 'SIMULATED')).toBe(true);
    expect(health.every((h) => h.fallbackReason)).toBe(true);
  });

  it('refuses a health body of the wrong shape rather than half-reading it', async () => {
    const fetchImpl = vi.fn(async () => json({ sourceSystem: 'ULIP', degradation: 'PURPLE' }));

    const health = await adapter(fetchImpl).getIntegrationHealth();

    expect(health.every((h) => h.source === 'SIMULATED')).toBe(true);
  });

  it('treats a non-2xx as down, not as an empty card', async () => {
    const health = await adapter(vi.fn(async () => json({ error: 'boom' }, false)))
      .getIntegrationHealth();

    expect(health.every((h) => h.source === 'SIMULATED')).toBe(true);
  });
});

describe('health mapping', () => {
  it('keys on OUR slug→source pairing, not the body’s self-report', async () => {
    // A connector misreporting its own name would otherwise create a seventh
    // card or silently overwrite another source's.
    const mapped = toIntegrationHealth(card('NOT-A-REAL-SOURCE'), 'ULIP');
    expect(mapped?.sourceSystem).toBe('ULIP');
  });

  it('rejects a body with a non-numeric error count', () => {
    expect(toIntegrationHealth({ ...card('ULIP'), errorCount: 'many' as never }, 'ULIP')).toBeNull();
  });

  it('accepts lower-case enums, since Python may send either', () => {
    const m = toIntegrationHealth({ ...card('ULIP'), degradation: 'amber', mode: 'cached' }, 'ULIP');
    expect(m?.degradation).toBe('AMBER');
    expect(m?.mode).toBe('CACHED');
  });
});

describe('inject-fault — the endpoint nothing called until now', () => {
  it('posts the level and returns what the connector then reports', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: unknown) => {
      seen.push({ url: String(url), body: JSON.parse(String((init as { body?: string })?.body ?? '{}')) });
      return json(card('ULIP', 'RED', 'SYNTHETIC'));
    });

    const out = await adapter(fetchImpl).injectConnectorFault('ULIP', 'RED');

    expect(seen[0]!.url).toContain('/connectors/ulip/inject-fault');
    expect(seen[0]!.body).toEqual({ level: 'RED' });
    expect(out?.degradation).toBe('RED');
    expect(out?.source).toBe('CONNECTOR');
  });

  it('sends null to CLEAR a fault — the recovery half of the drill', async () => {
    let sent: unknown;
    const fetchImpl = vi.fn(async (_u: unknown, init?: unknown) => {
      sent = JSON.parse(String((init as { body?: string })?.body ?? '{}'));
      return json(card('ULIP'));
    });

    await adapter(fetchImpl).injectConnectorFault('ULIP', null);

    expect(sent).toEqual({ level: null });
  });

  it('returns null when the connector is unreachable, rather than claiming success', async () => {
    const out = await adapter(vi.fn(async () => { throw new Error('down'); }))
      .injectConnectorFault('ULIP', 'RED');
    expect(out).toBeNull();
  });

  it('returns null for a source that has no connector', async () => {
    expect(await adapter(allUp()).injectConnectorFault('NOPE' as never, 'RED')).toBeNull();
  });
});

describe('published events — evidence rather than claim', () => {
  it('returns what the connector emitted', async () => {
    const events = [{ topic: 'jnpa.integration.health', event: { id: '1' } }];
    const out = await adapter(vi.fn(async () => json(events))).getPublishedEvents('TOS');
    expect(out).toEqual(events);
  });

  it('distinguishes "connected and quiet" from "not connected"', async () => {
    // [] and null mean different things and the panel branches on it.
    expect(await adapter(vi.fn(async () => json([]))).getPublishedEvents('TOS')).toEqual([]);
    expect(await adapter(vi.fn(async () => { throw new Error('x'); })).getPublishedEvents('TOS'))
      .toBeNull();
  });
});

describe('the decorator preserves what it wraps', () => {
  it('re-exposes every method of the adapter below it', () => {
    // The bug that blanked the dashboard: a middle decorator dropping optional
    // methods is legal TypeScript and produces no error at all.
    const inner = base();
    const wrapped = new ConnectorAdapter(inner);
    const methods = new Set<string>();
    for (let o: object | null = inner; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(o, k);
        if (d && typeof d.value === 'function') methods.add(k);
      }
    }
    const lost = [...methods].filter((m) => typeof (wrapped as never)[m] !== 'function');
    expect(lost, `ConnectorAdapter dropped: ${lost.join(', ')}`).toEqual([]);
  });
});
