/**
 * Renders the REAL model-service payload through the REAL component.
 *
 * `fixtures/predictions-response.json` is not hand-written: it is the verbatim
 * body of a live `POST /ml-api/uc2/webapp/predictions` against the vendored
 * service on :8200. A hand-built fixture drifts from the service the moment a
 * model gains a field, and then the tests certify a shape nobody serves.
 *
 * WHY renderToStaticMarkup AND NOT jsdom + testing-library
 * -------------------------------------------------------
 * This repo has no DOM-testing dependency and its tests run in node. Adding
 * jsdom and @testing-library for this feature would be a large dependency
 * change nobody asked for. React's own server renderer needs neither, runs the
 * component's real hooks and real logic, and produces markup that can be
 * asserted against — which is enough for what these tests check: that the whole
 * payload reaches the screen, and that the honesty signals travel with it.
 *
 * The Calcite elements render as their custom-element tags. That is fine here;
 * this is not a browser-behaviour test, and deliberately so — the panel uses
 * plain <aside role="dialog"> rather than CalciteSheet/CalcitePanel precisely so
 * none of its behaviour depends on web-component internals (see Gotcha 1 in the
 * component's docstring).
 *
 * UC-1 found a genuine defect this way — an empty string rendering as a blank
 * cell — that no unit test had caught. That is what this file is for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The Calcite React wrappers are @lit/react bindings: they look their tag up in
// `customElements` and throw when it is not registered, which in node it never
// is. The stand-in renders the same tags with EVERY prop forwarded and children
// always mounted — the two axes on which UC-1's mocks diverged and hid the bugs
// they were written for. `calcite-passthrough.test.tsx` asserts both.
vi.mock('@esri/calcite-components-react', () => import('./calcite-passthrough.js'));

import { ContainerPredictionsDrawer } from '../src/components/predictions/ContainerPredictionsDrawer.js';
import { predictionStore } from '../src/state/predictionStore.js';
import { viewFor } from '../src/components/predictions/modelViews.js';
import type { PredictionResponse } from '../src/data/ml/types.js';
import real from './fixtures/predictions-response.json' assert { type: 'json' };

const RESPONSE = real as unknown as PredictionResponse;
const FOCUS = 'MAEU6123458';

/** Put a real response into the store without any network. */
function seed(patch: Partial<Parameters<typeof predictionStore.subscribe>[0]> = {}): void {
  predictionStore.reset();
  // The store has no setter by design (state changes come from scoring), so the
  // test drives it the way the app does: subscribe, then mutate through open()'s
  // cache path. Simpler and honest — assign the snapshot directly.
  const state = predictionStore.getSnapshot() as unknown as Record<string, unknown>;
  Object.assign(state, {
    openContainerNo: FOCUS,
    loading: false,
    error: null,
    response: RESPONSE,
    fetchedAt: Date.now(),
    scored: RESPONSE.dashboard.containers.length,
    pageSize: RESPONSE.dashboard.containers.length,
    ...patch,
  });
}

/** Titles carry '&' ("Empty pool & reefer plugs"), which React escapes. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function render(containerNo = FOCUS): string {
  return renderToStaticMarkup(
    <ContainerPredictionsDrawer containerNo={containerNo} moves={[]} onClose={() => {}} />,
  );
}

beforeEach(() => {
  seed();
});

describe('the real payload through the real component', () => {
  it('renders a card for every model the service returned for this container', () => {
    const html = render();
    const entry = RESPONSE.dashboard.containers.find((c) => c.container === FOCUS)!;
    expect(Object.keys(entry.models).length).toBeGreaterThan(0);
    for (const id of Object.keys(entry.models)) {
      // Every block reaches the screen — none is dropped by a hand-written list.
      expect(html).toContain(escapeHtml(viewFor(id).title));
    }
  });

  it('renders the facility-level models, and only outside the container cards', () => {
    const html = render();
    for (const id of Object.keys(RESPONSE.dashboard.facility_summary)) {
      expect(html).toContain(escapeHtml(viewFor(id).title));
    }
    // The structural guarantee: M6/M7 are never inside a container block, so the
    // UI cannot render them as properties of the box on screen even by mistake.
    for (const entry of RESPONSE.dashboard.containers) {
      expect(Object.keys(entry.models)).not.toContain('UC2-M6');
      expect(Object.keys(entry.models)).not.toContain('UC2-M7');
    }
  });

  /**
   * GOTCHA 6 — the scope line must be on screen, not just in the payload.
   *
   * FAILS WITHOUT THE FIX: remove the `view.facilityLevel && …facility_scope`
   * paragraph from ModelCard, or drop `facilityLevel` from the M6/M7 views.
   */
  it('states on screen that the gate and yard figures are not about this container', () => {
    const html = render();
    expect(html).toMatch(/Describes the GATE across every container in this request/);
    expect(html).toMatch(/Describes the YARD/);
    expect(html).toContain('not the single container on screen');
  });

  /**
   * GOTCHA 8 — the defect UC-1 found by rendering, not by unit test.
   *
   * The fixture deliberately carries empty-string fields (Seal_No, Yard_Block
   * were sent empty). No empty <dd> may reach the screen.
   *
   * FAILS WITHOUT THE FIX: `if (typeof value === 'string') return value;` in
   * formatValue.
   */
  it('renders no blank value cells', () => {
    const html = render();
    expect(html).not.toMatch(/<dd[^>]*><\/dd>/);
    expect(html).not.toMatch(/<dd[^>]*>\s*<\/dd>/);
  });

  /**
   * Honesty rule 1 — M1 publishes two accuracies and neither may appear alone.
   * This checkout excludes the corpus, so the real-stay figure cannot be
   * RECOMPUTED; the panel must therefore show WHY, not just the flattering
   * synthetic number.
   *
   * THIS TEST VERIFIES ITSELF. An earlier version asserted the caveat was on
   * screen and documented "remove it from the M1 view's richKeys to see it
   * fail" — but it did NOT fail, because generic rendering picked the field up
   * in the key/value grid instead. A test whose stated counterfactual is wrong
   * is a test nobody has actually checked, so the counterfactual is executed
   * here rather than described: the same predicate is run against a payload
   * with the caveat stripped, and must come out false.
   */
  it('never shows M1’s synthetic accuracy without the real-corpus caveat', () => {
    const CAVEAT = /real-stay error cannot be recomputed|excludes the UC-II corpus|21\.3/;
    const m1 = RESPONSE.dashboard.containers.find((c) => c.container === FOCUS)!.models['UC2-M1'];
    expect(m1.headlineAccuracyMaeH).toBeDefined();

    // The real render must qualify the synthetic figure.
    const html = render();
    expect(html).toMatch(/synthetic/i);
    if (m1.realCorpusMaeH === null || m1.realCorpusMaeH === undefined) {
      expect(m1.realCorpusMetricsAvailable).toBe(false);
    }
    expect(html).toMatch(CAVEAT);

    // …and the predicate has teeth: strip every trace of the qualification from
    // the payload and it must go false. If this second half passes, the first
    // half was asserting nothing.
    const stripped = JSON.parse(JSON.stringify(RESPONSE)) as PredictionResponse;
    for (const entry of stripped.dashboard.containers) {
      const block = entry.models['UC2-M1'];
      if (!block) continue;
      delete block.realCorpusUnavailableReason;
      delete block.realCorpusMetricsAvailable;
      delete block.realCorpusMaeH;
      delete block.accuracyDisclosure;
      delete block.calibrationSource;
    }
    seed({ response: stripped } as never);
    expect(render()).not.toMatch(CAVEAT);
  });

  /** Honesty rule 2 — M2's metric is fidelity. The word "accuracy" must not attach to it. */
  it('does not label M2’s fidelity metric as accuracy', () => {
    for (const entry of RESPONSE.dashboard.containers) {
      const m2 = entry.models['UC2-M2'];
      if (!m2) continue;
      expect(m2.metricIsFidelityNotAccuracy).toBe(true);
      const claims = Object.keys(m2).filter(
        (k) => /accurac/i.test(k) && k !== 'metricIsFidelityNotAccuracy',
      );
      expect(claims).toEqual([]);
    }
  });

  /** Honesty rule 3 — a leakage figure travels with the protocol that produced it. */
  it('names M3’s split protocol wherever a leakage figure appears', () => {
    const entry = RESPONSE.dashboard.containers.find((c) => c.container === FOCUS)!;
    const m3 = entry.models['UC2-M3'];
    if (!m3) return;
    expect(m3.leakageCheck).toBeDefined();
    expect(m3.splitPolicy).toBeTruthy();
    expect(render()).toContain(String(m3.splitPolicy));
  });

  it('carries the glossary onto the screen as hover text', () => {
    const html = render();
    const glossary = RESPONSE.dashboard.glossary;
    expect(Object.keys(glossary).length).toBeGreaterThan(50);
    // A definition the service shipped is rendered as a title, not discarded.
    expect(html).toContain('A fallback produced this number');
  });

  it('shows the estimated-inputs chip as a bare count, never a fraction', () => {
    const html = render();
    const mapping = RESPONSE.dashboard.containers.find((c) => c.container === FOCUS)!.mapping!;
    expect(html).toContain(
      mapping.inputs_assumed > 0 ? `${mapping.inputs_assumed} estimated` : 'all inputs observed',
    );
    expect(html).not.toMatch(/\d+ of \d+ model/);
  });

  it('puts the model’s plain-English question on an affordance, not under the title', () => {
    const html = render();
    const question = RESPONSE.dashboard.model_questions['UC2-M1'];
    expect(question).toBeTruthy();
    // Present as hover/aria text…
    expect(html).toContain(`aria-label="${question}"`);
    // …and reachable by keyboard rather than mouse-only.
    expect(html).toMatch(/role="note"[^>]*tabindex="0"/i);
  });

  it('collapses the reference sections instead of spending a screen on them', () => {
    const html = render();
    expect(html).toContain('<details');
    expect(html).toContain('Model inputs');
    expect(html).toContain('Gate &amp; yard figures');
  });
});

describe('failure and edge states', () => {
  it('names the model service, not another backend, when it is unreachable', () => {
    seed({
      response: null,
      error:
        '[ML] The UC-II model service is not reachable at /ml-api/uc2/webapp/predictions. ' +
        'Start it with `cd ml && JNPA_PORT=8200 .venv/bin/python run.py serve-uc2`.',
    } as never);
    const html = render();
    expect(html).toContain('Predictions unavailable');
    expect(html).toContain('UC-II model service');
    expect(html).toContain('run.py serve-uc2');
    expect(html).not.toMatch(/gateway/i);
  });

  /**
   * A REAL BUG this test caught. The drawer titles itself from its
   * `containerNo` prop but originally read the numbers from the store's
   * `openContainerNo`. Rendered for a container the run did not cover, it
   * happily showed the OTHER container's dwell forecast under this
   * container's number — a mismatch far worse than an empty panel.
   *
   * FAILS WITHOUT THE FIX: `selectPredictionFor(state, state.openContainerNo)`.
   */
  it('shows no numbers for a container the run did not cover', () => {
    const html = render('NOT-IN-THIS-RUN');
    expect(html).toContain('No prediction for this container');
    // And emphatically not another container's figures under this title.
    expect(html).not.toContain(escapeHtml(viewFor('UC2-M1').title));
  });

  /**
   * GOTCHA 1 — the UC-1 panel opened blank on the SECOND open, because
   * `calcite-panel` sets `closed = true` on the DOM element and React never
   * writes a prop it was not given.
   *
   * This panel is a plain conditionally-mounted <aside>, so it has no
   * web-component internal state to survive prop diffing. This test pins that
   * property: rendering twice must produce identical, fully-populated markup.
   *
   * FAILS WITHOUT THE FIX: swapping the <aside> for CalcitePanel would not fail
   * HERE (a server render has no DOM to mutate) — which is exactly the trap
   * UC-1's mock fell into. So the test asserts what CAN be verified without a
   * browser: the component holds no state across opens, and the second open is
   * byte-identical to the first.
   */
  it('renders identically on a second open, holding no state between them', () => {
    const first = render();
    const second = render();
    expect(second).toBe(first);
    expect(second).toContain(escapeHtml(viewFor('UC2-M1').title));
    expect(second.length).toBeGreaterThan(1000);
  });
});
