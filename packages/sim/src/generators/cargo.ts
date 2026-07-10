/**
 * Cargo dataset generator (prompt §3 spine, §8 KPIs). Produces an internally
 * consistent world over a time window: containers with full CargoEvent
 * lifecycles, GateTransactions, Rakes+Wagons, ITRHO movements, ScanEvents,
 * EmptyPools and ShippingDocs. Seeded → identical every run (Addendum B.2).
 *
 * The numbers are tuned so KPIs land near the configured baselines with a
 * realistic spread, so the dashboard and improvement-% are believable.
 */
import type {
  CargoEvent,
  Container,
  ContainerSizeFt,
  EmptyPool,
  EventType,
  GateTransaction,
  ITRHOMovement,
  OriginStream,
  Rake,
  ScanEvent,
  ShippingDoc,
  SidingId,
  Wagon,
} from '@jnpa/schemas';
import { withCheckDigit } from '@jnpa/schemas';
import { Rng, simId } from '../rng.js';
import type { World } from './world.js';

const HOUR = 3_600_000;

const LINE_CODES = ['MAEU', 'MSCU', 'CMAU', 'HLCU', 'ONEY', 'COSU', 'APZU'] as const;
const CARGO_TYPES = ['GENERAL', 'ELECTRONICS', 'TEXTILES', 'AUTO_PARTS', 'CHEMICALS', 'REEFER_FOOD'] as const;
const ISO_TYPES: Record<ContainerSizeFt, string[]> = {
  20: ['22G1', '22R1'],
  40: ['42G1', '45G1', '45R1'],
  45: ['L5G1'],
};
const IMPORT_STREAMS: OriginStream[] = ['IMPORT_CFS', 'IMPORT_ICD', 'IMPORT_DPD'];
const EXPORT_STREAMS: OriginStream[] = ['EXPORT_CFS', 'EXPORT_ICD', 'EXPORT_DPE'];

export interface CargoDataset {
  containers: Container[];
  events: CargoEvent[];
  gateTransactions: GateTransaction[];
  rakes: Rake[];
  wagons: Wagon[];
  itrho: ITRHOMovement[];
  scans: ScanEvent[];
  emptyPools: EmptyPool[];
  shippingDocs: ShippingDoc[];
}

export interface CargoGenOptions {
  seed?: number;
  /** Window start (epoch ms). */
  startMs: number;
  /** Window length in hours. */
  windowHours?: number;
  /** Number of containers to generate. */
  containerCount?: number;
}

function makeContainerNo(rng: Rng): string {
  const owner = rng.pick(LINE_CODES).slice(0, 3);
  const serial = String(rng.int(100000, 999999));
  return withCheckDigit(`${owner}U${serial}`);
}

function pushEvent(
  events: CargoEvent[],
  rng: Rng,
  base: Omit<CargoEvent, 'eventId' | 'sourceOffsetMin' | 'rawRef'> & { rawRefSuffix?: string },
): CargoEvent {
  const ev: CargoEvent = {
    eventId: simId(rng, 'EVT'),
    sourceOffsetMin: 330,
    rawRef: `raw/sim/${base.sourceSystem.toLowerCase()}/${base.containerNo}-${base.eventType}-${base.ts}`,
    containerNo: base.containerNo,
    eventType: base.eventType,
    ts: base.ts,
    facilityId: base.facilityId,
    terminalId: base.terminalId,
    gateId: base.gateId,
    vehicleNo: base.vehicleNo,
    rakeId: base.rakeId,
    sourceSystem: base.sourceSystem,
    payload: base.payload,
  };
  events.push(ev);
  return ev;
}

export function generateCargo(world: World, opts: CargoGenOptions): CargoDataset {
  const rng = new Rng(opts.seed ?? 7).fork('cargo');
  const startMs = opts.startMs;
  const windowMs = (opts.windowHours ?? 48) * HOUR;
  const count = opts.containerCount ?? 400;

  const terminals = world.terminals;
  const cfsList = world.facilities.filter((f) => f.type === 'CFS').map((f) => f.facilityId);
  const icdList = world.facilities.filter((f) => f.type === 'ICD').map((f) => f.facilityId);
  const ecdList = world.facilities.filter((f) => f.type === 'ECD');

  const containers: Container[] = [];
  const events: CargoEvent[] = [];
  const gateTransactions: GateTransaction[] = [];
  const rakes: Rake[] = [];
  const wagons: Wagon[] = [];
  const itrho: ITRHOMovement[] = [];
  const scans: ScanEvent[] = [];
  const shippingDocs: ShippingDoc[] = [];

  const iso = (ms: number) => new Date(ms).toISOString();

  for (let i = 0; i < count; i++) {
    const containerNo = makeContainerNo(rng);
    const isImport = rng.bool(0.55);
    const isTransship = rng.bool(0.12);
    const originStream: OriginStream = isTransship
      ? 'TRANSSHIP'
      : isImport
        ? rng.pick(IMPORT_STREAMS)
        : rng.pick(EXPORT_STREAMS);

    const sizeFt = rng.pick<ContainerSizeFt>([20, 40, 45]);
    const isoTypeCode = rng.pick(ISO_TYPES[sizeFt]);
    const isReefer = isoTypeCode.includes('R');
    const lineOwner = rng.pick(LINE_CODES);
    const terminal = rng.pick(terminals);

    // Arrival jittered across the window.
    const arriveMs = startMs + rng.int(0, windowMs - 6 * HOUR);
    const sealNo = `SEAL${rng.int(100000, 999999)}`;

    const container: Container = {
      containerNo,
      isoTypeCode,
      sizeFt,
      laden: !rng.bool(0.18),
      grossWtKg: rng.int(sizeFt === 20 ? 8000 : 12000, sizeFt === 20 ? 24000 : 32000),
      cargoType: isReefer ? 'REEFER_FOOD' : rng.pick(CARGO_TYPES.filter((c) => c !== 'REEFER_FOOD')),
      ...(isReefer
        ? { reefer: { setpointC: rng.int(-25, 8), currentC: rng.int(-25, 8) } }
        : {}),
      ...(rng.bool(0.06)
        ? { hazmatIMDG: { imdgClass: rng.pick(['3', '8', '9']), packingGroup: rng.pick(['I', 'II', 'III']) } }
        : {}),
      lineOwner,
      currentSealNo: sealNo,
      status: 'DEPARTED',
      originStream,
      lastUpdatedTs: iso(arriveMs),
    };

    // -------- lifecycle event chain ----------------------------------------
    let cursor = arriveMs;
    const vehicleNo = `MH${rng.int(1, 20).toString().padStart(2, '0')}${rng.pick(['AB', 'CD', 'EF'])}${rng.int(1000, 9999)}`;
    const gateId = rng.pick(terminal.gates);

    if (isImport || isTransship) {
      // Vessel discharge → yard
      pushEvent(events, rng, {
        containerNo, eventType: 'YARD_MOVE', ts: iso(cursor),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'TOS', payload: { movement: 'DISCHARGE', isoTypeCode },
      });
      cursor += rng.int(1, 4) * HOUR;
    }

    // Customs flag for some
    const flaggedForScan = rng.bool(0.22);
    if (flaggedForScan) {
      pushEvent(events, rng, {
        containerNo, eventType: 'CUSTOMS_FLAG', ts: iso(cursor),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'ICEGATE', payload: { selectedForScan: true, dpdReady: originStream === 'IMPORT_DPD' },
      });
      // scan
      const scanStart = cursor + rng.int(20, 90) * 60_000;
      const scanEnd = scanStart + rng.int(1, 4) * HOUR; // Scanner TAT ~baseline 2.5h
      pushEvent(events, rng, {
        containerNo, eventType: 'SCAN_START', ts: iso(scanStart),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'ICEGATE', payload: {},
      });
      pushEvent(events, rng, {
        containerNo, eventType: 'SCAN_END', ts: iso(scanEnd),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'ICEGATE', payload: {},
      });
      scans.push({
        scanId: simId(rng, 'SCN'),
        containerNo,
        scannerId: `${terminal.terminalId}-SCN1`,
        flaggedBy: rng.bool(0.8) ? 'CUSTOMS' : 'RANDOM',
        startTs: iso(scanStart),
        endTs: iso(scanEnd),
        result: rng.pick(['CLEAR', 'CLEAR', 'CLEAR', 'HOLD', 'EXAM']),
      });
      cursor = scanEnd + rng.int(10, 40) * 60_000;
    }

    // Import to an ICD → destuffing at the ICD (uses icdList)
    if (originStream === 'IMPORT_ICD' && icdList.length > 0) {
      pushEvent(events, rng, {
        containerNo, eventType: 'DESTUFFING', ts: iso(cursor),
        facilityId: rng.pick(icdList),
        sourceSystem: 'ICEGATE', payload: {},
      });
      cursor += rng.int(1, 3) * HOUR;
    }

    // Damage flag (rare)
    if (rng.bool(0.05)) {
      pushEvent(events, rng, {
        containerNo, eventType: 'DAMAGE_FLAG', ts: iso(cursor),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'TOS', payload: { note: 'Door panel dent observed' },
      });
    }

    // Export LEO / stuffing
    if (!isImport && !isTransship) {
      pushEvent(events, rng, {
        containerNo, eventType: 'STUFFING', ts: iso(cursor),
        facilityId: rng.pick(cfsList.length ? cfsList : [terminal.terminalId]),
        sourceSystem: 'ICEGATE', payload: {},
      });
      cursor += rng.int(1, 3) * HOUR;
      pushEvent(events, rng, {
        containerNo, eventType: 'LEO', ts: iso(cursor),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId,
        sourceSystem: 'ICEGATE', payload: {},
      });
      cursor += rng.int(1, 3) * HOUR;
    }

    // Decide road vs rail egress
    const viaRail = rng.bool(0.4);
    const gateInMs = arriveMs - rng.int(0, 1) * HOUR; // trailer arrives near discharge for some
    if (!viaRail) {
      // Trailer gate-in then gate-out → Trailer TAT
      const tin = isImport ? cursor : Math.min(gateInMs, cursor);
      const arrivalAtGate = tin - rng.int(10, 40) * 60_000;
      pushEvent(events, rng, {
        containerNo, eventType: 'GATE_IN', ts: iso(tin),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId, gateId, vehicleNo,
        sourceSystem: 'TOS', payload: { isoTypeCode, sealNo, transportMode: 'ROAD' },
      });
      // Trailer TAT ~ baseline 4h
      const tout = tin + rng.int(2, 6) * HOUR;
      pushEvent(events, rng, {
        containerNo, eventType: 'ESEAL_AFFIX', ts: iso(tin),
        facilityId: terminal.terminalId, gateId, sourceSystem: 'ESEAL', payload: { sealNo },
      });
      pushEvent(events, rng, {
        containerNo, eventType: 'GATE_OUT', ts: iso(tout),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId, gateId, vehicleNo,
        sourceSystem: 'TOS', payload: { isoTypeCode, transportMode: 'ROAD' },
      });
      // gate transactions (IN and OUT)
      gateTransactions.push({
        gateTxnId: simId(rng, 'GTX'), gateId, direction: 'IN', vehicleNo, containerNo,
        appointmentRef: rng.bool(0.7) ? `APPT-${rng.int(10000, 99999)}` : undefined,
        arrivalTs: iso(arrivalAtGate), startTs: iso(tin), endTs: iso(tin + rng.int(5, 18) * 60_000),
        docsVerified: ['FORM13', 'DO', 'ESEAL'], outcome: rng.bool(0.95) ? 'CLEARED' : 'HELD',
      });
      gateTransactions.push({
        gateTxnId: simId(rng, 'GTX'), gateId, direction: 'OUT', vehicleNo, containerNo,
        arrivalTs: iso(tout - rng.int(5, 20) * 60_000), startTs: iso(tout),
        endTs: iso(tout + rng.int(4, 12) * 60_000),
        docsVerified: ['FORM13', 'ESEAL'], outcome: 'CLEARED',
      });
      cursor = tout;
    }

    // Trans-shipment ITRHO move between two terminals (road/rail)
    if (isTransship && terminals.length > 1) {
      const toTerminal = rng.pick(terminals.filter((t) => t.terminalId !== terminal.terminalId));
      const reqMs = cursor;
      const outMs = reqMs + rng.int(20, 90) * 60_000;
      const inMs = outMs + rng.int(3, 9) * HOUR; // Inter-Terminal TAT ~baseline 6h
      const mode = rng.bool(0.5) ? 'RAIL' : 'ROAD';
      itrho.push({
        itrhoId: simId(rng, 'ITR'), containerNo,
        fromTerminalId: terminal.terminalId, toTerminalId: toTerminal.terminalId,
        requestedTs: iso(reqMs), outTs: iso(outMs), inTs: iso(inMs), mode,
      });
      pushEvent(events, rng, {
        containerNo, eventType: 'ITRHO_OUT', ts: iso(outMs),
        facilityId: terminal.terminalId, terminalId: terminal.terminalId, sourceSystem: 'TOS', payload: { mode },
      });
      pushEvent(events, rng, {
        containerNo, eventType: 'ITRHO_IN', ts: iso(inMs),
        facilityId: toTerminal.terminalId, terminalId: toTerminal.terminalId, sourceSystem: 'TOS', payload: { mode },
      });
      cursor = inMs;
    }

    // Shipping doc
    if (rng.bool(0.6)) {
      shippingDocs.push({
        docId: simId(rng, 'DOC'),
        type: isImport ? rng.pick(['IAL', 'DO', 'BE']) : rng.pick(['EAL', 'SB', 'FORM13']),
        containerNos: [containerNo],
        lineId: lineOwner,
        issuedTs: iso(arriveMs - rng.int(1, 24) * HOUR),
        payload: { stream: originStream },
      });
    }

    containers.push(container);
  }

  // -------- Rakes (rail-side T1/T2) + wagons + RAIL_IN/OUT events ----------
  const rakeContainers = containers.filter((_, idx) => idx % 5 === 0); // a subset move by rail
  const RAKE_COUNT = Math.max(8, Math.floor(rakeContainers.length / 60));
  let rakeContainerCursor = 0;
  for (let r = 0; r < RAKE_COUNT; r++) {
    // Balance rakes across both sidings AND both directions so T1 and T2 each get
    // realistic inbound and outbound traffic. Independent 50/50 draws over the
    // small rake count could otherwise leave a siding with zero inbound trains.
    const sidingId: SidingId = r % 2 === 0 ? 'T1' : 'T2';
    const terminal = rng.pick(terminals.filter((t) => t.sidings.includes(sidingId)).length
      ? terminals.filter((t) => t.sidings.includes(sidingId))
      : terminals);
    const direction = Math.floor(r / 2) % 2 === 0 ? 'INBOUND' : 'OUTBOUND';
    const arrivalMs = startMs + rng.int(0, windowMs - 12 * HOUR);
    const placementMs = arrivalMs + rng.int(1, 3) * HOUR;
    const removalMs = placementMs + rng.int(2, 5) * HOUR;
    const departureMs = removalMs + rng.int(1, 3) * HOUR; // Rake TAT ~baseline 8.5h
    const wagonCount = rng.int(40, 45);
    const mixedFlag = rng.bool(0.35);
    const rakeId = simId(rng, 'RK');
    // Synthetic Container Train Operator codes (Guardrail §10: no real CTO brands).
    const ctoOperator = rng.pick(['CTO-1', 'CTO-2', 'CTO-3', 'CTO-4']);

    rakes.push({
      rakeId, ctoOperator, trainNo: String(rng.int(10000, 99999)),
      foisRef: `FOIS-${rng.int(100000, 999999)}`, sidingId, terminalId: terminal.terminalId,
      arrivalTs: iso(arrivalMs), placementTs: iso(placementMs), removalTs: iso(removalMs),
      departureTs: iso(departureMs), wagonCount, direction, mixedFlag,
    });

    // wagons each carry 1-2 containers from the rail subset
    const perRake = rng.int(60, 84); // containers per rake — near mixed-train baseline
    const assigned: string[] = [];
    for (let w = 0; w < wagonCount; w++) {
      const onWagon: string[] = [];
      const k = rng.int(1, 2);
      for (let c = 0; c < k; c++) {
        const cn = rakeContainers[rakeContainerCursor % rakeContainers.length]!.containerNo;
        onWagon.push(cn);
        // RAIL events (and the mixed-train KPI) use only the real, non-wrapped
        // assignments — kept identical; the wagon display cycles the pool so that
        // no wagon (on any rake / siding) is left with an empty container list.
        if (rakeContainerCursor < rakeContainers.length) assigned.push(cn);
        rakeContainerCursor++;
      }
      wagons.push({ wagonId: simId(rng, 'WG'), rakeId, position: w + 1, containerNos: onWagon });
    }

    // RAIL_IN / RAIL_OUT events for assigned containers
    for (const cn of assigned.slice(0, perRake)) {
      const evType: EventType = direction === 'INBOUND' ? 'RAIL_IN' : 'RAIL_OUT';
      pushEvent(events, rng, {
        containerNo: cn, eventType: evType, ts: iso(direction === 'INBOUND' ? placementMs : removalMs),
        facilityId: sidingId, terminalId: terminal.terminalId, rakeId, sourceSystem: 'FOIS', payload: { sidingId },
      });
    }
  }

  // -------- Empty pools per line/depot ------------------------------------
  const emptyPools: EmptyPool[] = [];
  for (const depot of ecdList) {
    for (const line of LINE_CODES) {
      if (rng.bool(0.5)) continue;
      emptyPools.push({
        lineId: line,
        depotId: depot.facilityId,
        availableQty: rng.int(50, 600),
        projectedDemandQty: rng.int(40, 650),
        asOfTs: iso(startMs + windowMs),
      });
    }
  }

  // Sort events chronologically (the spine is an ordered stream).
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  return { containers, events, gateTransactions, rakes, wagons, itrho, scans, emptyPools, shippingDocs };
}
