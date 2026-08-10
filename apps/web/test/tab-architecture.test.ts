/**
 * Guards the lifecycle-led tab architecture.
 *
 * The tabs were restructured so each leg owns its own steps as sub-views (Import
 * holds IGM/scan/OOC/E-DO, Export holds the pre-advice/SB/LEO/load list/...), and
 * the former `Customs` and `Scan` top-level tabs were removed. Three things can
 * silently break as a result, none of which the type checker catches:
 *
 *   1. a guided-tour step pointing at a tab that is no longer rendered;
 *   2. a tour step's `view` (an untyped string) naming a sub-view that does not
 *      exist — it would just do nothing;
 *   3. a step on the lifecycle strip whose `view`/`tab` target does not exist —
 *      the chip would be clickable and inert.
 *
 * That third case is the reason the strip is worth guarding: it is the primary
 * navigation now, so a dead target is a dead tab.
 */
import { describe, it, expect } from 'vitest';
import { SCENARIO_SCRIPTS } from '../src/sim/scenarioPlayer.js';
import { TABS } from '../src/tabs.js';
import {
  EXPORT_STEPS, IMPORT_STEPS, SHARED_SURFACES, EXPORT_VIEWS, IMPORT_VIEWS,
} from '../src/panels/lifecycleSpec.js';

const TAB_IDS = new Set<string>(TABS.map((t) => t.id));
/** Which sub-view list applies to a tab that has them. */
const VIEWS_BY_TAB: Record<string, readonly string[]> = {
  import: IMPORT_VIEWS,
  export: EXPORT_VIEWS,
};

describe('tab architecture', () => {
  it('no longer exposes the dissolved Customs and Scan tabs', () => {
    expect(TAB_IDS.has('igm')).toBe(false);
    expect(TAB_IDS.has('scan')).toBe(false);
  });

  it('leads with the two lifecycle legs', () => {
    expect(TABS.map((t) => t.id).slice(0, 2)).toEqual(['import', 'export']);
  });

  it('every guided-tour step targets a rendered tab', () => {
    for (const script of SCENARIO_SCRIPTS) {
      for (const [i, step] of script.steps.entries()) {
        expect(TAB_IDS.has(step.tab), `${script.id} step ${i} -> tab "${step.tab}"`).toBe(true);
      }
    }
  });

  it('every guided-tour step view exists on the tab it targets', () => {
    for (const script of SCENARIO_SCRIPTS) {
      for (const [i, step] of script.steps.entries()) {
        if (!step.view) continue;
        const views = VIEWS_BY_TAB[step.tab];
        expect(views, `${script.id} step ${i} sets a view on tab "${step.tab}", which has none`)
          .toBeDefined();
        expect(views, `${script.id} step ${i} -> view "${step.view}"`).toContain(step.view);
      }
    }
  });

  it('every lifecycle step resolves to a real view or a rendered tab', () => {
    const cases = [
      ['import', IMPORT_STEPS, IMPORT_VIEWS],
      ['export', EXPORT_STEPS, EXPORT_VIEWS],
    ] as const;
    for (const [leg, steps, views] of cases) {
      for (const s of steps) {
        if (s.view) expect(views, `${leg} step ${s.no} -> view "${s.view}"`).toContain(s.view);
        if (s.tab) expect(TAB_IDS.has(s.tab), `${leg} step ${s.no} -> tab "${s.tab}"`).toBe(true);
      }
    }
  });

  it('keeps both legs at exactly the ten canonical steps', () => {
    // The strip prints "N of 10". Adding an unnumbered surface to `steps` would
    // silently restate coverage, so shared surfaces live in SHARED_SURFACES.
    expect(IMPORT_STEPS).toHaveLength(10);
    expect(EXPORT_STEPS).toHaveLength(10);
    expect(IMPORT_STEPS.map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(EXPORT_STEPS.map((s) => s.no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('every shared surface points at a top-level tab', () => {
    for (const s of Object.values(SHARED_SURFACES)) {
      expect(TAB_IDS.has(s.tab), `shared surface -> tab "${s.tab}"`).toBe(true);
    }
  });
});
