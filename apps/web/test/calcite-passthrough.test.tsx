/**
 * Tests for the test double itself.
 *
 * GOTCHA 3 — "mocks that do not mirror the real component hide the bug you are
 * testing." UC-1 lost time twice to exactly that, in two specific ways. This
 * file pins both, so the stand-in cannot drift back into either without a red
 * test. A mock nobody checks is an assertion nobody made.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalciteChip, CalciteNotice, CalciteButton } from './calcite-passthrough.js';

describe('the Calcite stand-in mirrors the real component', () => {
  /**
   * UC-1 failure 1: a CalciteSheet mock unmounted its children when closed,
   * while the real element keeps them mounted. The regression test it was
   * written for then passed with and without the fix.
   */
  it('always renders its children, in every state', () => {
    const html = renderToStaticMarkup(
      <CalciteNotice open kind="danger">
        <div slot="title">Predictions unavailable</div>
        <div slot="message">the model service is not reachable</div>
      </CalciteNotice>,
    );
    expect(html).toContain('Predictions unavailable');
    expect(html).toContain('the model service is not reachable');

    // …and with `open` absent, which is where the UC-1 mock diverged.
    const closed = renderToStaticMarkup(
      <CalciteNotice kind="danger">
        <div slot="message">still mounted</div>
      </CalciteNotice>,
    );
    expect(closed).toContain('still mounted');
  });

  /**
   * UC-1 failure 2: a CalciteChip mock dropped `title`, so a test asserting
   * hover content failed for the wrong reason. `title` is load-bearing in this
   * panel — the glossary, the estimated-inputs list and the facility-scope
   * explanation all reach the operator through it.
   */
  it('forwards title, so hover content can be asserted', () => {
    const html = renderToStaticMarkup(
      <CalciteChip scale="s" title="3 of the 9 input values were not on the record">
        3 estimated
      </CalciteChip>,
    );
    expect(html).toContain('title="3 of the 9 input values were not on the record"');
    expect(html).toContain('3 estimated');
  });

  it('renders the real tag name so markup assertions mean something', () => {
    expect(renderToStaticMarkup(<CalciteChip>x</CalciteChip>)).toContain('<calcite-chip');
    expect(renderToStaticMarkup(<CalciteButton>y</CalciteButton>)).toContain('<calcite-button');
  });

  it('forwards boolean and aria props rather than swallowing them', () => {
    const html = renderToStaticMarkup(
      <CalciteButton disabled aria-label="Re-score" iconStart="refresh">
        Re-score
      </CalciteButton>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('aria-label="Re-score"');
    expect(html).toContain('icon-start="refresh"');
  });

  it('drops only event handlers, which have no attribute form', () => {
    const html = renderToStaticMarkup(
      <CalciteButton onClick={() => {}} title="kept">
        z
      </CalciteButton>,
    );
    expect(html).toContain('title="kept"');
    expect(html).not.toContain('onClick');
  });
});
