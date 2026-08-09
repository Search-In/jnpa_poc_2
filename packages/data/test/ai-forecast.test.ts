/**
 * UC2-015 — the gate-queue forecast must come from the real model, and must say
 * so when it does not.
 *
 * The defect being fixed: the dashboard computed forecasts from a TypeScript
 * heuristic while the Python services sat unreachable behind a compose file with
 * no `ports:`. Nothing on screen distinguished the two, so "proven end-to-end"
 * was untrue and a single curl would have shown it.
 *
 * The acceptance is behavioural — killing the service must visibly degrade the
 * panel — so these tests exercise the kill: health down, predict down, and a
 * malformed response, each of which must produce a labelled fallback rather than
 * a plausible-looking number.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { MockAdapter } from '../src/mock-adapter.js';
import { AiForecastAdapter } from '../src/ai-forecast-adapter.js';
import { toInstance, GATE_QUEUE_FEATURES } from '../src/ai-forecast.js';

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;
const base = () => new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });

const NOW = () => new Date('2026-07-20T09:00:00Z');

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 503, json: async () => body } as unknown as Response;
}

/** A service that answers health and predicts a flat queue. */
function upstream(queue = 9, version = '0.1.0') {
  return vi.fn(async (url: unknown, init?: unknown) => {
    const u = String(url);
    if (u.endsWith('/health')) return json({ model: 'gate-queue-forecaster', ready: true, version });
    const sent = JSON.parse(String((init as { body?: string })?.body ?? '{}')) as { instances: number[][] };
    return json({
      predictions: sent.instances.map(() => queue),
      detail: sent.instances.map(() => ({ predictedQueue: queue, deferralRecommended: queue > 8 })),
    });
  });
}

describe('feature encoding', () => {
  it('sends the five features in the order the model was trained on', () => {
    // Reordering these silently produces confident nonsense — the model has no
    // way to tell it was handed hour_cos where it expected queue_lag1.
    expect(GATE_QUEUE_FEATURES).toEqual([
      'queue_lag1', 'queue_lag2', 'hour_sin', 'hour_cos', 'uc3_truck_inflow',
    ]);
    const row = toInstance({ queueLag1: 9, queueLag2: 6, hour: 9, uc3TruckInflow: 8 });
    expect(row).toHaveLength(5);
    expect(row[0]).toBe(9);
    expect(row[1]).toBe(6);
    expect(row[4]).toBe(8);
  });

  it('encodes the hour cyclically, so 23:00 and 00:00 are adjacent', () => {
    const a = toInstance({ queueLag1: 0, queueLag2: 0, hour: 23, uc3TruckInflow: 0 });
    const b = toInstance({ queueLag1: 0, queueLag2: 0, hour: 0, uc3TruckInflow: 0 });
    const dist = Math.hypot(a[2]! - b[2]!, a[3]! - b[3]!);
    expect(dist).toBeLessThan(0.3);
  });
});

describe('when the model answers', () => {
  it('labels the forecast MODEL and carries the version', async () => {
    const fetchImpl = upstream(9, '0.1.0');
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue', fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW,
    });

    const f = await a.getGateQueueForecast('NSICT-G1');

    expect(f.source).toBe('MODEL');
    expect(f.modelVersion).toBe('0.1.0');
    expect(f.fallbackReason).toBeUndefined();
    expect(f.curve.length).toBeGreaterThan(0);
    expect(f.curve.every((p) => p.predictedQueue === 9)).toBe(true);
  });

  it('takes the deferral decision from the model, not from a second threshold', async () => {
    // Two places deciding the same thing is how the rake forecaster ended up with
    // two disagreeing sets of maths (UC2-016).
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue',
      fetchImpl: upstream(9) as unknown as typeof fetch,
      now: NOW,
    });
    const hot = await a.getGateQueueForecast('NSICT-G1');
    expect(hot.recommendedDeferralWindows.length).toBeGreaterThan(0);

    const b = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue',
      fetchImpl: upstream(2) as unknown as typeof fetch,
      now: NOW,
    });
    const calm = await b.getGateQueueForecast('NSICT-G1');
    expect(calm.recommendedDeferralWindows).toHaveLength(0);
  });

  it('probes health once, however many forecasts are asked for', async () => {
    const fetchImpl = upstream();
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue', fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW,
    });

    await a.getGateQueueForecast('NSICT-G1');
    await a.getGateQueueForecast('NSICT-G2');

    const healthCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).endsWith('/health'));
    expect(healthCalls).toHaveLength(1);
  });
});

describe('when the model is killed — the acceptance case', () => {
  it('degrades to the heuristic and SAYS so when health fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue', fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW,
    });

    const f = await a.getGateQueueForecast('NSICT-G1');

    // A blank panel would be worse; a silent heuristic would be worse still.
    expect(f.source).toBe('HEURISTIC');
    expect(f.fallbackReason).toMatch(/health check/i);
    expect(f.curve.length).toBeGreaterThan(0);
  });

  it('degrades when the service is up but predict fails', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => (
      String(url).endsWith('/health')
        ? json({ model: 'gate-queue-forecaster', ready: true, version: '0.1.0' })
        : json({ error: 'boom' }, false)));
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue', fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW,
    });

    const f = await a.getGateQueueForecast('NSICT-G1');

    expect(f.source).toBe('HEURISTIC');
    expect(f.fallbackReason).toMatch(/usable prediction/i);
  });

  it('refuses a response of the wrong shape rather than half-reading it', async () => {
    // Fewer predictions than steps. Padding or truncating would put a confident
    // curve on screen that the model never produced.
    const fetchImpl = vi.fn(async (url: unknown) => (
      String(url).endsWith('/health')
        ? json({ model: 'gate-queue-forecaster', ready: true })
        : json({ predictions: [1, 2] })));
    const a = new AiForecastAdapter(base(), {
      gateQueueBaseUrl: '/ai/gate-queue', fetchImpl: fetchImpl as unknown as typeof fetch, now: NOW,
    });

    expect((await a.getGateQueueForecast('NSICT-G1')).source).toBe('HEURISTIC');
  });
});

describe('the heuristic labels itself even when used directly', () => {
  it('stamps HEURISTIC at the source, not at the decorator', async () => {
    // So a panel bound to the bare MockAdapter cannot show an unlabelled curve.
    const f = await base().getGateQueueForecast('NSICT-G1');
    expect(f.source).toBe('HEURISTIC');
  });
});
