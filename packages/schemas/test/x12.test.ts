import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { map322 } from '../src/mappers/x12/transactions.js';
import { validate } from '../src/json-schema/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');

describe('X12 322 mapper (Terminal Operations / Intermodal Ramp Activity)', () => {
  const { data: events, warnings } = map322(read('x12_322.edi'));

  it('reads the ISA-declared delimiters and parses cleanly', () => {
    expect(warnings).toEqual([]);
    expect(events.length).toBe(1);
  });

  it('maps Y4 status "I" to GATE_IN for the container', () => {
    const e = events[0]!;
    expect(e.eventType).toBe('GATE_IN');
    expect(e.containerNo).toBe('MSCU7788992');
    expect(e.facilityId).toBe('BMCT');
    expect(e.sourceSystem).toBe('TOS');
  });

  it('converts the Y4 date/time from IST to UTC', () => {
    // 2026-06-17 08:15 IST -> 02:45 UTC
    expect(events[0]!.ts).toBe('2026-06-17T02:45:00.000Z');
  });

  it('validates against the CargoEvent JSON-Schema', () => {
    const { valid, errors } = validate('jnpa:uc2:CargoEvent', events[0]);
    expect(valid, errors.join('; ')).toBe(true);
  });
});
