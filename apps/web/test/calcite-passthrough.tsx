/**
 * A faithful stand-in for `@esri/calcite-components-react` in node tests.
 *
 * WHY IT EXISTS
 * -------------
 * The Calcite React wrappers are `@lit/react` bindings: on render they look the
 * tag up in `customElements` and throw *"Custom element calcite-icon not
 * found"* if it is not registered. Registration needs a DOM, and this repo's
 * tests run in node with no DOM dependency. So the wrappers are replaced.
 *
 * WHY IT IS SHAPED LIKE THIS — READ BEFORE CHANGING IT
 * ----------------------------------------------------
 * A mock that does not mirror the real component hides the bug you are testing.
 * The UC-1 build of this feature was bitten twice, and both are designed out
 * here rather than commented about:
 *
 *   1. A `CalciteSheet` mock UNMOUNTED its children when closed; the real one
 *      keeps them mounted. A regression test for the blank-on-second-open
 *      defect then passed with AND without the fix — worthless.
 *      → This stand-in ALWAYS renders `children`. It has no open/closed
 *        concept at all, so it cannot diverge on that axis.
 *
 *   2. A `CalciteChip` mock DROPPED `title`, so a test asserting hover content
 *      failed for the wrong reason.
 *      → This stand-in forwards EVERY prop, and `title` in particular is the
 *        load-bearing one: the glossary, the estimated-inputs list and the
 *        facility-scope explanation all reach the operator through it.
 *
 * `test/calcite-passthrough.test.tsx` asserts both properties directly, so the
 * stand-in cannot silently drift back into either failure mode.
 *
 * It is a PASSTHROUGH, not a simulation: it renders the same tag name with the
 * same attributes and the same children. It does not model Calcite behaviour,
 * and no test here should depend on Calcite behaviour — which is also why the
 * predictions drawer is a plain <aside role="dialog"> rather than a
 * CalciteSheet.
 */

import { createElement, forwardRef } from 'react';
import type { ReactNode } from 'react';

/** 'CalciteIcon' → 'calcite-icon'. */
function tagFor(name: string): string {
  return name
    .replace(/^Calcite/, 'calcite-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** React camelCase props → the attribute names the real element receives. */
function attrFor(prop: string): string {
  if (prop === 'className') return 'class';
  if (prop === 'htmlFor') return 'for';
  return prop.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

type Props = Record<string, unknown> & { children?: ReactNode };

function passthrough(name: string) {
  const tag = tagFor(name);
  const Component = forwardRef<unknown, Props>(function CalciteStandIn(props, _ref) {
    const { children, ...rest } = props;
    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      // Event handlers have no HTML attribute form; everything else is
      // forwarded, including `title`, `aria-*`, `slot` and `style`.
      if (/^on[A-Z]/.test(key)) continue;
      if (value === undefined || value === null || value === false) continue;
      if (key === 'style') { attrs.style = value; continue; }
      attrs[attrFor(key)] = value === true ? '' : value;
    }
    // Children are ALWAYS rendered. See note 1 above.
    return createElement(tag, attrs, children);
  });
  Component.displayName = name;
  return Component;
}

export const CalciteButton = passthrough('CalciteButton');
export const CalciteChip = passthrough('CalciteChip');
export const CalciteIcon = passthrough('CalciteIcon');
export const CalciteLoader = passthrough('CalciteLoader');
export const CalciteNotice = passthrough('CalciteNotice');
export const CalciteTable = passthrough('CalciteTable');
export const CalciteTableRow = passthrough('CalciteTableRow');
export const CalciteTableCell = passthrough('CalciteTableCell');
export const CalciteTableHeader = passthrough('CalciteTableHeader');
export const CalciteSelect = passthrough('CalciteSelect');
export const CalciteOption = passthrough('CalciteOption');
export const CalciteInput = passthrough('CalciteInput');
export const CalciteLabel = passthrough('CalciteLabel');
export const CalciteList = passthrough('CalciteList');
export const CalciteListItem = passthrough('CalciteListItem');
