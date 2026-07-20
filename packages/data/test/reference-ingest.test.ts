/**
 * Reference-data ingestion transforms — verifies the pure transforms map the
 * JNPA reference package's machine-readable subset (IAL/EAL CSV + EIR JSON) into
 * the canonical cargo model. These live in @jnpa/data (a data-source concern);
 * the SimWorld override seam that CONSUMES their output is tested in @jnpa/sim.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@jnpa/schemas';
import {
  parseShiplineCsv,
  parseEirJson,
  buildReferenceDataset,
} from '../src/reference/index.js';

const AS_OF = '2026-06-15T00:00:00.000Z';

const IAL_CSV = `Container,ISO,GrossWeightInMT,Status,Line,Category,POD,Seal,Temp
BEAU2313280,2210,19880,F,KMD,I,INNSA,KSC825986,
`;

const EAL_CSV = `ContainerNbr,ISO,GrossWeightin KGS,Status,Line,Category,POL,POD,REEFER STS,TEMP,TEMP  UNIT
SEGU9719798,4532,34010,F,KMD,E,INNSA,MYPKG,Y,-18,C
`;

const EIR_JSON = {
  DocumentType: 'EIR Import',
  ContainerNo: 'MSMU1908508',
  ISOCode: '2210',
  ContainerSize: '20',
  GrossWeight: '24.6 t',
  ContainerStatus: 'Full',
  DateTime: '12/06/2026 06:26',
  LICNo: 'MH43BX1488',
  SealNo1: 'EU31716082',
  SealNo2: 'NOSEAL',
  Terminal: 'PSA Mumbai BMCT',
  EIRNo: '4339869',
};

describe('reference ingestion — shipping-line CSV', () => {
  it('maps an IAL import row to a canonical import container', () => {
    const [rec] = parseShiplineCsv(IAL_CSV, 'IAL', AS_OF);
    expect(rec).toBeDefined();
    const c = rec!.container;
    expect(c.containerNo).toBe('BEAU2313280');
    expect(c.sizeFt).toBe(20);
    expect(c.laden).toBe(true);
    expect(c.grossWtKg).toBe(19880);
    expect(c.originStream).toBe('IMPORT_CFS');
    expect(c.currentSealNo).toBe('KSC825986');
    expect(c.lineOwner).toBe('BEAU');
    expect(validate('jnpa:uc2:Container', c).valid).toBe(true);
  });

  it('maps an EAL export row and reads the reefer set-point', () => {
    const [rec] = parseShiplineCsv(EAL_CSV, 'EAL', AS_OF);
    const c = rec!.container;
    expect(c.sizeFt).toBe(40);
    expect(c.originStream).toBe('EXPORT_CFS');
    expect(c.reefer).toEqual({ setpointC: -18, currentC: -18 });
    expect(validate('jnpa:uc2:Container', c).valid).toBe(true);
  });
});

describe('reference ingestion — EIR JSON', () => {
  it('maps an import EIR to a real gate-out event with a truck + seal', () => {
    const rec = parseEirJson(EIR_JSON, AS_OF);
    expect(rec).not.toBeNull();
    expect(rec!.event.eventType).toBe('GATE_OUT');
    // 12 Jun 2026 06:26 IST (+05:30) → 00:56 UTC.
    expect(rec!.event.ts).toBe('2026-06-12T00:56:00.000Z');
    expect(rec!.event.vehicleNo).toBe('MH43BX1488');
    expect(rec!.event.terminalId).toBe('BMCT');
    expect(rec!.container.grossWtKg).toBe(24600);
    expect(rec!.container.currentSealNo).toBe('EU31716082');
    expect(validate('jnpa:uc2:CargoEvent', rec!.event).valid).toBe(true);
    expect(validate('jnpa:uc2:Container', rec!.container).valid).toBe(true);
  });

  it('returns null for an object with no container number', () => {
    expect(parseEirJson({ DocumentType: 'EIR Import' }, AS_OF)).toBeNull();
  });
});

describe('reference ingestion — dataset merge', () => {
  const override = buildReferenceDataset({
    shipline: [
      ...parseShiplineCsv(IAL_CSV, 'IAL', AS_OF),
      ...parseShiplineCsv(EAL_CSV, 'EAL', AS_OF),
    ],
    eir: [parseEirJson(EIR_JSON, AS_OF)!],
    asOfIso: AS_OF,
  });

  it('dedupes containers and gives every container at least one event', () => {
    expect(override.containers).toHaveLength(3);
    for (const c of override.containers) {
      expect(override.events.some((e) => e.containerNo === c.containerNo)).toBe(true);
    }
  });

  it('every produced event is schema-valid', () => {
    for (const e of override.events) expect(validate('jnpa:uc2:CargoEvent', e).valid).toBe(true);
  });
});
