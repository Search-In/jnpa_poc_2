/**
 * UC2-041 — the console half of the chaos rehearsal.
 *
 * Two things are under test, and the second is a defect this ticket found rather
 * than one it introduced:
 *
 *  1. the drill verdict, which must never read as a pass for a rehearsal in
 *     which nothing moved;
 *  2. `applyIntegrationFaults`, which overwrote a CONNECTOR-backed card's
 *     degradation and mode while leaving `source: 'CONNECTOR'` on it — a
 *     browser-invented traffic light presented as a connector's own report.
 */
import { describe, expect, it } from 'vitest';
import type { IntegrationHealth } from '@jnpa/schemas';
import { applyIntegrationFaults, type FaultState, type SourceFault } from '../src/console/faultStore.js';
import {
  drillTranscript, drillVerdict, levelForMode, tiersLine, type DrillReport,
} from '../src/console/drill.js';

function step(over: Partial<DrillReport['steps'][number]> = {}) {
  return {
    step: '1 · baseline', injected: null, expectedTier: 'LIVE', tier: 'LIVE',
    matched: true, emitted: 5, mode: 'LIVE', degradation: 'GREEN',
    upstream: 'POC-3 replay (traffic-three)', note: 'Live read from POC-3.',
    why: 'No fault.', ...over,
  } as DrillReport['steps'][number];
}

const passing: DrillReport = {
  sourceSystem: 'ULIP',
  liveUpstreamConfigured: true,
  allMatched: true,
  steps: [
    step(),
    step({ step: '2 · degrade', injected: 'AMBER', expectedTier: 'CACHED', tier: 'CACHED', mode: 'CACHED' }),
    step({ step: '3 · outage', injected: 'RED', expectedTier: 'SYNTHETIC', tier: 'SYNTHETIC', mode: 'SYNTHETIC' }),
    step({ step: '4 · recover' }),
  ],
};

describe('the console control vocabulary maps onto the connector’s', () => {
  it('clears on LIVE, degrades on AMBER, and marks down on RED', () => {
    expect(levelForMode('LIVE')).toBeNull();
    expect(levelForMode('DEGRADED')).toBe('AMBER');
    expect(levelForMode('OFFLINE')).toBe('RED');
  });

  it('treats the kill switch as RED whatever the mode says', () => {
    // The kill switch is the hard one — it must not be softened into AMBER by a
    // mode the operator left behind on the segmented control.
    expect(levelForMode('LIVE', true)).toBe('RED');
    expect(levelForMode('DEGRADED', true)).toBe('RED');
  });
});

describe('the drill verdict', () => {
  it('reports a clean walk of all three tiers', () => {
    const v = drillVerdict(passing);
    expect(v.tone).toBe('pass');
    expect(v.detail).toBe('LIVE → CACHED → SYNTHETIC → LIVE');
  });

  it('refuses to call an unconfigured run a pass — nothing fell anywhere', () => {
    // The tempting bug: every step lands on SYNTHETIC, the outage step "matches"
    // its expected SYNTHETIC, and a naive score reads 1/4 or even a green tick.
    // With no tier above it the chain never fell; the rehearsal proved nothing.
    const unconfigured: DrillReport = {
      sourceSystem: 'ULIP',
      liveUpstreamConfigured: false,
      allMatched: false,
      steps: passing.steps.map((s) => ({ ...s, tier: 'SYNTHETIC', matched: false })),
    };

    const v = drillVerdict(unconfigured);

    expect(v.tone).toBe('unconfigured');
    expect(v.headline).toMatch(/could not move/);
    expect(v.detail).toMatch(/POC3_BASE_URL/);
  });

  it('names the steps that missed rather than scoring them away', () => {
    const partial: DrillReport = {
      ...passing,
      allMatched: false,
      steps: passing.steps.map((s, i) =>
        i === 1 ? { ...s, tier: 'SYNTHETIC', matched: false } : s),
    };

    const v = drillVerdict(partial);

    expect(v.tone).toBe('partial');
    expect(v.headline).toBe('3 of 4 steps reached their tier');
    expect(v.detail).toMatch(/2 · degrade wanted CACHED, got SYNTHETIC/);
  });

  it('says a drill that did not run is not a pass', () => {
    for (const empty of [null, { ...passing, steps: [] }]) {
      const v = drillVerdict(empty as DrillReport | null);
      expect(v.tone).toBe('none');
      expect(v.detail).toMatch(/not a pass/);
    }
  });
});

describe('the transcript', () => {
  it('keeps the steps that missed — evidence, not marketing', () => {
    const partial: DrillReport = {
      ...passing,
      allMatched: false,
      steps: passing.steps.map((s, i) =>
        i === 2 ? { ...s, tier: 'CACHED', matched: false } : s),
    };

    const text = drillTranscript(partial);

    expect(text).toMatch(/3 · outage {2}\[MISSED\]/);
    expect(text.match(/\[reached\]|\[MISSED\]/g)).toHaveLength(4);
    expect(text).toMatch(/live upstream configured: yes/);
  });

  it('carries the upstream and the note, not just the tier', () => {
    const text = drillTranscript(passing);
    expect(text).toMatch(/POC-3 replay \(traffic-three\)/);
    expect(text).toMatch(/Live read from POC-3\./);
  });

  it('renders the sequence in the order it happened', () => {
    expect(tiersLine(passing)).toBe('LIVE → CACHED → SYNTHETIC → LIVE');
  });
});

// ---------------------------------------------------------------------------
function faults(over: Partial<SourceFault>): FaultState {
  const one: SourceFault = {
    mode: 'LIVE', stale: false, latencySec: 0, killed: false, recoveredCount: 0, ...over,
  };
  return { open: false, sources: { ULIP: one }, reconciliations: [] };
}

const connectorCard: IntegrationHealth = {
  sourceSystem: 'ULIP', errorCount: 0, degradation: 'GREEN', mode: 'LIVE',
  source: 'CONNECTOR', upstream: 'POC-3 replay (traffic-three)',
};
const simulatedCard: IntegrationHealth = {
  sourceSystem: 'ULIP', errorCount: 0, degradation: 'GREEN', mode: 'LIVE',
  source: 'SIMULATED', fallbackReason: 'nothing answered',
};

describe('the browser overlay never rewrites a connector’s own card', () => {
  it('leaves a CONNECTOR card exactly as the service reported it', () => {
    // The defect: the overlay spread `...h`, so it changed degradation and mode
    // while `source: 'CONNECTOR'` survived — a card the browser invented,
    // wearing the badge that means a service spoke.
    for (const mode of ['DEGRADED', 'OFFLINE'] as const) {
      const [out] = applyIntegrationFaults([connectorCard], faults({ mode }));
      expect(out).toEqual(connectorCard);
    }
    const [killed] = applyIntegrationFaults([connectorCard], faults({ killed: true }));
    expect(killed).toEqual(connectorCard);
    const [stale] = applyIntegrationFaults([connectorCard], faults({ stale: true }));
    expect(stale).toEqual(connectorCard);
  });

  it('still drives a SIMULATED card, which is what the console is for offline', () => {
    const [degraded] = applyIntegrationFaults([simulatedCard], faults({ mode: 'DEGRADED' }));
    expect(degraded!.degradation).toBe('AMBER');
    expect(degraded!.mode).toBe('CACHED');
    expect(degraded!.source).toBe('SIMULATED');

    const [offline] = applyIntegrationFaults([simulatedCard], faults({ mode: 'OFFLINE' }));
    expect(offline!.degradation).toBe('RED');
    expect(offline!.mode).toBe('SYNTHETIC');
  });

  it('leaves a card whose source is unknown to the old behaviour', () => {
    // Absent `source` is read as SIMULATED everywhere else; the overlay must
    // agree, or a mock-only build would silently stop reacting to the console.
    const legacy: IntegrationHealth = { ...simulatedCard };
    delete (legacy as { source?: unknown }).source;
    const [out] = applyIntegrationFaults([legacy], faults({ mode: 'DEGRADED' }));
    expect(out!.mode).toBe('CACHED');
  });
});

describe('the console control reconciles mode and kill in one place', () => {
  it('un-killing a source clears it rather than re-killing it', async () => {
    // The bug this covers: the kill-switch handler passed the still-killed
    // `effectiveMode` ('OFFLINE') alongside `killed: false`, and the two
    // together re-killed the source — the switch could be turned on but never
    // off. Deriving the level from the store's RECONCILED state fixes it, so
    // that is what is asserted here.
    const { faultStore: store } = await import('../src/console/faultStore.js');
    store.resetAll();

    store.setKilled('ULIP', true);
    expect(store.getState().sources.ULIP!.killed).toBe(true);
    expect(levelForMode(store.getState().sources.ULIP!.mode, true)).toBe('RED');

    store.setKilled('ULIP', false);
    const after = store.getState().sources.ULIP!;

    expect(after.killed).toBe(false);
    expect(after.mode).toBe('LIVE');
    expect(levelForMode(after.mode, after.killed)).toBeNull();
  });
});
