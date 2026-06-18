import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/mock-adapter.js';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

function adapter() {
  return new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });
}

describe('MockAdapter — runs the whole dashboard surface offline', () => {
  const a = adapter();
  const win = a.window;

  it('mode is mock', () => {
    expect(a.mode).toBe('mock');
  });

  it('getFacilities + getTerminals', async () => {
    expect((await a.getTerminals()).length).toBe(5);
    expect((await a.getFacilities()).length).toBeGreaterThan(5);
  });

  it('getContainerMovements returns DTOs with trails', async () => {
    const moves = await a.getContainerMovements({});
    expect(moves.length).toBeGreaterThan(0);
    expect(moves[0]!.trail.length).toBeGreaterThan(0);
    expect(moves[0]!.container.containerNo).toMatch(/^[A-Z]{3}U\d{7}$/);
  });

  it('filters movements by originStream', async () => {
    const transship = await a.getContainerMovements({ originStream: 'TRANSSHIP' });
    expect(transship.every((m) => m.container.originStream === 'TRANSSHIP')).toBe(true);
  });

  it('getGateOps returns per-gate queue + avg txn time', async () => {
    const ops = await a.getGateOps(win);
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]).toHaveProperty('queueLength');
    expect(ops[0]).toHaveProperty('avgTxnTimeMin');
  });

  it('getGateQueueForecast returns a 30–120 min curve', async () => {
    const fc = await a.getGateQueueForecast('NSICT-G1');
    expect(fc.curve.length).toBe(8); // 15..120 step 15
    expect(fc.curve[0]).toHaveProperty('predictedQueue');
  });

  it('getPendency returns facility-keyed pendency', async () => {
    const pend = await a.getPendency();
    expect(pend.length).toBeGreaterThan(0);
    expect(pend[0]).toHaveProperty('geom');
  });

  it('getRailSide T1/T2 returns rakes + wagons', async () => {
    const rail = await a.getRailSide('T1', win);
    expect(rail.siding).toBe('T1');
    expect(Array.isArray(rail.rakes)).toBe(true);
  });

  it('getKPIs returns 10 KPIs (7 + 3 rollups)', async () => {
    const kpis = await a.getKPIs();
    expect(kpis.length).toBe(10);
  });

  it('getIntegrationHealth returns 6 sources, all SYNTHETIC in mock', async () => {
    const health = await a.getIntegrationHealth();
    expect(health.length).toBe(6);
    expect(health.every((h) => h.mode === 'SYNTHETIC')).toBe(true);
  });

  it('getNotifications filters by role', async () => {
    const customs = await a.getNotifications('CUSTOMS');
    expect(customs.every((n) => n.audienceRoles.includes('CUSTOMS'))).toBe(true);
    expect(customs.some((n) => n.body.hi.length > 0 && n.body.mr.length > 0)).toBe(true);
  });

  it('role scoping: CFS_OPERATOR sees only CFS facilities', async () => {
    const facilities = await a.getFacilities('CFS_OPERATOR');
    expect(facilities.length).toBeGreaterThan(0);
    expect(facilities.every((f) => f.type === 'CFS')).toBe(true);
  });
});

describe('MockAdapter — scenarios produce before/after deltas + actions', () => {
  const a = adapter();

  for (const id of ['CGO-1', 'CGO-2', 'CGO-3', 'LANE-ASSIGN']) {
    it(`${id} recomputes KPIs and fires an automated action`, async () => {
      const r = await a.runScenario(id, {});
      expect(r.scenarioId).toBe(id);
      expect(r.before.length).toBe(10);
      expect(r.after.length).toBe(10);
      expect(r.actions.length).toBeGreaterThan(0);
      // at least one KPI value changed
      const changed = r.after.some((k, i) => k.value !== r.before[i]!.value);
      expect(changed).toBe(true);
    });
  }

  it('CGO-2 emits a cross-twin push to UC3', async () => {
    const r = await a.runScenario('CGO-2', { surgeCount: 50, gateId: 'NSICT-G1' });
    expect(r.actions.some((act) => act.kind === 'CROSS_TWIN_PUSH' && act.target === 'UC3')).toBe(true);
  });

  it('is deterministic: same scenario → identical after-KPIs', async () => {
    const r1 = await adapter().runScenario('CGO-3', {});
    const r2 = await adapter().runScenario('CGO-3', {});
    expect(r1.after.map((k) => k.value)).toEqual(r2.after.map((k) => k.value));
  });
});
