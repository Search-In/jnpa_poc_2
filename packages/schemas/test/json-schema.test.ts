import { describe, expect, it } from 'vitest';
import { assertValid, validate } from '../src/json-schema/index.js';
import type { Container } from '../src/entities/container.js';

describe('JSON-Schema registry', () => {
  it('accepts a well-formed Container', () => {
    const c: Container = {
      containerNo: 'MAEU1234567',
      isoTypeCode: '22G1',
      sizeFt: 20,
      laden: true,
      grossWtKg: 24500,
      cargoType: 'GENERAL',
      lineOwner: 'MAEU',
      currentSealNo: 'SEAL778899',
      status: 'GATE_IN',
      originStream: 'IMPORT_CFS',
      lastUpdatedTs: '2026-06-17T02:45:00.000Z',
    };
    expect(validate('jnpa:uc2:Container', c).valid).toBe(true);
  });

  it('rejects a Container with a bad container number', () => {
    const { valid, errors } = validate('jnpa:uc2:Container', {
      containerNo: 'BAD',
      isoTypeCode: '22G1',
      sizeFt: 20,
      laden: true,
      grossWtKg: 1,
      cargoType: 'X',
      lineOwner: 'X',
      currentSealNo: '',
      status: 'GATE_IN',
      originStream: 'IMPORT_CFS',
      lastUpdatedTs: '2026-06-17T02:45:00.000Z',
    });
    expect(valid).toBe(false);
    expect(errors.join(' ')).toMatch(/containerNo/);
  });

  it('rejects an unknown enum value', () => {
    const { valid } = validate('jnpa:uc2:Container', {
      containerNo: 'MAEU1234567',
      isoTypeCode: '22G1',
      sizeFt: 20,
      laden: true,
      grossWtKg: 1,
      cargoType: 'X',
      lineOwner: 'X',
      currentSealNo: '',
      status: 'NOT_A_STATUS',
      originStream: 'IMPORT_CFS',
      lastUpdatedTs: '2026-06-17T02:45:00.000Z',
    });
    expect(valid).toBe(false);
  });

  it('assertValid throws on invalid data', () => {
    expect(() => assertValid('jnpa:uc2:CargoEvent', {})).toThrow(/Validation failed/);
  });

  it('throws for an unregistered schema id', () => {
    expect(() => validate('jnpa:uc2:DoesNotExist', {})).toThrow(/No JSON-Schema/);
  });
});
