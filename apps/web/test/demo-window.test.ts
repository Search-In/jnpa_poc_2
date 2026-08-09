/**
 * UC2-013 — the replay clock must stay inside the week the corpus can populate.
 *
 * The demo runs 10–14 Aug and the corpus has nothing for those dates. 20–26 Jul
 * 2026 is the only week where berthing, daily status, ICD and FOIS all cover the
 * same days. A clock that wanders outside it renders a confident, empty day that
 * an operator cannot tell apart from "nothing happened" — which is exactly the
 * failure the badge-everything-honestly discipline exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  REPLAY_DAYS, REPLAY_END_MS, REPLAY_SPEEDS, REPLAY_START_MS,
  clampToWindow, formatIst, msForProgress, windowProgress,
} from '../src/sim/demoWindow.js';

const DAY = 24 * 60 * 60 * 1000;

describe('the replay window is the corpus week', () => {
  it('starts Monday 20-Jul-2026 at 00:00 IST', () => {
    // 00:00 IST is 18:30 UTC the previous day — the corpus is stamped in IST.
    const d = new Date(REPLAY_START_MS);
    expect(d.toISOString()).toBe('2026-07-19T18:30:00.000Z');
  });

  it('ends Sunday 26-Jul-2026 at 23:59:59 IST', () => {
    expect(new Date(REPLAY_END_MS).toISOString()).toBe('2026-07-26T18:29:59.000Z');
  });

  it('spans exactly the seven replayable days', () => {
    expect(REPLAY_DAYS).toHaveLength(7);
    expect(REPLAY_DAYS[0]!.label).toContain('20 Jul');
    expect(REPLAY_DAYS[6]!.label).toContain('26 Jul');
  });

  it('offers 1x through 60x as the ticket specifies', () => {
    expect(REPLAY_SPEEDS[0]).toBe(1);
    expect(REPLAY_SPEEDS[REPLAY_SPEEDS.length - 1]).toBe(60);
    // 0.5x is gone: slower than real time on a seven-day replay is not a demo.
    expect(REPLAY_SPEEDS as readonly number[]).not.toContain(0.5);
  });
});

describe('the clock cannot leave the window', () => {
  it('clamps a seek before the start', () => {
    expect(clampToWindow(REPLAY_START_MS - 30 * DAY)).toBe(REPLAY_START_MS);
  });

  it('wraps rather than freezing when it runs past the end', () => {
    // A clamped clock sitting on Sunday night reads as a hang; a wrap reads as
    // a loop, which is what a week-long replay actually is.
    const past = REPLAY_END_MS + 2 * DAY;
    const wrapped = clampToWindow(past);

    expect(wrapped).toBeGreaterThanOrEqual(REPLAY_START_MS);
    expect(wrapped).toBeLessThan(REPLAY_END_MS);
    expect(wrapped).not.toBe(REPLAY_END_MS);
  });

  it('leaves a reading inside the window untouched', () => {
    const wed = REPLAY_START_MS + 2 * DAY + 9 * 60 * 60 * 1000;
    expect(clampToWindow(wed)).toBe(wed);
  });

  it('survives a corrupt reading instead of propagating NaN', () => {
    expect(clampToWindow(Number.NaN)).toBe(REPLAY_START_MS);
    expect(clampToWindow(Number.POSITIVE_INFINITY)).toBe(REPLAY_START_MS);
  });
});

describe('seeking', () => {
  it('round-trips a position through the week', () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      expect(windowProgress(msForProgress(p))).toBeCloseTo(p, 5);
    }
  });

  it('reports 0 at the start and 1 at the end', () => {
    expect(windowProgress(REPLAY_START_MS)).toBe(0);
    expect(windowProgress(REPLAY_END_MS)).toBe(1);
  });
});

describe('the clock always shows the date', () => {
  it('renders day, date and IST — never a bare time', () => {
    // "14:32" alone is indistinguishable from now, which is the whole point of
    // replaying a week five months in the past.
    const text = formatIst(REPLAY_START_MS + 9 * 60 * 60 * 1000);

    expect(text).toContain('20 Jul');
    expect(text).toContain('Mon');
    expect(text).toContain('IST');
    expect(text).toContain('09:00');
  });
});
