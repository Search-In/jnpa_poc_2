/**
 * The "Awaiting out-of-charge" queue's rules.
 *
 * The queue exists because the customs gate is what actually blocks a release
 * (MAEU6123458: VERIFIED + UNDER_INSPECTION → `409 customs_not_cleared`), and the
 * action that resolves it was previously reachable only on one row of a ~11,900-row
 * Movements grid.
 */
import { describe, expect, it } from 'vitest';
import { BLOCKING_CUSTOMS, mergeBlockedPages, waitingLabel } from '../src/panels/awaitingOoc.js';
import { customsActionsFor } from '../src/panels/cargoGates.js';

describe('which containers belong in the queue', () => {
  it('mirrors the server\'s CUSTOMS_BLOCKS_RELEASE exactly', () => {
    // services/cargo/service.py: CUSTOMS_BLOCKS_RELEASE = {"HELD", "UNDER_INSPECTION"}.
    // Drift either hides a container that cannot be released, or lists one that can.
    expect([...BLOCKING_CUSTOMS].sort()).toEqual(['HELD', 'UNDER_INSPECTION']);
  });

  it('offers Record OOC on every queue member', () => {
    // The whole point of the panel: no row may be a dead end.
    for (const cs of BLOCKING_CUSTOMS) {
      expect(customsActionsFor(cs)).toContain('CLEAR');
    }
  });
});

describe('combining one page per disposition', () => {
  const page = <T,>(items: T[], total: number | null) => ({ items, total });

  it('concatenates the rows', () => {
    const merged = mergeBlockedPages([page(['a', 'b'], 2), page(['c'], 1)]);
    expect(merged.items).toEqual(['a', 'b', 'c']);
    expect(merged.total).toBe(3);
  });

  it('refuses to invent a total when one page did not report one', () => {
    // A known half plus an unknown half is not a total. Summing what you have
    // renders an authoritative-looking undercount, and the panel prints it as
    // "showing x of y" — so the operator reads a partial queue as the whole one.
    expect(mergeBlockedPages([page(['a'], 1), page(['b'], null)]).total).toBeNull();
    expect(mergeBlockedPages([page(['a'], null), page(['b'], null)]).total).toBeNull();
  });

  it('reports an empty queue as zero, not unknown', () => {
    expect(mergeBlockedPages([page([], 0), page([], 0)])).toEqual({ items: [], total: 0 });
  });

  it('handles no pages at all', () => {
    expect(mergeBlockedPages([])).toEqual({ items: [], total: 0 });
  });
});

describe('how long a container has been waiting', () => {
  const NOW = Date.parse('2026-08-11T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

  it('counts whole days', () => {
    expect(waitingLabel(daysAgo(3), NOW)).toBe('3d');
    expect(waitingLabel(daysAgo(1), NOW)).toBe('1d');
  });

  it('calls anything under a day "today"', () => {
    expect(waitingLabel(daysAgo(0), NOW)).toBe('today');
    expect(waitingLabel(new Date(NOW - 3600_000).toISOString(), NOW)).toBe('today');
  });

  it('floors clock skew rather than reporting a negative wait', () => {
    // The backend's clock running ahead of the browser's is not a container that
    // has waited -1 days.
    expect(waitingLabel(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe('today');
  });

  it('renders a dash for missing or unparseable timestamps', () => {
    expect(waitingLabel(null, NOW)).toBe('—');
    expect(waitingLabel(undefined, NOW)).toBe('—');
    expect(waitingLabel('', NOW)).toBe('—');
    expect(waitingLabel('not a date', NOW)).toBe('—');
  });
});
