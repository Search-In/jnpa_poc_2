/**
 * Presentation rules for the seven UC-II model blocks. Pure — no React, no I/O —
 * so ordering, tone and value formatting are unit-tested without rendering.
 *
 * The service's document is deliberately open (a model may publish a new field
 * tomorrow) and ships its own glossary, so the panel renders WHATEVER it is
 * handed. This module adds only the three things a generic renderer cannot
 * derive from the data:
 *
 *   1. **Order and title.** M1 before M7, and a human name per block.
 *   2. **The headline.** Which one of six to fourteen fields is the number an
 *      operator looks at first.
 *   3. **Tone.** Which verdicts are good, marginal or bad. This is domain
 *      knowledge — 'CRIT' is red and 'THROTTLE' is amber because of what they
 *      mean at a gate, not because of anything in the string.
 *
 * A block the service sends that is NOT listed here still renders, after the
 * known ones, under its raw id. Dropping an unknown model would hide exactly
 * the thing worth looking at.
 */

import type { ModelBlock, ModelFieldValue } from '../../data/ml/types.js';

export interface ModelView {
  /** Block id in the response, e.g. 'UC2-M1'. */
  id: string;
  /** Short human title for the card header. */
  title: string;
  /** The field an operator reads first. */
  headline?: string;
  /** Unit suffix for the headline. */
  unit?: string;
  /** Field whose value is rendered as the card's status chip. */
  statusKey?: string;
  /** Fields the component renders itself, so the key/value grid skips them. */
  richKeys?: string[];
  /**
   * True when this block describes the GATE or the YARD rather than the
   * container on screen. Drives the scope label — see Gotcha 6: nobody should
   * be able to read "3 lanes down" as a fact about the box they opened.
   */
  facilityLevel?: boolean;
}

/** Display order and headline per model. Ids match the service's block keys. */
export const MODEL_VIEWS: ModelView[] = [
  {
    id: 'UC2-M1',
    title: 'M1 · Container dwell',
    headline: 'dwellHours',
    unit: 'h',
    statusKey: 'engine',
    richKeys: ['accuracyDisclosure', 'realCorpusUnavailableReason'],
  },
  {
    id: 'UC2-M4',
    title: 'M4 · Document & event chain',
    headline: 'findingCount',
    statusKey: 'worstSeverity',
    richKeys: ['trailUsed'],
  },
  {
    id: 'UC2-M2',
    title: 'M2 · Rake turnaround',
    headline: 'tatHours',
    unit: 'h',
    statusKey: 'engine',
  },
  {
    id: 'UC2-M3',
    title: 'M3 · Gate queue',
    headline: 'queueVehicles',
    unit: 'vehicles',
    statusKey: 'deferralRecommended',
  },
  {
    id: 'UC2-M5',
    title: 'M5 · Vessel berth stay',
    headline: 'projectedTotalStayHours',
    unit: 'h',
    statusKey: 'status',
  },
  {
    id: 'UC2-M6',
    title: 'M6 · Gate lane assignment',
    headline: 'worstWaitMinutes',
    unit: 'min',
    statusKey: 'status',
    richKeys: ['facility_scope'],
    facilityLevel: true,
  },
  {
    id: 'UC2-M7',
    title: 'M7 · Empty pool & reefer plugs',
    headline: 'shortfall',
    unit: 'reefers',
    statusKey: 'status',
    richKeys: ['facility_scope'],
    facilityLevel: true,
  },
];

/** Look up a view by block id, or synthesise one for an unknown model. Pure. */
export function viewFor(id: string): ModelView {
  return MODEL_VIEWS.find((v) => v.id === id) ?? { id, title: humaniseKey(id) };
}

/**
 * Order the blocks the service actually returned: the known ones first in spec
 * order, then anything unrecognised under a generated title. Pure.
 */
export function orderedBlocks(
  models: Record<string, ModelBlock>,
): Array<{ view: ModelView; block: ModelBlock }> {
  const known = MODEL_VIEWS.flatMap((view) => {
    const block = models[view.id];
    return block ? [{ view, block }] : [];
  });
  const extra = Object.entries(models)
    .filter(([id]) => !MODEL_VIEWS.some((v) => v.id === id))
    .map(([id, block]) => ({ view: viewFor(id), block }));
  return [...known, ...extra];
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Tone for a status/verdict value. Domain knowledge, deliberately explicit.
 *
 * Note the boolean rule is INVERTED relative to a naive reading: the boolean
 * fields that reach a status chip here are `deferralRecommended` and
 * `throttleRecommended` — true means the gate cannot cope, which is bad news,
 * not good news. Unknown text is neutral rather than optimistically green.
 * Pure.
 */
export function statusTone(value: ModelFieldValue): Tone {
  if (typeof value === 'boolean') return value ? 'warn' : 'good';
  if (value === null || value === undefined) return 'neutral';
  const text = String(value).trim().toUpperCase();
  if (['OK', 'CLEAR', 'ON PLAN', 'ON_PLAN', 'NORMAL', 'CLEAN', 'GOOD', 'AHEAD'].includes(text)) {
    return 'good';
  }
  if (['WARN', 'WARNING', 'MARGINAL', 'TIGHT', 'DEGRADED', 'THROTTLE', 'AT RISK',
       'AT_RISK', 'BEHIND', 'CONSTRAINED'].includes(text)) {
    return 'warn';
  }
  if (['CRIT', 'CRITICAL', 'BREACH', 'INFEASIBLE', 'BLOCKED', 'SHORT', 'FAIL',
       'FAILED', 'OVERDUE'].includes(text)) {
    return 'bad';
  }
  return 'neutral';
}

/** 'dwellHours' → 'Dwell hours' … readable without a second glossary. Pure. */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Render one leaf value for display. Pure.
 *
 * Numbers keep at most two decimals — the models return figures already rounded
 * for display, and re-rounding here would be the second place that decision
 * lives. `null` renders as an em dash, never as 0: "no value" and "zero" are
 * different answers, and a 0 h dwell is not the same as an unknown one.
 */
export function formatValue(value: ModelFieldValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // An empty string is "not stated", not a blank cell. Rendered raw it leaves a
  // gap that reads as broken UI rather than as an absent value.
  if (typeof value === 'string') return value.trim() === '' ? '—' : value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  }
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => formatValue(v)).join(', ') : '—';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length
      ? entries.map(([k, v]) => `${humaniseKey(k)}: ${formatValue(v)}`).join(' · ')
      : '—';
  }
  return String(value);
}

/**
 * The fields of a block, in the order the service sent them, minus the ones the
 * component renders itself. Pure.
 */
export function gridFields(
  block: ModelBlock,
  view: ModelView,
): Array<[string, ModelFieldValue]> {
  const skip = new Set(
    [...(view.richKeys ?? []), view.headline, view.statusKey, 'headline'].filter(
      Boolean,
    ) as string[],
  );
  return Object.entries(block).filter(([key]) => !skip.has(key));
}
