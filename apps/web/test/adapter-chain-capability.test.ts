/**
 * The adapter CHAIN must not lose capabilities between its links.
 *
 * ⚠ THE DEFECT THIS PINS. `DataAdapter` declares ~49 OPTIONAL methods — the
 * whole customs/gate/export surface — implemented only by `Poc3CargoAdapter`.
 * `SimAdapter`, the outermost link, branches on existence:
 * `this.base.getIgmManifests ? … : unavailable()`. Because those methods are
 * optional, a middle decorator that fails to re-expose one produces NO type
 * error. It just makes SimAdapter report the data as unavailable, and the panel
 * renders empty while the backend serves it correctly.
 *
 * That is precisely what shipped with UC2-015: `AiForecastAdapter` was inserted
 * between Poc3CargoAdapter and SimAdapter with a hand-written pass-through list
 * covering only the 14 REQUIRED methods. The IGM, RMS, OOC, E-DO, LEO, Shipping
 * Bill, SMTP, EIR, PIN, advance-list, COPRAR/COARRI and CFS/ECY panels all went
 * blank, in both LIVE and DEMO, and every test stayed green.
 *
 * So the assertion here is deliberately not a list of method names — a list is
 * the same mistake one level up. It is "whatever the inner adapter can do, the
 * outermost adapter can still do".
 */
import { describe, expect, it } from 'vitest';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { MockAdapter, Poc3CargoAdapter, AiForecastAdapter, type DataAdapter } from '@jnpa/data';
import { SimAdapter } from '../src/sim/SimAdapter.js';

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

/** Every function-valued member reachable on an object, own + prototype chain. */
function methodsOf(obj: object): Set<string> {
  const out = new Set<string>();
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(o, key);
      if (desc && typeof desc.value === 'function') out.add(key);
    }
  }
  return out;
}

function poc3(): DataAdapter {
  const base = new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });
  return new Poc3CargoAdapter(base, { cargoBaseUrl: '/poc3' });
}

describe('AiForecastAdapter preserves the capabilities it wraps', () => {
  it('re-exposes every method of the adapter below it', () => {
    const inner = poc3();
    const wrapped = new AiForecastAdapter(inner, { gateQueueBaseUrl: '/ai/gate-queue' });

    const lost = [...methodsOf(inner)].filter((m) => typeof (wrapped as never)[m] !== 'function');

    expect(lost, `AiForecastAdapter dropped: ${lost.join(', ')}`).toEqual([]);
  });

  it('still overrides the one method it exists to override', async () => {
    // Adoption must not clobber getGateQueueForecast with a blind pass-through,
    // or the model would never be consulted and UC2-015 would be undone.
    const inner = poc3();
    const wrapped = new AiForecastAdapter(inner, {
      gateQueueBaseUrl: '/ai/gate-queue',
      fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch,
    });

    const f = await wrapped.getGateQueueForecast('NSICT-G1');

    expect(f.source).toBe('HEURISTIC');
    expect(f.fallbackReason).toMatch(/health check/i);
  });
});

describe('the full production chain keeps the customs surface reachable', () => {
  // Poc3CargoAdapter -> AiForecastAdapter -> SimAdapter, exactly as AppContext
  // builds it. Panels only ever hold the last one.
  const chain = new SimAdapter(
    new AiForecastAdapter(poc3(), { gateQueueBaseUrl: '/ai/gate-queue' }),
  );

  it('does not report POC-3-backed reads as unavailable', async () => {
    // The IGM tab's exact call. Before the fix this rejected with
    // "unavailable in this data mode" while /api/customs/igm returned 16 rows.
    let reached = false;
    const spy = new SimAdapter(
      new AiForecastAdapter(
        Object.assign(poc3(), { getIgmManifests: async () => { reached = true; return []; } }),
        { gateQueueBaseUrl: '/ai/gate-queue' },
      ),
    );

    await expect(spy.getIgmManifests!({ limit: 200 })).resolves.toEqual([]);
    expect(reached, 'the call never reached Poc3CargoAdapter').toBe(true);
  });

  it('keeps the whole optional surface, not just the one that was reported', () => {
    // Named explicitly because each is a panel a demo would open.
    for (const m of ['getIgmManifests', 'getIgmContainers', 'getRmsScanLists',
      'getOocRecords', 'getEdoRecords', 'getShippingBills', 'getLeoRecords',
      'getSmtpRecords', 'getEirTransactions', 'getPinTickets', 'getAdvanceList',
      'getCoprarItems', 'getCoarriMoves', 'getCfsEcyStats', 'getTerminalYardStatus']) {
      expect(typeof (chain as never)[m], `${m} missing from the chain`).toBe('function');
    }
  });

  it('still reports genuinely absent capabilities as absent', () => {
    // The other half of the contract: a mock build must not look like a live
    // backend that is merely failing. MockAdapter serves no customs registers.
    const mockOnly = new SimAdapter(
      new AiForecastAdapter(
        new MockAdapter({ terminalsConfig: terminals, baselines, seed: 1 }),
        { gateQueueBaseUrl: '/ai/gate-queue' },
      ),
    );

    return expect(mockOnly.getIgmManifests!()).rejects.toThrow(/unavailable/i);
  });
});
