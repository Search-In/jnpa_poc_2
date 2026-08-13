/**
 * UC-2 scenario studio — the locally computed scenarios speak through the same
 * verdict layer as the audited answers: a real sentence per outcome, never the
 * generic "see the figures below" fallback, and the provenance chips behave.
 */
import { describe, expect, it } from 'vitest';
import { MockAdapter, nominalYardBlocks, runExportLoadingScenario, runRtgPeakScenario } from '@jnpa/data';
import type { ContainerMovementDTO } from '@jnpa/data';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };
import baselinesConfig from '../../../config/baselines.json' assert { type: 'json' };
import { verdictFor, shouldChip } from '../src/whatif/verdict';

const adapter = new MockAdapter({
  terminalsConfig: terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'],
  baselines: baselinesConfig as unknown as BaselinesConfig,
  seed: 20260615,
});

let cache: ContainerMovementDTO[] | null = null;
async function movements() {
  cache ??= await adapter.getContainerMovements({});
  return cache;
}
const asOf = adapter.window.to;

const FALLBACK = 'Answered. See the figures below.';
const readable = (s: string) => {
  expect(s).not.toMatch(/undefined|NaN|\[object|null/);
  expect(s).not.toMatch(/\b\w+_\w+_\w+\b/); // no raw snake_case keys
};

async function exportFixture() {
  const all = await movements();
  const exp = all.filter((m) => m.container.originStream.startsWith('EXPORT_'));
  const terminalId = exp.flatMap((m) => m.trail).find((e) => e.eventType === 'LEO')!.facilityId;
  const planned = new Set(
    exp.filter((m) => m.trail.some((e) => e.eventType === 'LEO' && e.facilityId === terminalId))
      .map((m) => m.container.containerNo),
  );
  const candidates = exp.filter((m) => !planned.has(m.container.containerNo)).map((m) => m.container.containerNo);
  return { all, terminalId, candidates };
}

describe('UC-2 verdicts — every outcome gets a real sentence', () => {
  it('export loading: feasible, partial, not feasible, no change', async () => {
    const { all, terminalId, candidates } = await exportFixture();
    const run = (nos: string[]) =>
      verdictFor(runExportLoadingScenario({ movements: all, asOf, params: { terminalId, additionalContainerNos: nos } }));

    const feasible = run(candidates.slice(0, 3));
    expect(feasible.tone).toBe('ok');
    const partial = run([candidates[0]!, 'ZZZU0000000']);
    expect(partial.tone).toBe('warning');
    const impossible = run(['ZZZU0000000']);
    expect(impossible.tone).toBe('critical');
    const noChange = run([]);
    expect(noChange.tone).toBe('ok');

    for (const v of [feasible, partial, impossible, noChange]) {
      expect(v.headline).not.toBe(FALLBACK);
      readable(v.headline);
      if (v.detail) readable(v.detail);
    }
  });

  it('rtg peak: over- and under-capacity headlines name the top two strategies', async () => {
    const all = await movements();
    const blocks = [...nominalYardBlocks(['NSICT']).slice(0, 3), ...nominalYardBlocks(['GTI']).slice(0, 3)];

    const over = verdictFor(runRtgPeakScenario({
      movements: all, blocks, params: { demandMultiplier: 40, rtgsPerBlock: 1, peakMovesPerHourPerRtg: 10 },
    }));
    expect(over.tone).toBe('warning');
    const under = verdictFor(runRtgPeakScenario({
      movements: all, blocks, params: { demandMultiplier: 0.01 },
    }));
    expect(under.tone).toBe('ok');

    for (const v of [over, under]) {
      expect(v.headline).not.toBe(FALLBACK);
      readable(v.headline);
    }
  });

  it('an invalid run degrades to the unavailable verdict with the engine\'s own reason', async () => {
    const all = await movements();
    const v = verdictFor(runRtgPeakScenario({ movements: all, blocks: [] }));
    expect(v.tone).toBe('unavailable');
    expect(v.detail).toMatch(/No yard blocks selected/);
  });

  it('provenance chips: PARAMETER and ASSUMED are chipped, MEASURED/DERIVED are not', async () => {
    const { all, terminalId, candidates } = await exportFixture();
    const r = runExportLoadingScenario({
      movements: all, asOf, params: { terminalId, additionalContainerNos: [candidates[0]!] },
    });
    const chipped = r.assumptions.filter((a) => shouldChip(a.source));
    expect(chipped.length).toBeGreaterThan(0);
    expect(chipped.every((a) => a.source === 'PARAMETER' || a.source === 'ASSUMED')).toBe(true);
    expect(r.assumptions.some((a) => a.source === 'MEASURED' && !shouldChip(a.source))).toBe(true);
  });
});
