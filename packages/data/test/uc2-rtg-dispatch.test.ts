/**
 * UC-2 Requirement 2 — Multiple Yard Blocks / RTG Peak Demand (§26 test matrix).
 * Inputs come from the same deterministic MockAdapter corpus the dashboard uses.
 */
import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/mock-adapter.js';
import {
  nominalYardBlocks, runRtgPeakScenario, UC2_RTG_PEAK_ID, BLOCKS_PER_TERMINAL,
} from '../src/uc2/rtg-dispatch.js';
import type { ContainerMovementDTO } from '../src/interface.js';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

const adapter = new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });

let movementsCache: ContainerMovementDTO[] | null = null;
async function movements(): Promise<ContainerMovementDTO[]> {
  movementsCache ??= await adapter.getContainerMovements({});
  return movementsCache;
}

const STRATEGIES = ['STATIC_HOME', 'LONGEST_QUEUE', 'HIGHEST_UTILIZATION', 'BALANCED_SPREAD'];

async function blocksFor(terminalIds: string[], perTerminal: number) {
  return terminalIds.flatMap((t) =>
    nominalYardBlocks([t]).slice(0, perTerminal),
  );
}

describe('uc2-rtg-peak — multiple yard blocks at peak RTG demand', () => {
  it('enumerates the repo\'s nominal 12-block grid per terminal', () => {
    const blocks = nominalYardBlocks(['NSICT', 'GTI']);
    expect(blocks).toHaveLength(2 * BLOCKS_PER_TERMINAL);
    expect(blocks[0]).toEqual({ blockId: 'NSICT-Y1', terminalId: 'NSICT' });
    expect(blocks.at(-1)).toEqual({ blockId: 'GTI-Y12', terminalId: 'GTI' });
  });

  it('multiple blocks across terminals: all four strategies simulated with full metrics', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT', 'GTI'], 3),
    });
    expect(r.scenario).toBe(UC2_RTG_PEAK_ID);
    expect(r.data_available).toBe(true);
    const strategies = (r.result as any).strategies as any[];
    expect(strategies.map((s) => s.strategy)).toEqual(STRATEGIES);
    for (const s of strategies) {
      expect(s.utilization_pct).toBeGreaterThanOrEqual(0);
      expect(s.utilization_pct).toBeLessThanOrEqual(100);
      expect(s.idle_rtg_hours).toBeGreaterThanOrEqual(0);
      expect(s.waiting_box_hours).toBeGreaterThanOrEqual(0);
      expect(s.moves_served).toBeGreaterThanOrEqual(0);
      expect(s.moves_per_rtg_hour).toBeGreaterThanOrEqual(0);
      expect(s.per_block.length).toBe(6);
    }
  });

  it('recommends exactly a top-2, ranked by the declared transparent score', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT', 'GTI'], 4),
    });
    const rec = (r.result as any).recommendation;
    expect(rec.rank1.strategy).not.toBe(rec.rank2.strategy);
    expect(rec.rank1.score).toBeGreaterThanOrEqual(rec.rank2.score);
    expect(rec.rank1.why.length).toBeGreaterThanOrEqual(3); // idle, waiting, throughput
    expect(rec.rank2.why.length).toBeGreaterThanOrEqual(3);
    // the ranking table covers all strategies and matches the scores
    const ranking = (r.result as any).ranking as any[];
    expect(ranking).toHaveLength(4);
    expect(ranking[0]!.strategy).toBe(rec.rank1.strategy);
    // weights are visible, not hidden
    expect((r.result as any).weights).toBeDefined();
    expect(r.assumptions.find((a) => a.field === 'scoring_weights')!.source).toBe('PARAMETER');
  });

  it('demand below capacity → no queues, no waiting, and the answer says so', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT'], 2),
      params: { demandMultiplier: 0.01 },
    });
    expect(r.data_available).toBe(true);
    for (const s of (r.result as any).strategies as any[]) {
      expect(s.peak_queue).toBe(0);
      expect(s.waiting_box_hours).toBe(0);
      expect(s.delayed_moves).toBe(0);
    }
    expect(r.figures.demand_exceeds_capacity).toBe(false);
  });

  it('demand above capacity → queues form, waiting accrues, blocks flagged over capacity', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT', 'GTI'], 3),
      params: { demandMultiplier: 40, rtgsPerBlock: 1, peakMovesPerHourPerRtg: 10 },
    });
    expect(r.figures.demand_exceeds_capacity).toBe(true);
    const baseline = ((r.result as any).strategies as any[]).find((s) => s.strategy === 'STATIC_HOME')!;
    expect(baseline.peak_queue).toBeGreaterThan(0);
    expect(baseline.waiting_box_hours).toBeGreaterThan(0);
    expect(baseline.delayed_moves).toBeGreaterThan(0);
    const blocks = (r.result as any).blocks as any[];
    expect(blocks.some((b) => b.over_capacity)).toBe(true);
  });

  it('demand exactly at capacity → served without queue growth', () => {
    // Synthetic single-terminal corpus: exactly capacity moves in the peak hour.
    const mk = (n: number): ContainerMovementDTO[] =>
      Array.from({ length: n }, (_, i) => ({
        container: { containerNo: `TSTU${String(1000000 + i)}` } as any,
        lastEventType: 'YARD_MOVE', lastEventTs: '2026-06-15T06:00:00.000Z', facilityId: 'NSICT',
        trail: [{ eventType: 'YARD_MOVE', ts: '2026-06-15T06:00:00.000Z', facilityId: 'NSICT', sourceSystem: 'TOS' }],
      }));
    // peak = 24 events/h → per-block (÷12) = 2/h ×1 multiplier; capacity 1×2 = 2/h.
    const r = runRtgPeakScenario({
      movements: mk(24),
      blocks: nominalYardBlocks(['NSICT']).slice(0, 2),
      params: { demandMultiplier: 1, rtgsPerBlock: 1, peakMovesPerHourPerRtg: 2, stressHours: 2 },
    });
    const baseline = ((r.result as any).strategies as any[]).find((s) => s.strategy === 'STATIC_HOME')!;
    expect(baseline.peak_queue).toBe(0);
    expect(r.figures.demand_exceeds_capacity).toBe(false);
  });

  it('single yard block still runs (degenerate but legal selection)', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT'], 1),
    });
    expect(r.data_available).toBe(true);
    expect(r.figures.blocks_selected).toBe(1);
  });

  it('missing capacity parameters refuse to run with an explanation', async () => {
    const zero = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT'], 2),
      params: { rtgsPerBlock: 0 },
    });
    expect(zero.data_available).toBe(false);
    expect(zero.notes.join(' ')).toMatch(/rtgsPerBlock/);
    const noBlocks = runRtgPeakScenario({ movements: await movements(), blocks: [] });
    expect(noBlocks.data_available).toBe(false);
  });

  it('identical scores tie-break deterministically and say so', () => {
    // Zero-activity corpus → every strategy identical → all tie at 0.5-weighted score.
    const r = runRtgPeakScenario({
      movements: [],
      blocks: nominalYardBlocks(['NSICT']).slice(0, 3),
    });
    const ranking = (r.result as any).ranking as any[];
    expect(new Set(ranking.map((x) => x.score)).size).toBe(1);
    // fixed documented order breaks the tie
    expect(ranking[0]!.strategy).toBe('STATIC_HOME');
    expect(r.figures.scores_tied).toBe(true);
    expect(r.notes.join(' ')).toMatch(/scored identically/);
  });

  it('waiting/queue derivation is labelled as model-derived, never per-container measured', async () => {
    const r = runRtgPeakScenario({
      movements: await movements(),
      blocks: await blocksFor(['NSICT', 'GTI'], 3),
    });
    expect(r.notes.join(' ')).toMatch(/per-container arrival\/service timestamps for yard moves do not exist/);
    expect((r.result as any).unavailable).toContain('per-container yard waiting timestamps');
    // every declared parameter is chipped as PARAMETER
    for (const f of ['rtgs_per_block', 'peak_moves_per_hour_per_rtg', 'demand_multiplier', 'stress_hours']) {
      expect(r.assumptions.find((a) => a.field === f)!.source).toBe('PARAMETER');
    }
  });

  it('repeated simulation: identical result, corpus untouched, nothing published', async () => {
    const all = await movements();
    const snapshot = JSON.stringify(all);
    const blocks = await blocksFor(['NSICT', 'GTI'], 3);
    const r1 = runRtgPeakScenario({ movements: all, blocks });
    const r2 = runRtgPeakScenario({ movements: all, blocks });
    expect(r2).toEqual(r1);
    expect(JSON.stringify(all)).toBe(snapshot); // original yard/RTG state unchanged
    expect(r1.notes.join(' ')).toMatch(/no operational event is published/);
  });
});
