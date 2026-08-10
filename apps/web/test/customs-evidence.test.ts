/**
 * UC2-004 acceptance, as executable rules: every customs badge on the Scan tab
 * either traces to a filed customs record or is marked SIMULATED.
 *
 * The point of these tests is the STRICTNESS. It would be easy to make more
 * badges look substantiated by accepting a weaker document as proof — an IGM
 * line says the box exists, not that customs cleared it — and that is precisely
 * the failure the ticket is about. So the negative cases are pinned as hard as
 * the positive ones.
 */
import { describe, expect, it } from 'vitest';
import type { ContainerCustomsView } from '@jnpa/data';
import { customsEvidenceFor } from '../src/panels/customsEvidence.js';

/** A container that is manifested but has no clearance, no scan selection. */
const MANIFESTED_ONLY: ContainerCustomsView = {
  container_no: 'APLU0896946',
  igm: [{ igm_no: 1193612, line_no: 130, container_no: 'APLU0896946' }] as ContainerCustomsView['igm'],
  ooc: [],
  smtp: [],
  rms: [],
};

/** CSNU1399404 as the corpus actually holds it — the ticket's worked example. */
const CLEARED_FOR_REAL: ContainerCustomsView = {
  container_no: 'CSNU1399404',
  igm: [{ igm_no: 1193612, line_no: 130, container_no: 'CSNU1399404' }] as ContainerCustomsView['igm'],
  ooc: [{
    bill_of_entry_no: 9259230,
    out_of_charge_no: '2071217438',
    out_of_charge_date: '2026-06-06',
  }],
  smtp: [],
  rms: [],
};

/** AAIU5051479 as the RMS file actually selects it — a real scanning entry. */
const RMS_SELECTED: ContainerCustomsView = {
  container_no: 'AAIU5051479',
  igm: [],
  ooc: [],
  smtp: [],
  rms: [{ igm_no: 1191409, scan_machine: 'D', scan_location: 'INNSA1RSDT02' }],
};

describe('customs badge provenance (UC2-004)', () => {
  it('traces CLEAR to the bill of entry and out-of-charge that granted it', () => {
    const ev = customsEvidenceFor('CLEAR', CLEARED_FOR_REAL);

    expect(ev.traced).toBe(true);
    expect(ev.reference).toContain('BE 9259230');
    expect(ev.reference).toContain('OOC 2071217438');
    expect(ev.reference).toContain('2026-06-06');
  });

  it('does NOT accept a manifest line as clearance', () => {
    // The container is genuinely in the customs corpus — it just was never
    // cleared. Being manifested is not being released by customs.
    const ev = customsEvidenceFor('CLEAR', MANIFESTED_ONLY);

    expect(ev.traced).toBe(false);
    expect(ev.reason).toMatch(/out-of-charge/i);
  });

  it('marks a status simulated when the container is in no customs document', () => {
    const ev = customsEvidenceFor('CLEAR', null);

    expect(ev.traced).toBe(false);
    expect(ev.reason).toMatch(/no customs document/i);
  });

  it('traces EXAM to the RMS scanning selection', () => {
    const ev = customsEvidenceFor('EXAM', RMS_SELECTED);

    expect(ev.traced).toBe(true);
    expect(ev.reference).toContain('IGM 1191409');
    expect(ev.reference).toContain('INNSA1RSDT02');
  });

  it('does not accept an out-of-charge as grounds for EXAM', () => {
    // Cleared and under examination are different claims; one cannot back the other.
    expect(customsEvidenceFor('EXAM', CLEARED_FOR_REAL).traced).toBe(false);
  });

  it('always marks HOLD simulated — the corpus records no customs holds', () => {
    for (const view of [CLEARED_FOR_REAL, RMS_SELECTED, MANIFESTED_ONLY, null]) {
      const ev = customsEvidenceFor('HOLD', view);
      expect(ev.traced).toBe(false);
      expect(ev.reason).toBeTruthy();
    }
  });

  it('leaves PENDING alone — a badge that claims nothing needs no evidence', () => {
    // It must NOT be marked simulated either: that would read as a defect where
    // there is simply no assertion.
    const ev = customsEvidenceFor(undefined, null);

    expect(ev.traced).toBe(true);
    expect(ev.reference).toBeUndefined();
  });
});
