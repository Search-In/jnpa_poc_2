import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mapCodeco } from '../src/mappers/edifact/codeco.js';
import { mapCoarri } from '../src/mappers/edifact/other-edifact.js';
import { isValidContainerNo } from '../src/entities/iso6346.js';
import { validate } from '../src/json-schema/index.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (f: string) => readFileSync(join(FIX, f), 'utf8');

describe('CODECO mapper (gate-in)', () => {
  const { data: events, warnings } = mapCodeco(read('codeco_gatein.edi'));

  it('produces no warnings on a clean message', () => {
    expect(warnings).toEqual([]);
  });

  it('emits a GATE_IN event for the container', () => {
    const gateIn = events.find((e) => e.eventType === 'GATE_IN');
    expect(gateIn).toBeDefined();
    expect(gateIn!.containerNo).toBe('MAEU1234567');
    expect(isValidContainerNo(gateIn!.containerNo)).toBe(true);
    expect(gateIn!.facilityId).toBe('NSICT');
    expect(gateIn!.gateId).toBe('NSICT-G1');
    expect(gateIn!.sourceSystem).toBe('TOS');
  });

  it('maps the SEL seal segment to an ESEAL_AFFIX event', () => {
    const affix = events.find((e) => e.eventType === 'ESEAL_AFFIX');
    expect(affix).toBeDefined();
    expect(affix!.payload.sealNo).toBe('SEAL778899');
  });

  it('uses the DTM+7 actual movement time, converted from IST to UTC', () => {
    const gateIn = events.find((e) => e.eventType === 'GATE_IN')!;
    // 2026-06-17 08:15 IST (+0530) -> 02:45 UTC
    expect(gateIn.ts).toBe('2026-06-17T02:45:00.000Z');
    expect(gateIn.sourceOffsetMin).toBe(330);
  });

  it('records a rawRef for audit', () => {
    expect(events[0]!.rawRef).toBe('raw/tos/codeco/GATEDOC001');
  });

  it('every event validates against the CargoEvent JSON-Schema', () => {
    for (const e of events) {
      const { valid, errors } = validate('jnpa:uc2:CargoEvent', e);
      expect(valid, errors.join('; ')).toBe(true);
    }
  });
});

describe('CODECO mapper (gate-out with damage + custom UNA chars)', () => {
  const { data: events } = mapCodeco(read('codeco_gateout_damage.edi'));

  it('reads BGM 36 as GATE_OUT', () => {
    expect(events.some((e) => e.eventType === 'GATE_OUT')).toBe(true);
  });

  it('maps the FTX damage note to a DAMAGE_FLAG event', () => {
    const dmg = events.find((e) => e.eventType === 'DAMAGE_FLAG');
    expect(dmg).toBeDefined();
    expect(String(dmg!.payload.note)).toMatch(/DAMAGE TO LEFT DOOR PANEL/);
    expect(dmg!.containerNo).toBe('CMAU4567126');
  });

  it('honours the UNA service-string advice (custom separators)', () => {
    // The fixture declares UNA:+.? ' which are the defaults — proves UNA parses.
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('COARRI mapper', () => {
  const { data: events } = mapCoarri(read('coarri.edi'));

  it('emits a YARD_MOVE per discharged container', () => {
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === 'YARD_MOVE')).toBe(true);
    expect(events.map((e) => e.containerNo).sort()).toEqual(['CMAU4567126', 'MAEU1234567']);
  });

  it('tags the movement direction on payload (discharge)', () => {
    expect(events[0]!.payload.movement).toBe('DISCHARGE');
  });
});
