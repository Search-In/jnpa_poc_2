/**
 * UC2-023 — the New Cargo dialog's ISO-6346 gate.
 *
 * The gate was bypassed to `cn.length > 0` for UC2↔UC3 manual testing, which let
 * a phantom number like ABCD1234567 into a store all three PoCs read from. A
 * phantom container number is not a display bug: it is a row that can never be
 * reconciled with any manifest, gate document or customs record.
 *
 * These tests pin the RULE and the CORRECTIVE MESSAGE. The message matters as
 * much as the rejection — "check digit should be 8" tells an operator what to
 * type next; "invalid container number" sends them to ask someone.
 */
import { describe, expect, it } from 'vitest';
import { computeCheckDigit, isValidContainerNo } from '@jnpa/schemas';

/** Mirrors the dialog: the digit to suggest, or null when the shape is wrong. */
function expectedCheckDigitFor(cn: string): number | null {
  if (isValidContainerNo(cn) || !/^[A-Z]{3}[UJZ][0-9]{7}$/.test(cn)) return null;
  try {
    return computeCheckDigit(cn.slice(0, 10));
  } catch {
    return null;
  }
}

describe('ISO-6346 gate on New Cargo', () => {
  it('accepts real corpus containers', () => {
    // Every one of these is a container we actually hold data for.
    for (const cn of ['ONEU2122848', 'CSNU1399404', 'GESU5123996', 'AAIU5051479']) {
      expect(isValidContainerNo(cn)).toBe(true);
      expect(expectedCheckDigitFor(cn)).toBeNull();
    }
  });

  it('rejects a one-digit typo and names the digit it should have been', () => {
    // The ticket's own example: ONEU2122848 with the last digit changed.
    expect(isValidContainerNo('ONEU2122840')).toBe(false);
    expect(expectedCheckDigitFor('ONEU2122840')).toBe(8);
  });

  it('rejects the phantom number the bypass used to allow', () => {
    // ABCD1234567 — structurally wrong (4th char must be U/J/Z), so there is no
    // meaningful digit to suggest and the message must fall back to the format.
    expect(isValidContainerNo('ABCD1234567')).toBe(false);
    expect(expectedCheckDigitFor('ABCD1234567')).toBeNull();
  });

  it('suggests a digit only when the structure is right', () => {
    // Right shape, wrong checksum -> suggest. Wrong shape -> do not guess.
    expect(expectedCheckDigitFor('MAEU6123450')).toBe(8);
    expect(expectedCheckDigitFor('MAEU612345')).toBeNull();   // too short
    expect(expectedCheckDigitFor('MA1U1234567')).toBeNull();  // non-letter in owner
    expect(expectedCheckDigitFor('MAEX1234567')).toBeNull();  // bad category char
  });

  it('is not satisfied by a merely non-empty string', () => {
    // The exact defect being reverted: the bypass was `cn.length > 0`.
    for (const junk of ['X', 'TEST', '12345678901', 'UC3TEST0001']) {
      expect(isValidContainerNo(junk)).toBe(false);
    }
  });
});
