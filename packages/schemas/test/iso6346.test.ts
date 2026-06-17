import { describe, expect, it } from 'vitest';
import {
  computeCheckDigit,
  isValidContainerNo,
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
