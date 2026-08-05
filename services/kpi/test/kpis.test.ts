import { describe, expect, it } from 'vitest';
import type {
  CargoEvent,
  Container,
  GateTransaction,
  ITRHOMovement,
  Rake,
  ScanEvent,
} from '@jnpa/schemas';
import {
  bufferPendency,
  containerDwell,
  improvement,
  interTerminalTransferTat,
  percentile,
  rakeTurnaroundTime,
  scannerTurnaroundTime,
  trailerTurnaroundTime,
} from '../src/index.js';
import type { BaselinesConfig, KpiInputs } from '../src/index.js';

const baselines: BaselinesConfig = {
  asOf: '2026-06-17T00:00:00.000Z',
  baselines: {
    rakeTurnaroundTime: { value: 10, unit: 'hr' },
    interTerminalTransferTat: { value: 8, unit: 'hr' },
    trailerTurnaroundTime: { value: 6, unit: 'hr' },
    scannerTurnaroundTime: { value: 4, unit: 'hr' },
    transshipmentTrailerTat: { value: 6, unit: 'hr' },
    bufferPendency: { value: 100, unit: 'Nos' },
    mixedTrainOptimization: { value: 70, unit: 'containers/rake' },
    gateTransactionTime: { value: 12, unit: 'min' },
  },
};

const emptyInputs = (over: Partial<KpiInputs>): KpiInputs => ({
  asOf: '2026-06-17T12:00:00.000Z',
  containers: [],
  events: [],
  gateTransactions: [],
  rakes: [],
  itrho: [],
  scans: [],
  baselines,
  ...over,
});

describe('improvement() direction normalisation', () => {
  it('lower-is-better: value below baseline → positive improvement', () => {
    expect(improvement(8, 10, false)).toBe(20); // 20% faster
  });
  it('higher-is-better: value above baseline → positive improvement', () => {
    expect(improvement(84, 70, true)).toBe(20); // 20% more utilisation
  });
  it('worse-than-baseline → negative improvement', () => {
    expect(improvement(12, 10, false)).toBe(-20);
  });
});

describe('Rake Turnaround Time (departureTs − arrivalTs)', () => {
  it('computes the mean siding cycle in hours', () => {
    const rakes: Rake[] = [
      {
        rakeId: 'R1', ctoOperator: 'CONCOR', trainNo: '1', foisRef: 'F1', sidingId: 'T1', terminalId: 'NSICT',
        arrivalTs: '2026-06-16T00:00:00.000Z', departureTs: '2026-06-16T08:00:00.000Z',
        wagonCount: 40, direction: 'INBOUND', mixedFlag: false,
      },
      {
        rakeId: 'R2', ctoOperator: 'CONCOR', trainNo: '2', foisRef: 'F2', sidingId: 'T2', terminalId: 'GTI',
        arrivalTs: '2026-06-16T00:00:00.000Z', departureTs: '2026-06-16T12:00:00.000Z',
        wagonCount: 42, direction: 'OUTBOUND', mixedFlag: true,
      },
    ];
    const r = rakeTurnaroundTime(emptyInputs({ rakes }));
    expect(r.value).toBe(10); // mean(8, 12)
    expect(r.improvementPct).toBe(0); // baseline 10 → 0%
    expect(r.byFacility).toEqual([
      { facilityId: 'T1', value: 8 },
      { facilityId: 'T2', value: 12 },
    ]);
  });
});

describe('Inter-Terminal Transfer TAT (inTs − outTs)', () => {
  it('means the ITRHO durations', () => {
    const itrho: ITRHOMovement[] = [
      {
        itrhoId: 'I1', containerNo: 'MAEU1234567', fromTerminalId: 'NSICT', toTerminalId: 'GTI',
        requestedTs: '2026-06-16T00:00:00.000Z', outTs: '2026-06-16T01:00:00.000Z',
        inTs: '2026-06-16T05:00:00.000Z', mode: 'ROAD',
      },
    ];
    const r = interTerminalTransferTat(emptyInputs({ itrho }));
    expect(r.value).toBe(4); // 05:00 − 01:00
    expect(r.improvementPct).toBe(50); // baseline 8 → 50% faster
  });
});

describe('Trailer Turn Around Time (gateOut − gateIn)', () => {
  it('pairs IN→OUT by container', () => {
    const gateTransactions: GateTransaction[] = [
      {
        gateTxnId: 'G1', gateId: 'NSICT-G1', direction: 'IN', vehicleNo: 'MH01AB1234', containerNo: 'MAEU1234567',
        arrivalTs: '2026-06-16T00:00:00.000Z', startTs: '2026-06-16T00:10:00.000Z',
        endTs: '2026-06-16T00:20:00.000Z', docsVerified: ['FORM13'], outcome: 'CLEARED',
      },
      {
        gateTxnId: 'G2', gateId: 'NSICT-G1', direction: 'OUT', vehicleNo: 'MH01AB1234', containerNo: 'MAEU1234567',
        arrivalTs: '2026-06-16T03:00:00.000Z', startTs: '2026-06-16T03:10:00.000Z',
        endTs: '2026-06-16T03:20:00.000Z', docsVerified: ['ESEAL'], outcome: 'CLEARED',
      },
    ];
    const r = trailerTurnaroundTime(emptyInputs({ gateTransactions }));
    expect(r.value).toBe(3); // 03:10 − 00:10
  });
});

describe('Scanner Turn Around Time (endTs − startTs)', () => {
  it('means scan durations', () => {
    const scans: ScanEvent[] = [
      {
        scanId: 'S1', containerNo: 'MAEU1234567', scannerId: 'SCN1', flaggedBy: 'CUSTOMS',
        startTs: '2026-06-16T00:00:00.000Z', endTs: '2026-06-16T02:00:00.000Z', result: 'CLEAR',
      },
    ];
    const r = scannerTurnaroundTime(emptyInputs({ scans }));
    expect(r.value).toBe(2);
    expect(r.improvementPct).toBe(50); // baseline 4 → 50%
  });
});

describe('Buffer Pendency (count beyond dwell threshold, per facility)', () => {
  it('counts containers whose last event is non-terminal and older than threshold', () => {
    const events: CargoEvent[] = [
      // pending: yard move 60h before asOf, no gate-out
      mkEvent('MAEU1234567', 'YARD_MOVE', '2026-06-15T00:00:00.000Z', 'CFS-PUNE'),
      // not pending: gate-out terminal event
      mkEvent('MSCU7788992', 'GATE_OUT', '2026-06-16T00:00:00.000Z', 'NSICT'),
      // not pending: only 6h old (under 48h threshold)
      mkEvent('CMAU4567126', 'YARD_MOVE', '2026-06-17T06:00:00.000Z', 'CFS-PUNE'),
    ];
    const r = bufferPendency(emptyInputs({ events, asOf: '2026-06-17T12:00:00.000Z' }));
    expect(r.value).toBe(1);
    expect(r.byFacility).toEqual([{ facilityId: 'CFS-PUNE', value: 1 }]);
  });
});

function mkEvent(containerNo: string, eventType: CargoEvent['eventType'], ts: string, facilityId: string): CargoEvent {
  return {
    eventId: `${containerNo}-${eventType}`, containerNo, eventType, ts, sourceOffsetMin: 330,
    facilityId, sourceSystem: 'TOS', rawRef: 'raw/x', payload: {},
  };
}

describe('percentile() — linear interpolation (R-7)', () => {
  it('returns the median at p=0.5', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });
  it('interpolates between neighbours rather than jumping to nearest rank', () => {
    // 10 values 1..10 → P90 index = 9*0.9 = 8.1 → 9 + 0.1*(10-9) = 9.1
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBeCloseTo(9.1, 5);
  });
  it('is safe on empty and single-element samples', () => {
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([7], 0.9)).toBe(7);
  });
});

describe('Container Dwell — median + P90 per branch (WS4 KPI #9)', () => {
  /** One container: arrives, then leaves `hours` later via GATE_OUT. */
  const journey = (containerNo: string, hours: number): CargoEvent[] => [
    { eventId: `${containerNo}-in`, containerNo, eventType: 'GATE_IN', ts: '2026-06-10T00:00:00.000Z',
      sourceOffsetMin: 330, facilityId: 'F1', sourceSystem: 'TOS' } as CargoEvent,
    { eventId: `${containerNo}-out`, containerNo, eventType: 'GATE_OUT',
      ts: new Date(Date.parse('2026-06-10T00:00:00.000Z') + hours * 3_600_000).toISOString(),
      sourceOffsetMin: 330, facilityId: 'F1', sourceSystem: 'TOS' } as CargoEvent,
  ];
  const box = (containerNo: string, originStream: string): Container =>
    ({ containerNo, originStream } as unknown as Container);

  it('reports median and P90 separately, and never a mean', () => {
    // 1,2,3,4,100 → mean 22, median 3. A mean would hide the 100-hour box.
    const hours = [1, 2, 3, 4, 100];
    const events = hours.flatMap((h, i) => journey(`MSKU000000${i}`, h));
    const containers = hours.map((_, i) => box(`MSKU000000${i}`, 'IMPORT_CFS'));
    const r = containerDwell(emptyInputs({ events, containers }));
    expect(r.distribution?.median).toBe(3);
    expect(r.distribution?.p90).toBeGreaterThan(3);   // the tail is visible
    expect(r.value).toBe(3);                          // headline is the median
    expect(r.value).not.toBe(22);                     // explicitly NOT the mean
  });

  it('splits by branch using originStream', () => {
    const events = [...journey('MSKU0000001', 2), ...journey('MSKU0000002', 50)];
    const containers = [box('MSKU0000001', 'IMPORT_CFS'), box('MSKU0000002', 'EXPORT_ICD')];
    const r = containerDwell(emptyInputs({ events, containers }));
    const byBranch = r.distribution?.byBranch ?? [];
    expect(byBranch.map((b) => b.branch).sort()).toEqual(['EXPORT_ICD', 'IMPORT_CFS']);
    expect(byBranch.find((b) => b.branch === 'IMPORT_CFS')?.median).toBe(2);
    expect(byBranch.find((b) => b.branch === 'EXPORT_ICD')?.median).toBe(50);
    // worst tail first, so the actionable branch leads
    expect(byBranch[0]!.branch).toBe('EXPORT_ICD');
  });

  it('measures an in-port container against asOf, not its last event', () => {
    // GATE_IN only, no terminal event → still in port at asOf (12 h later).
    const events = [journey('MSKU0000003', 0)[0]!];
    const r = containerDwell(emptyInputs({
      events, containers: [box('MSKU0000003', 'IMPORT_DPD')], asOf: '2026-06-10T12:00:00.000Z',
    }));
    expect(r.distribution?.byBranch[0]?.median).toBe(12);
  });

  it('is empty-safe', () => {
    const r = containerDwell(emptyInputs({}));
    expect(r.distribution?.count).toBe(0);
    expect(r.value).toBe(0);
  });
});
