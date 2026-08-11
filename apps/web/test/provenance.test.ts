/**
 * UC2-064 — the board's account of itself must be true, and must stay true.
 *
 * The defect: the header carried ONE word for the whole board (`adapter.mode`),
 * and the board is genuinely mixed. Deployed, `VITE_DATA_MODE` is never set so
 * the chip reads SIMULATED — while Import, Export, Movements, CFS/ECY and Data
 * Quality serve the real ingested corpus and say so on their own badges. One of
 * the two is wrong on every screen.
 *
 * The most valuable test here is the last one: a provenance map maintained by
 * hand goes stale, and a stale one is worse than none — a confident claim nobody
 * re-checks. So it is pinned to the adapter that actually does the delegating.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TABS } from '../src/tabs.js';
import {
  SIMULATOR_BACKED_READS, boardSummary, screenProvenance, provenanceTone,
  type ProvenanceContext,
} from '../src/state/provenance.js';

/** How the deployed build is actually configured today. */
const DEPLOYED: ProvenanceContext = {
  cargoSource: 'poc3', baseMode: 'mock', connectorsLive: true,
};

describe('the map covers the board', () => {
  it('has an entry for every tab, and no entry for a tab that does not exist', () => {
    // A missing entry would render a screen with no provenance line at all —
    // silently reintroducing exactly the gap this ticket closes.
    const mapped = screenProvenance(DEPLOYED).map((s) => s.tab).sort();
    const tabs = TABS.map((t) => t.id).sort();
    expect(mapped).toEqual(tabs);
  });

  it('gives every screen a summary someone can read aloud', () => {
    for (const s of screenProvenance(DEPLOYED)) {
      expect(s.summary.length, s.tab).toBeGreaterThan(20);
      expect(s.summary.trim().endsWith('.'), s.tab).toBe(true);
    }
  });

  it('names both halves of every MIXED screen', () => {
    // MIXED without naming the parts is the vaguest possible honesty — it tells
    // a viewer something is wrong without telling them which number to distrust.
    for (const s of screenProvenance(DEPLOYED).filter((x) => x.provenance === 'MIXED')) {
      if (s.summary.includes('Probing')) continue;   // the in-flight probe state
      expect(s.real, s.tab).toBeTruthy();
      expect(s.simulated, s.tab).toBeTruthy();
    }
  });
});

describe('what the deployed build actually is', () => {
  const screens = screenProvenance(DEPLOYED);
  const of = (tab: string) => screens.find((s) => s.tab === tab)!;

  it('calls the POC-3-sourced registers real', () => {
    for (const tab of ['import', 'export', 'movements', 'cfsecy', 'dataquality']) {
      expect(of(tab).provenance, tab).toBe('REAL');
    }
  });

  it('calls the simulator-backed screens simulated, and says what is missing', () => {
    expect(of('rail').provenance).toBe('SIMULATED');
    expect(of('rail').summary).toMatch(/neither has been ingested/);
    expect(of('itrho').provenance).toBe('SIMULATED');
    expect(of('empty').provenance).toBe('SIMULATED');
    // Empty is the trap: real empty-container movements DO exist, one tab away.
    expect(of('empty').summary).toMatch(/CFS\/ECY/);
  });

  it('does not let the browser-only workflow ledger read as a backend', () => {
    expect(of('workflows').provenance).toBe('BROWSER');
    expect(of('workflows').summary).toMatch(/devtools/);
    expect(of('workflows').summary).toMatch(/not audit evidence/);
  });

  it('follows the connectors rather than assuming them', () => {
    const live = screenProvenance({ ...DEPLOYED, connectorsLive: true });
    const down = screenProvenance({ ...DEPLOYED, connectorsLive: false });
    const probing = screenProvenance({ ...DEPLOYED, connectorsLive: null });
    expect(live.find((s) => s.tab === 'health')!.provenance).toBe('REAL');
    expect(down.find((s) => s.tab === 'health')!.provenance).toBe('SIMULATED');
    // In flight is NOT optimistically live.
    expect(probing.find((s) => s.tab === 'health')!.provenance).not.toBe('REAL');
  });

  it('drops every screen to simulated when cargo is not sourced from POC-3', () => {
    const offline = screenProvenance({ cargoSource: 'mock', baseMode: 'mock', connectorsLive: false });
    expect(offline.every((s) => s.provenance !== 'REAL')).toBe(true);
  });
});

describe('the header summary', () => {
  it('says MIXED for the board as deployed, and gives the counts', () => {
    const s = boardSummary(screenProvenance(DEPLOYED));
    expect(s.label).toBe('MIXED');
    expect(s.real).toBeGreaterThan(0);
    expect(s.simulated).toBeGreaterThan(0);
    expect(s.detail).toMatch(/real/);
    expect(s.detail).toMatch(/simulated/);
  });

  it('never says LIVE while a single screen is simulated', () => {
    // The failure mode being prevented: a viewer who trusts the header on one
    // tab trusts it on all of them, so "mostly live" has to read as MIXED.
    const almost = screenProvenance(DEPLOYED).map((s, i) =>
      ({ ...s, provenance: (i === 0 ? 'SIMULATED' : 'REAL') as const }));
    expect(boardSummary(almost).label).not.toBe('LIVE');
  });

  it('says SIMULATED only when nothing real is left', () => {
    const none = screenProvenance({ cargoSource: 'mock', baseMode: 'mock', connectorsLive: false });
    expect(boardSummary(none).label).toBe('SIMULATED');
  });

  it('excludes the document screens from the data-source count', () => {
    // Methodology and the model cards are documents. Counting them as real would
    // inflate the number that describes DATA.
    const screens = screenProvenance(DEPLOYED);
    const s = boardSummary(screens);
    expect(s.real + s.mixed + s.simulated)
      .toBe(screens.filter((x) => x.provenance !== 'STATIC').length);
    expect(s.detail).not.toMatch(new RegExp(`of ${screens.length} `));
  });

  it('tones REAL good, MIXED warn and the rest muted', () => {
    expect(provenanceTone('REAL')).toBe('good');
    expect(provenanceTone('MIXED')).toBe('warn');
    expect(provenanceTone('SIMULATED')).toBe('muted');
    expect(provenanceTone('BROWSER')).toBe('muted');
    expect(provenanceTone('STATIC')).toBe('muted');
  });
});

describe('the map is pinned to the adapter that does the delegating', () => {
  it('matches every `return this.base.X` in Poc3CargoAdapter', () => {
    // THIS is the test that matters. Without it the map is a comment: someone
    // makes getRailSide real, the Rail tab keeps saying "simulated", and nobody
    // notices until an evaluator does. Make one of these real and this fails
    // until the list and the tab map above are both updated.
    const src = readFileSync(
      fileURLToPath(new URL('../../../packages/data/src/poc3-cargo-adapter.ts', import.meta.url)),
      'utf8',
    );
    const delegated = new Set(
      [...src.matchAll(/return this\.base\.(\w+)\(/g)].map((m) => m[1]!),
    );
    delegated.delete('mode');   // a getter, not a read

    expect([...delegated].sort()).toEqual([...SIMULATOR_BACKED_READS].sort());
  });

  it('every delegated read is a method the adapter contract declares', async () => {
    const { MockAdapter } = await import('@jnpa/data');
    const terminals = (await import('../../../config/terminals.json', { with: { type: 'json' } })).default;
    const baselines = (await import('../../../config/baselines.json', { with: { type: 'json' } })).default;
    const base = new MockAdapter({
      terminalsConfig: terminals as never, baselines: baselines as never,
    });
    for (const m of SIMULATOR_BACKED_READS) {
      expect(typeof (base as never as Record<string, unknown>)[m], m).toBe('function');
    }
  });
});
