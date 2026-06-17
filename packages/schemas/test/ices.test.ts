import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mapIcesChsai } from '../src/mappers/ices/chsai.js';
import { validate } from '../src/json-schema/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');

describe('ICES 1.5 CHSAI mapper — LEO', () => {
  const { data: events, warnings } = mapIcesChsai(read('ices_leo.xml'));

  it('maps a LEO message to a LEO event', () => {
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('LEO');
    expect(events[0]!.containerNo).toBe('TGHU6543213');
    expect(events[0]!.facilityId).toBe('NSIGT');
    expect(events[0]!.sourceSystem).toBe('ICEGATE');
  });

  it('converts ICES IST datetime to UTC', () => {
    // 17-06-2026 09:45 IST -> 04:15 UTC
    expect(events[0]!.ts).toBe('2026-06-17T04:15:00.000Z');
  });
});

describe('ICES 1.5 CHSAI mapper — BE third-stage flags (DPD-ready, scan-selected)', () => {
  const { data: events } = mapIcesChsai(read('ices_be_flags.xml'));

  it('emits a CUSTOMS_FLAG per container with DPD/scan flags', () => {
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === 'CUSTOMS_FLAG')).toBe(true);
  });

  it('carries dpdReady=true for the DPD container', () => {
    const dpd = events.find((e) => e.containerNo === 'MAEU1234567')!;
    expect(dpd.payload.dpdReady).toBe(true);
    expect(dpd.payload.selectedForScan).toBe(false);
  });

  it('carries selectedForScan=true for the flagged container', () => {
    const scan = events.find((e) => e.containerNo === 'BMOU1122330')!;
    expect(scan.payload.selectedForScan).toBe(true);
    expect(scan.payload.dpdReady).toBe(false);
  });

  it('validates against the CargoEvent JSON-Schema', () => {
    for (const e of events) {
      const { valid, errors } = validate('jnpa:uc2:CargoEvent', e);
      expect(valid, errors.join('; ')).toBe(true);
    }
  });
});
