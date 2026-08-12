/**
 * What UC-2 reports having handed to UC-III.
 *
 * RELEASED is the terminal state of this lifecycle (`_LIFECYCLE_RANK` has nothing
 * above it) and `cargo.released` is the handover event. The risk this guards is
 * over-claiming: a "handed over" panel must report what was SENT, never imply
 * that UC-III acted on it.
 */
import { describe, expect, it } from 'vitest';
import {
  handoverFor, hasRecordedGateOut, isHandedOver, latestCrossing, UC3_NEXT_STEPS,
} from '../src/panels/uc3Handover.js';

const RELEASED = {
  lifecycle_status: 'RELEASED',
  is_released: true,
  yard_block: 'B-07',
  vehicle_number: 'MH43CQ2814',
  updated_at: '2026-08-11T16:52:00Z',
};

describe('has the container left UC-2?', () => {
  it('accepts either signal, because the two can disagree', () => {
    // Audit W2 made these commit together, but legacy rows predate that — a row
    // flagged is_released with a stale lifecycle has still left.
    expect(isHandedOver(RELEASED)).toBe(true);
    expect(isHandedOver({ lifecycle_status: 'RELEASED' })).toBe(true);
    expect(isHandedOver({ is_released: true })).toBe(true);
    expect(isHandedOver({ lifecycle_status: 'released' })).toBe(true); // case-insensitive
  });

  it('is false for every state before release', () => {
    expect(isHandedOver({ lifecycle_status: 'VERIFIED' })).toBe(false);
    expect(isHandedOver({ lifecycle_status: 'YARD_ASSIGNED', is_released: false })).toBe(false);
    expect(isHandedOver(null)).toBe(false);
    expect(isHandedOver(undefined)).toBe(false);
    expect(isHandedOver({})).toBe(false);
  });
});

describe('the handover facts', () => {
  it('reports the event and the fields it carried', () => {
    const h = handoverFor(RELEASED);
    expect(h?.event).toBe('cargo.released');
    expect(h?.complete).toBe(true);
    expect(h?.facts.find((f) => f.label === 'Yard location')?.value).toBe('B-07');
    expect(h?.facts.find((f) => f.label === 'Vehicle')?.value).toBe('MH43CQ2814');
  });

  it('returns null for a container still in the port', () => {
    // Nothing was handed over, so there is nothing to report.
    expect(handoverFor({ lifecycle_status: 'VERIFIED' })).toBeNull();
    expect(handoverFor(null)).toBeNull();
  });

  it('says WHY a field is absent instead of rendering an empty success', () => {
    // Most demo rows carry no haulage plate. "—" would read as a display gap;
    // the point is that the event never carried the value.
    const h = handoverFor({ ...RELEASED, vehicle_number: null });
    const vehicle = h?.facts.find((f) => f.label === 'Vehicle');
    expect(vehicle?.value).toBeNull();
    expect(vehicle?.absent).toMatch(/no haulage plate/i);
    expect(h?.complete).toBe(false);
  });

  it('treats an empty string as absent, not as a value', () => {
    const h = handoverFor({ ...RELEASED, yard_block: '' });
    expect(h?.facts.find((f) => f.label === 'Yard location')?.value).toBeNull();
    expect(h?.complete).toBe(false);
  });

  it('still reports a partial handover as a real one', () => {
    // UC-III can dispatch against a yard location alone. Withholding the whole
    // panel because one field is missing would hide the handover entirely.
    const h = handoverFor({ lifecycle_status: 'RELEASED', yard_block: 'B-07' });
    expect(h).not.toBeNull();
    expect(h?.complete).toBe(false);
    expect(h?.facts.find((f) => f.label === 'Yard location')?.value).toBe('B-07');
  });
});

describe('what happens next', () => {
  it('names an owner for every step, and never claims UC-2 does them', () => {
    expect(UC3_NEXT_STEPS.length).toBeGreaterThan(0);
    for (const { step, owner } of UC3_NEXT_STEPS) {
      expect(step).toBeTruthy();
      // Every downstream step belongs to UC-III or the terminal — none to UC-2.
      expect(owner).toMatch(/UC-III|Terminal/);
    }
  });

  it('covers the gate documents UC-2 only ever reads', () => {
    const all = UC3_NEXT_STEPS.map((s) => s.step).join(' | ');
    expect(all).toMatch(/Form 13/i);
    expect(all).toMatch(/PIN/i);
    expect(all).toMatch(/EIR/i);
    expect(all).toMatch(/CODECO|gate-out/i);
  });
});

describe('the UC-III return leg — recorded gate crossings', () => {
  const ev = (event_type: string, ts: string | null, extra = {}) =>
    ({ event_type, ts, container_number: 'BEAU5396870', ...extra });

  it('picks the latest crossing by TIMESTAMP, not by array order', () => {
    // GET /api/gate/events sorts newest-first today, but a caller that merged two
    // queries would break that. This answers "has the box left", so trusting the
    // order would make the oldest gate-out win silently.
    const events = [
      ev('GATE_OUT', '2026-08-11T10:00:00Z', { gate_id: 'OLD' }),
      ev('GATE_OUT', '2026-08-12T09:00:00Z', { gate_id: 'NEW' }),
    ];
    expect(latestCrossing(events, 'GATE_OUT')?.gate_id).toBe('NEW');
    expect(latestCrossing([...events].reverse(), 'GATE_OUT')?.gate_id).toBe('NEW');
  });

  it('does not let an undated row beat a dated one', () => {
    const events = [ev('GATE_OUT', null, { gate_id: 'NODATE' }),
                    ev('GATE_OUT', '2026-08-12T09:00:00Z', { gate_id: 'DATED' })];
    expect(latestCrossing(events, 'GATE_OUT')?.gate_id).toBe('DATED');
  });

  it('still returns an undated row when it is all there is', () => {
    // The crossing happened; only its timestamp is missing.
    expect(latestCrossing([ev('GATE_OUT', null)], 'GATE_OUT')).not.toBeNull();
  });

  it('does not confuse the two directions', () => {
    const events = [ev('GATE_IN', '2026-08-12T08:00:00Z')];
    expect(latestCrossing(events, 'GATE_OUT')).toBeNull();
    expect(latestCrossing(events, 'GATE_IN')).not.toBeNull();
    expect(hasRecordedGateOut(events)).toBe(false);
  });

  it('matches the event type case-insensitively', () => {
    expect(hasRecordedGateOut([ev('gate_out', '2026-08-12T09:00:00Z')])).toBe(true);
  });

  it('reports no gate-out for an empty, null or undefined list', () => {
    // ⚠ "nothing recorded" must never be inferred from the release — that is the
    // derived GATE_OUT this whole read path exists to stop standing in for.
    expect(hasRecordedGateOut([])).toBe(false);
    expect(hasRecordedGateOut(null)).toBe(false);
    expect(hasRecordedGateOut(undefined)).toBe(false);
    expect(latestCrossing(null, 'GATE_OUT')).toBeNull();
  });

  it('a released container with no crossing is NOT confirmed gated out', () => {
    // The exact BEAU5396870 case in reverse: releasing in UC-2 says nothing about
    // whether a truck took it.
    expect(handoverFor(RELEASED)).not.toBeNull();
    expect(hasRecordedGateOut([])).toBe(false);
  });
});
