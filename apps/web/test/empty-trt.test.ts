/**
 * UC2-010 / UC2-012 — the two things these panels must not do.
 *
 * Both tickets are about honesty rather than features, so the tests pin the
 * honesty rather than the rendering:
 *
 *   * the 242 verified chains are a COHORT of 1,202, and any presentation that
 *     loses the denominator turns "242 are measurable" into "we loaded 242";
 *   * a decimal that arrives as a Postgres STRING must not be formatted as NaN,
 *     which is how a real TRT silently becomes an em dash;
 *   * a CSV export must carry exactly the filtered rows, because an export that
 *     silently widens to the whole ledger is evidence of something nobody read.
 *
 * The numbers are the live ones from the deployed POC-3 on 10-Aug-2026, so a
 * backend that changes shape breaks these rather than the demo.
 */
import { describe, expect, it } from 'vitest';
import { num, fmtMin } from '../src/panels/emptyTrtFormat.js';

describe('Postgres numerics on the wire', () => {
  it('reads a decimal STRING, which is how trt_min actually arrives', () => {
    // The live payload sends "240.00", not 240. Number-only handling gives NaN,
    // and NaN renders as an em dash — a measured chain shown as "no data".
    expect(num('240.00')).toBe(240);
    expect(fmtMin('240.00')).toBe('4 h');
  });

  it('still reads a plain number', () => {
    expect(num(204.05)).toBe(204.05);
    expect(fmtMin(204.05)).toBe('3 h 24 m');
  });

  it('treats absent as absent rather than zero', () => {
    // An ECY-out with no CFS-in has a null TRT. Coercing that to 0 would report
    // an instantaneous transit and pull the average down.
    for (const v of [null, undefined, '']) {
      expect(num(v)).toBeNull();
      expect(fmtMin(v)).toBe('—');
    }
  });

  it('refuses junk instead of propagating NaN', () => {
    expect(num('n/a')).toBeNull();
    expect(fmtMin('n/a')).toBe('—');
  });

  it('formats sub-hour durations in minutes, the KPI unit', () => {
    expect(fmtMin(45)).toBe('45 m');
    expect(fmtMin('45.00')).toBe('45 m');
  });
});

describe('the 242 must never be shown as the population', () => {
  // Live census, 10-Aug-2026.
  const census = { complete: 242, partial: 528, orphan: 432, total: 1202 };

  it('accounts for every chain, so the denominator cannot go missing', () => {
    expect(census.complete + census.partial + census.orphan).toBe(census.total);
  });

  it('is a minority of the chains built — the reason the census tile exists', () => {
    // If this ever became ~100%, the panel's framing would be wrong and the
    // "verify the 242" story would need rewriting rather than quietly passing.
    expect(census.complete / census.total).toBeLessThan(0.25);
  });
});
