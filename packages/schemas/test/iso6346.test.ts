import { describe, expect, it } from 'vitest';
import {
  computeCheckDigit,
  isValidContainerNo,
  looksLikeContainerNo,
  parseContainerNo,
  withCheckDigit,
} from '../src/entities/iso6346.js';

describe('ISO 6346 check digit', () => {
  it('computes a known-good check digit', () => {
    // MAEU123456 -> check digit 7 (verified by the standard algorithm)
    expect(computeCheckDigit('MAEU123456')).toBe(7);
  });

  it('accepts valid container numbers', () => {
    for (const n of [
      'MAEU1234567',
      'MSCU7788992',
      'CMAU4567126',
      'TGHU6543213',
      'BMOU1122330',
      'APZU9988776',
    ]) {
      expect(isValidContainerNo(n)).toBe(true);
    }
  });

  it('rejects a wrong check digit', () => {
    expect(isValidContainerNo('MAEU1234560')).toBe(false);
  });

  it('rejects structurally invalid numbers', () => {
    expect(isValidContainerNo('MA1U1234567')).toBe(false); // non-letter in owner
    expect(isValidContainerNo('MAEX1234567')).toBe(false); // bad category char
    expect(isValidContainerNo('MAEU12345')).toBe(false); // too short
  });

  it('round-trips withCheckDigit', () => {
    const full = withCheckDigit('MSCU778899');
    expect(full).toBe('MSCU7788992');
    expect(isValidContainerNo(full)).toBe(true);
  });

  it('parses structural parts', () => {
    expect(parseContainerNo('MAEU1234567')).toEqual({
      ownerCode: 'MAE',
      category: 'U',
      serial: '123456',
      checkDigit: 7,
    });
    expect(parseContainerNo('bad')).toBeNull();
  });
});

/**
 * The routing rule behind the Movements search box. Getting this wrong is what
 * sent the vessel name OOCL GERMANY to `GET /api/cargo?container_number=…` and
 * earned a 400 on the ISO-6346 check digit.
 */
describe('looksLikeContainerNo — container-number vs vessel-name routing', () => {
  it('routes vessel names AWAY from the container path', () => {
    // The exact term from the reported failure, as the box normalised it.
    expect(looksLikeContainerNo('OOCLGERMANY')).toBe(false);
    expect(looksLikeContainerNo('OOCL GERMANY')).toBe(false);
    expect(looksLikeContainerNo('MSC ANNA')).toBe(false);
    expect(looksLikeContainerNo('MAERSK SEMBAWANG')).toBe(false);
    expect(looksLikeContainerNo('')).toBe(false);
  });

  it('routes real container numbers to the container path', () => {
    expect(looksLikeContainerNo('MAEU6123458')).toBe(true);
    expect(looksLikeContainerNo('GESU5123996')).toBe(true);
    // Same normalisation the box has always applied.
    expect(looksLikeContainerNo('maeu 6123458')).toBe(true);
  });

  it('keeps a NEAR-MISS number on the container path, so the ISO-6346 error still surfaces', () => {
    // Deliberately looser than isValidContainerNo: these must reach the backend
    // and be rejected as bad container numbers, not silently become vessel
    // searches that report "no match".
    expect(isValidContainerNo('ABCD1234567')).toBe(false);
    expect(looksLikeContainerNo('ABCD1234567')).toBe(true);
    expect(looksLikeContainerNo('MAEU612345')).toBe(true); // one digit short
  });
});
