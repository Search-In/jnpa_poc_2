/**
 * UC-2 Requirement 1 — Additional Export Containers Loading (§26 test matrix).
 * Inputs come from the same deterministic MockAdapter corpus the dashboard uses.
 */
import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/mock-adapter.js';
import {
  runExportLoadingScenario, UC2_EXPORT_LOADING_ID,
} from '../src/uc2/export-loading.js';
import type { ContainerMovementDTO } from '../src/interface.js';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };

const terminals = terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'];
const baselines = baselinesConfig as unknown as BaselinesConfig;

const adapter = new MockAdapter({ terminalsConfig: terminals, baselines, seed: 20260615 });
const asOf = adapter.window.to;

let movementsCache: ContainerMovementDTO[] | null = null;
async function movements(): Promise<ContainerMovementDTO[]> {
  movementsCache ??= await adapter.getContainerMovements({});
  return movementsCache;
}

/** A terminal that actually has LEO'd export boxes, plus candidate additions. */
async function fixture() {
  const all = await movements();
  const leoTerminals = new Map<string, number>();
  for (const m of all) {
    if (!m.container.originStream.startsWith('EXPORT_')) continue;
    for (const e of m.trail) {
      if (e.eventType === 'LEO') leoTerminals.set(e.facilityId, (leoTerminals.get(e.facilityId) ?? 0) + 1);
    }
  }
  const terminalId = [...leoTerminals.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const planned = new Set(
    all
      .filter((m) => m.container.originStream.startsWith('EXPORT_'))
      .filter((m) => m.trail.some((e) => e.eventType === 'LEO' && e.facilityId === terminalId))
      .map((m) => m.container.containerNo),
  );
  const candidates = all
    .filter((m) => m.container.originStream.startsWith('EXPORT_'))
    .filter((m) => !planned.has(m.container.containerNo))
    .map((m) => m.container.containerNo);
  const importNo = all.find((m) => m.container.originStream.startsWith('IMPORT_'))!.container.containerNo;
  const alreadyPlanned = [...planned][0]!;
  return { all, terminalId, candidates, importNo, alreadyPlanned, plannedCount: planned.size };
}

describe('uc2-export-loading — additional export containers', () => {
  it('zero additional containers → NO_CHANGE, zero delay, original intact', async () => {
    const { all, terminalId, plannedCount } = await fixture();
    const r = runExportLoadingScenario({ movements: all, asOf, params: { terminalId, additionalContainerNos: [] } });
    expect(r.scenario).toBe(UC2_EXPORT_LOADING_ID);
    expect(r.data_available).toBe(true);
    expect(r.figures.feasibility).toBe('NO_CHANGE');
    expect(r.figures.original_boxes).toBe(plannedCount);
    expect(r.figures.revised_boxes).toBe(plannedCount);
    expect(r.figures.completion_delay_hours).toBe(0);
  });

  it('one valid additional container → FEASIBLE, planned = 1', async () => {
    const { all, terminalId, candidates } = await fixture();
    const r = runExportLoadingScenario({
      movements: all, asOf,
      params: { terminalId, additionalContainerNos: [candidates[0]!] },
    });
    expect(r.figures.feasibility).toBe('FEASIBLE');
    expect(r.figures.planned_additional).toBe(1);
    expect(r.figures.revised_boxes).toBe((r.figures.original_boxes as number) + 1);
    expect(r.figures.completion_delay_hours).toBeGreaterThan(0);
  });

  it('multiple additional containers → revised counts and derived timing add up', async () => {
    const { all, terminalId, candidates } = await fixture();
    const add = candidates.slice(0, 5);
    const r = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: add },
    });
    expect(r.figures.planned_additional).toBe(add.length);
    const rate = 45.58;
    expect(r.figures.additional_loading_hours).toBeCloseTo(add.length / rate, 2);
    // revised completion is later than original completion by the delay
    const orig = new Date(r.figures.original_completion_anchored as string).getTime();
    const rev = new Date(r.figures.revised_completion_anchored as string).getTime();
    expect(rev).toBeGreaterThan(orig);
  });

  it('invalid containers are refused with reasons: unknown, non-export, already planned, duplicate', async () => {
    const { all, terminalId, candidates, importNo, alreadyPlanned } = await fixture();
    const valid = candidates[0]!;
    const r = runExportLoadingScenario({
      movements: all, asOf,
      params: {
        terminalId,
        additionalContainerNos: [valid, 'ZZZU0000000', importNo, alreadyPlanned, valid],
      },
    });
    expect(r.figures.feasibility).toBe('PARTIALLY_FEASIBLE');
    expect(r.figures.planned_additional).toBe(1);
    const reasons = (r.result as any).additional.unplanned.map((u: any) => u.reason).join(' | ');
    expect(reasons).toContain('not found in the container corpus');
    expect(reasons).toContain('not an export container');
    expect(reasons).toContain('already on the original planned load list');
    expect(reasons).toContain('duplicate');
  });

  it('nothing plannable → NOT_FEASIBLE with real reasons', async () => {
    const { all, terminalId, importNo } = await fixture();
    const r = runExportLoadingScenario({
      movements: all, asOf,
      params: { terminalId, additionalContainerNos: ['ZZZU0000000', importNo] },
    });
    expect(r.figures.feasibility).toBe('NOT_FEASIBLE');
    expect(r.figures.planned_additional).toBe(0);
  });

  it('missing sailing/stowage/capacity data is reported UNAVAILABLE, never invented', async () => {
    const { all, terminalId, candidates } = await fixture();
    const r = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: [candidates[0]!] },
    });
    expect(r.figures.original_sailing).toBeNull();
    expect(r.figures.revised_sailing).toBeNull();
    expect(r.figures.capacity_check).toBe('UNAVAILABLE');
    expect((r.result as any).unavailable).toContain('vessel slot capacity');
    expect((r.result as any).unavailable).toContain('bay/row/tier stowage positions');
    expect(r.notes.join(' ')).toMatch(/Sailing plan: UNAVAILABLE/);
  });

  it('asset plan uses only real asset types and derives feeder moves from trails', async () => {
    const { all, terminalId, candidates } = await fixture();
    const r = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: candidates.slice(0, 4) },
    });
    const assets = (r.result as any).assets as Array<{ asset: string; basis: string }>;
    expect(assets.find((a) => a.asset === 'Quay crane gang')!.basis).toBe('UNAVAILABLE');
    expect(assets.find((a) => a.asset === 'Berth loading rate')!.basis).toBe('PARAMETER');
    expect(assets.find((a) => a.asset === 'Gate / trailer feeder')!.basis).toBe('DERIVED');
    expect(r.figures.trailer_feeder_moves).toBeGreaterThanOrEqual(0);
  });

  it('every assumption carries a provenance source; parameters are declared', async () => {
    const { all, terminalId, candidates } = await fixture();
    const r = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: [candidates[0]!] },
    });
    expect(r.assumptions.length).toBeGreaterThan(0);
    for (const a of r.assumptions) {
      expect(['MEASURED', 'DERIVED', 'ASSUMED', 'PARAMETER']).toContain(a.source);
      expect(a.reason.length).toBeGreaterThan(10);
    }
    expect(r.assumptions.find((a) => a.field === 'berth_moves_per_hour')!.source).toBe('PARAMETER');
    expect(r.queries.length).toBeGreaterThan(0);
    for (const q of r.queries) expect(q.row_count).toBeGreaterThanOrEqual(0);
  });

  it('loading-rate parameter override changes derived timing proportionally', async () => {
    const { all, terminalId, candidates } = await fixture();
    const add = candidates.slice(0, 3);
    const slow = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: add, berthMovesPerHour: 10 },
    });
    expect(slow.figures.additional_loading_hours).toBeCloseTo(add.length / 10, 2);
  });

  it('repeated simulation: identical result, no accumulation, corpus untouched', async () => {
    const { all, terminalId, candidates } = await fixture();
    const snapshot = JSON.stringify(all);
    const params = { terminalId, additionalContainerNos: candidates.slice(0, 3) };
    const r1 = runExportLoadingScenario({ movements: all, asOf, params });
    const r2 = runExportLoadingScenario({ movements: all, asOf, params });
    expect(r2).toEqual(r1); // no cumulative drift
    expect(JSON.stringify(all)).toBe(snapshot); // original plan + corpus unchanged
  });

  it('invalid parameters (no terminal / non-positive rate) refuse to run', async () => {
    const { all, terminalId } = await fixture();
    const noTerm = runExportLoadingScenario({ movements: all, asOf, params: { terminalId: '', additionalContainerNos: [] } });
    expect(noTerm.data_available).toBe(false);
    const badRate = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: [], berthMovesPerHour: 0 },
    });
    expect(badRate.data_available).toBe(false);
  });
});
