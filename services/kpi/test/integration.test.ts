import { describe, expect, it } from 'vitest';
import { SimWorld } from '@jnpa/sim';
import { computeAllKpis, computeSevenKpis } from '../src/index.js';
import type { BaselinesConfig } from '../src/index.js';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const config = terminalsConfig as unknown as ConstructorParameters<typeof SimWorld>[0];
const baselines = baselinesConfig as unknown as BaselinesConfig;

describe('KPI engine against the seeded sim dataset', () => {
  const sim = new SimWorld(config, { seed: 20260615 });
  const inputs = {
    asOf: new Date(sim.startMs + sim.windowHours * 3_600_000).toISOString(),
    containers: sim.dataset.containers,
    events: sim.dataset.events,
    gateTransactions: sim.dataset.gateTransactions,
    rakes: sim.dataset.rakes,
    itrho: sim.dataset.itrho,
    scans: sim.dataset.scans,
    baselines,
    bufferDwellThresholdHours: 24,
  };

  it('produces all seven KPIs with finite values and units', () => {
    const kpis = computeSevenKpis(inputs);
    expect(kpis).toHaveLength(7);
    for (const k of kpis) {
      expect(Number.isFinite(k.value), `${k.key} value`).toBe(true);
      expect(k.unit.length).toBeGreaterThan(0);
      expect(Number.isFinite(k.improvementPct), `${k.key} improvement`).toBe(true);
    }
  });

  it('rake TAT lands in a plausible operational range (4–14h)', () => {
    const rake = computeSevenKpis(inputs).find((k) => k.key === 'rakeTurnaroundTime')!;
    expect(rake.value).toBeGreaterThan(4);
    expect(rake.value).toBeLessThan(14);
  });

  it('is deterministic: same seed → identical KPI values', () => {
    const a = computeAllKpis(inputs).map((k) => [k.key, k.value]);
    const sim2 = new SimWorld(config, { seed: 20260615 });
    const b = computeAllKpis({ ...inputs, events: sim2.dataset.events, rakes: sim2.dataset.rakes }).map((k) => [k.key, k.value]);
    expect(a).toEqual(b);
  });

  it('mixed-train utilisation reports a containers/rake figure', () => {
    const mt = computeSevenKpis(inputs).find((k) => k.key === 'mixedTrainOptimization')!;
    expect(mt.higherIsBetter).toBe(true);
    expect(mt.value).toBeGreaterThan(0);
  });

  it('includes gate rollups', () => {
    const all = computeAllKpis(inputs);
    expect(all.map((k) => k.key)).toContain('gateThroughput');
    expect(all.map((k) => k.key)).toContain('gateTransactionTime');
    expect(all.map((k) => k.key)).toContain('containerPendency');
  });
});
