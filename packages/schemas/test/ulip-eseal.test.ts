import { describe, expect, it } from 'vitest';

import {
  mapUlipContainerTrack,
  mapUlipFoisRake,
  mapUlipVahan,
} from '../src/mappers/ulip/ulip-json.js';
import { mapESealRead } from '../src/mappers/eseal/rfid.js';
import { validate } from '../src/json-schema/index.js';

describe('ULIP container track/trace mapper', () => {
  const { data: events, warnings } = mapUlipContainerTrack([
    {
      containerNo: 'APZU9988776',
      milestone: 'GATE_IN',
      eventDateTime: '2026-06-17 08:00:00',
      facilityCode: 'BMCT',
      gateId: 'BMCT-G1',
      vehicleNo: 'MH04AB1234',
    },
    {
      containerNo: 'APZU9988776',
      milestone: 'RAIL_OUT',
      eventDateTime: '2026-06-17 14:30:00',
      facilityCode: 'BMCT',
    },
  ]);

  it('maps milestones to canonical event types', () => {
    expect(warnings).toEqual([]);
    expect(events.map((e) => e.eventType)).toEqual(['GATE_IN', 'RAIL_OUT']);
  });

  it('preserves vehicle and converts IST to UTC', () => {
    expect(events[0]!.vehicleNo).toBe('MH04AB1234');
    expect(events[0]!.ts).toBe('2026-06-17T02:30:00.000Z'); // 08:00 IST
    expect(events[0]!.sourceSystem).toBe('ULIP');
  });

  it('validates against CargoEvent schema', () => {
    for (const e of events) {
      const { valid, errors } = validate('jnpa:uc2:CargoEvent', e);
      expect(valid, errors.join('; ')).toBe(true);
    }
  });
});

describe('ULIP/FOIS rake mapper', () => {
  const { data: rake } = mapUlipFoisRake({
    rakeId: 'RK-CONCOR-001',
    trainNo: '12345',
    foisRef: 'FOIS-998',
    ctoOperator: 'CONCOR',
    sidingId: 'T1',
    terminalId: 'NSICT',
    arrivalDateTime: '2026-06-17 06:00:00',
    placementDateTime: '2026-06-17 07:00:00',
    wagonCount: 45,
    direction: 'INBOUND',
    mixedFlag: true,
  });

  it('builds a canonical Rake validating against the Rake schema', () => {
    expect(rake.sidingId).toBe('T1');
    expect(rake.mixedFlag).toBe(true);
    const { valid, errors } = validate('jnpa:uc2:Rake', rake);
    expect(valid, errors.join('; ')).toBe(true);
  });
});

describe('ULIP Vahan vehicle lookup mapper', () => {
  it('flags a compliant vehicle', () => {
    const { data } = mapUlipVahan(
      {
        vehicleNo: 'MH04AB1234',
        rcStatus: 'ACTIVE',
        fitnessValidUpto: '2027-01-01',
        permitValidUpto: '2027-01-01',
      },
      '2026-06-17T00:00:00.000Z',
    );
    expect(data.compliant).toBe(true);
  });

  it('flags a non-compliant (expired fitness) vehicle', () => {
    const { data } = mapUlipVahan(
      { vehicleNo: 'MH04XX9999', rcStatus: 'ACTIVE', fitnessValidUpto: '2025-01-01' },
      '2026-06-17T00:00:00.000Z',
    );
    expect(data.compliant).toBe(false);
  });
});

describe('e-seal RFID mapper', () => {
  it('maps an AFFIX read to ESEAL_AFFIX', () => {
    const { data } = mapESealRead({
      containerNo: 'MAEU1234567',
      sealNo: 'ESEAL900999',
      eventCode: 'AFFIX',
      readerId: 'RDR-01',
      facilityId: 'NSICT',
      gateId: 'NSICT-G1',
      readTs: '2026-06-17T02:30:00.000Z',
    });
    expect(data.eventType).toBe('ESEAL_AFFIX');
    expect(data.payload.sealNo).toBe('ESEAL900999');
    const { valid, errors } = validate('jnpa:uc2:CargoEvent', data);
    expect(valid, errors.join('; ')).toBe(true);
  });

  it('maps a BREAK read to ESEAL_BREAK (tamper signal)', () => {
    const { data } = mapESealRead({
      containerNo: 'MAEU1234567',
      sealNo: 'ESEAL900999',
      eventCode: 'BREAK',
      readTs: '2026-06-17T03:00:00.000Z',
    });
    expect(data.eventType).toBe('ESEAL_BREAK');
  });
});
