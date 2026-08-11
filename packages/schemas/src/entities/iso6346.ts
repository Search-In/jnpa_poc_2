/**
 * ISO 6346 container-number utilities (prompt §3 "ISO container numbers per
 * ISO 6346"). Implements the real check-digit algorithm so simulator-generated
 * and mapper-parsed numbers are verifiably valid, not just regex-shaped.
 *
 * Format: OOOO U NNNNNN C
 *   - OOO  = owner code (3 letters)
 *   - O    = equipment category identifier (U, J, or Z)
 *   - NNNNNN = 6-digit serial
 *   - C    = check digit (0-9; a computed value of 10 maps to 0 by convention)
 */

const CONTAINER_NO_RE = /^[A-Z]{3}[UJZ]\d{6}\d$/;

/**
 * ISO 6346 letter weighting table. Letters map to numeric values starting at 10,
 * skipping every multiple of 11 (11, 22, 33, ...) — a documented quirk of the
 * standard. A=10, B=12, C=13, ... (no value is a multiple of 11).
 */
const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let value = 10;
  for (let i = 0; i < 26; i++) {
    if (value % 11 === 0) value++; // skip multiples of 11
    map[String.fromCharCode(65 + i)] = value;
    value++;
  }
  return map;
})();

/**
 * Compute the ISO 6346 check digit for the first 10 characters
 * (4 letters + 6 digits). Returns 0-9.
 */
export function computeCheckDigit(prefix10: string): number {
  if (prefix10.length !== 10) {
    throw new Error(`ISO6346: expected 10 chars before check digit, got ${prefix10.length}`);
  }
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = prefix10[i]!;
    const base = /[A-Z]/.test(ch) ? LETTER_VALUES[ch]! : Number(ch);
    sum += base * 2 ** i;
  }
  const remainder = sum % 11;
  return remainder === 10 ? 0 : remainder;
}

/**
 * Does this SHAPE like a container number? Deliberately looser than
 * {@link isValidContainerNo}: 4 letters then 5-7 digits, ignoring case and
 * spaces. No check digit, no U/J/Z category check.
 *
 * It exists to route a single search box between "container number" and
 * "vessel name", so being loose is the point:
 *   • a mistyped or near-miss number (MAEU612345, ABCD1234567) still takes the
 *     CONTAINER path, where the backend's ISO-6346 check digit rejects it with
 *     its own message — the validation is untouched, and the operator is told
 *     the number is wrong rather than being shown "no vessel found";
 *   • free text (OOCL GERMANY, MSC ANNA) takes the VESSEL path and is never
 *     put through container validation at all.
 */
export function looksLikeContainerNo(value: string): boolean {
  return /^[A-Z]{4}\d{5,7}$/.test(value.trim().toUpperCase().replace(/\s+/g, ''));
}

/** True if `value` is a structurally- and check-digit-valid ISO 6346 number. */
export function isValidContainerNo(value: string): boolean {
  if (!CONTAINER_NO_RE.test(value)) return false;
  const expected = computeCheckDigit(value.slice(0, 10));
  return Number(value[10]) === expected;
}

/**
 * Given a 10-char prefix (owner+category+serial), return the full 11-char
 * container number with a valid appended check digit. Used by the simulator.
 */
export function withCheckDigit(prefix10: string): string {
  return prefix10 + String(computeCheckDigit(prefix10));
}

/** Parse the structural parts of a container number (does not validate check digit). */
export function parseContainerNo(value: string): {
  ownerCode: string;
  category: string;
  serial: string;
  checkDigit: number;
} | null {
  if (!CONTAINER_NO_RE.test(value)) return null;
  return {
    ownerCode: value.slice(0, 3),
    category: value[3]!,
    serial: value.slice(4, 10),
    checkDigit: Number(value[10]),
  };
}
