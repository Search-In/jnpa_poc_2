/**
 * The replay window — the one week the corpus can actually populate (UC2-013).
 *
 * The live demo runs 10–14 Aug 2026 and the corpus has **zero** data for those
 * dates. The only week with berthing reports, daily status reports, ICD reports
 * and FOIS intimations covering the same days is **20–26 Jul 2026**, so that is
 * the week the clock replays. Anything genuinely live arrives from the JNPA
 * Simulated Port-Data API and is badged separately — never mixed into this.
 *
 * ⚠ WHY THE CLOCK IS CLAMPED. Before this, the clock started on 16-Jun and ran
 * forward without bound, so it drifted into dates the corpus knows nothing
 * about. A dashboard showing a confident, empty 03-Aug is worse than one that
 * refuses to go there: the operator cannot tell "no data" from "nothing
 * happened". The window is therefore a hard boundary, and the clock wraps back
 * to Monday rather than running past Sunday.
 *
 * All times are Asia/Kolkata (+05:30) — the corpus timezone. The constants are
 * epoch-ms so no parsing happens at read time.
 */

/** +05:30 in ms — the corpus is stamped in IST throughout. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Monday 20-Jul-2026, 00:00 IST. */
export const REPLAY_START_MS = Date.UTC(2026, 6, 20, 0, 0, 0) - IST_OFFSET_MS;

/** Sunday 26-Jul-2026, 23:59:59 IST — the last instant the corpus covers. */
export const REPLAY_END_MS = Date.UTC(2026, 6, 26, 23, 59, 59) - IST_OFFSET_MS;

export const REPLAY_LABEL = '20–26 Jul 2026';

/**
 * Why this week and not the demo dates. Shown on the simulator so a presenter
 * never has to improvise the answer, and an evaluator gets it unprompted.
 */
export const REPLAY_RATIONALE =
  'The demo dates (10–14 Aug) have no corpus data at all. 20–26 Jul 2026 is the only '
  + 'week where berthing reports, daily status reports, ICD reports and FOIS intimations '
  + 'all cover the same days, so it is the only window that can populate rail, gate, yard '
  + 'and pendency from real records. Screens replaying it are badged REPLAY, never LIVE.';

/** Playback multipliers offered by the simulator (ticket UC2-013: 1× – 60×). */
export const REPLAY_SPEEDS = [1, 2, 4, 8, 15, 30, 60] as const;

/**
 * Hold a clock reading inside the window.
 *
 * Running PAST the end wraps to the start rather than clamping: a clamped clock
 * sits frozen on Sunday night looking like a hang, whereas a wrap makes it
 * obvious the week is on a loop. Seeking before the start clamps, because that
 * is a deliberate input, not drift.
 */
export function clampToWindow(ms: number): number {
  if (!Number.isFinite(ms)) return REPLAY_START_MS;
  if (ms < REPLAY_START_MS) return REPLAY_START_MS;
  if (ms > REPLAY_END_MS) {
    const span = REPLAY_END_MS - REPLAY_START_MS;
    return REPLAY_START_MS + ((ms - REPLAY_START_MS) % span);
  }
  return ms;
}

/** 0–1 position through the week, for a seek slider. */
export function windowProgress(ms: number): number {
  const span = REPLAY_END_MS - REPLAY_START_MS;
  return Math.min(1, Math.max(0, (clampToWindow(ms) - REPLAY_START_MS) / span));
}

/** Epoch ms for a 0–1 seek position. */
export function msForProgress(p: number): number {
  const span = REPLAY_END_MS - REPLAY_START_MS;
  return REPLAY_START_MS + Math.min(1, Math.max(0, p)) * span;
}

/** The seven replayable days, for a day-picker. */
export const REPLAY_DAYS = Array.from({ length: 7 }, (_, i) => {
  const ms = REPLAY_START_MS + i * 24 * 60 * 60 * 1000;
  return {
    ms,
    /** e.g. "Mon 20 Jul" — rendered in IST, not the viewer's zone. */
    label: new Date(ms + IST_OFFSET_MS).toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
    }),
  };
});

/** Format a clock reading in IST, with the date — never time alone. */
export function formatIst(ms: number): string {
  const d = new Date(clampToWindow(ms) + IST_OFFSET_MS);
  return `${d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
  })} IST`;
}
