/**
 * World generator — the static spatial backdrop (prompt §3, Addendum A.1).
 * Builds Facilities (terminals, CFS, ICD, DPE, DPD, ECD, CPP, rail sidings) and
 * Terminals from config/terminals.json so there is ONE source of truth for the
 * operator list and geometry. Additional non-terminal facilities (CFS/ICD/...)
 * are seeded around the port deterministically.
 */
import type {
  Facility,
  GeoPoint,
  Terminal,
  TosAccessMode,
} from '@jnpa/schemas';
import { Rng } from '../rng.js';

interface TerminalConfigEntry {
  terminalId: string;
  name: string;
  operator: string;
  status: string;
  quayLengthM?: number;
  capacityTEU?: number;
  geom: GeoPoint;
  gates: string[];
  sidingMapping: { rail: Array<'T1' | 'T2'> };
  tos: { mode: TosAccessMode; ediVersion?: string };
}

interface SidingConfigEntry {
  sidingId: 'T1' | 'T2';
  name: string;
  geom: GeoPoint;
}

export interface TerminalsConfig {
  terminals: TerminalConfigEntry[];
  railSidings: SidingConfigEntry[];
}

export interface World {
  facilities: Facility[];
  terminals: Terminal[];
}

/** JNPT centroid-ish for placing satellite facilities. */
const PORT_CENTER: [number, number] = [72.949, 18.95];

function jitterPoint(rng: Rng, base: [number, number], radiusDeg: number): GeoPoint {
  return {
    type: 'Point',
    coordinates: [
      base[0] + rng.float(-radiusDeg, radiusDeg),
      base[1] + rng.float(-radiusDeg, radiusDeg),
    ],
  };
}

export function buildWorld(config: TerminalsConfig, seed = 42): World {
  const rng = new Rng(seed).fork('world');
  const facilities: Facility[] = [];
  const terminals: Terminal[] = [];

  // Terminals (from config) → also a TERMINAL facility each.
  for (const t of config.terminals) {
    terminals.push({
      terminalId: t.terminalId,
      name: t.name,
      operator: t.operator,
      status: (t.status as Terminal['status']) ?? 'OPERATING',
      geom: t.geom,
      quayLengthM: t.quayLengthM,
      capacityTEU: t.capacityTEU,
      gates: t.gates,
      sidings: t.sidingMapping.rail,
      tos: { mode: t.tos.mode, ediVersion: t.tos.ediVersion },
    });
    facilities.push({
      facilityId: t.terminalId,
      type: 'TERMINAL',
      name: t.name,
      operator: t.operator,
      geom: t.geom,
      capacityTEU: t.capacityTEU,
      currentPendency: 0,
    });
  }

  // Rail sidings (from config).
  for (const s of config.railSidings) {
    facilities.push({
      facilityId: s.sidingId,
      type: 'RAIL_SIDING',
      name: s.name,
      operator: 'JNPA',
      geom: s.geom,
      currentPendency: 0,
    });
  }

  // Satellite facilities around the port (deterministic placement).
  const satellites: Array<{ id: string; type: Facility['type']; name: string; operator: string }> = [
    { id: 'CFS-PUNE', type: 'CFS', name: 'Pune CFS', operator: 'Balmer Lawrie' },
    { id: 'CFS-DRONAGIRI', type: 'CFS', name: 'Dronagiri CFS', operator: 'CWC' },
    { id: 'CFS-PANVEL', type: 'CFS', name: 'Panvel CFS', operator: 'Continental' },
    { id: 'ICD-DADRI', type: 'ICD', name: 'ICD Dadri', operator: 'CONCOR' },
    { id: 'ICD-NAGPUR', type: 'ICD', name: 'ICD Nagpur', operator: 'CONCOR' },
    { id: 'DPE-WEST', type: 'DPE', name: 'Direct Port Entry (West)', operator: 'JNPA' },
    { id: 'DPD-CENTRAL', type: 'DPD', name: 'Direct Port Delivery Yard', operator: 'JNPA' },
    { id: 'ECD-MAEU', type: 'ECD', name: 'Maersk Empty Depot', operator: 'Maersk' },
    { id: 'ECD-MSC', type: 'ECD', name: 'MSC Empty Depot', operator: 'MSC' },
    { id: 'CPP-1', type: 'CPP', name: 'Central Parking Plaza', operator: 'JNPA' },
  ];
  for (const s of satellites) {
    facilities.push({
      facilityId: s.id,
      type: s.type,
      name: s.name,
      operator: s.operator,
      geom: jitterPoint(rng, PORT_CENTER, 0.05),
      capacityTEU: s.type === 'CFS' || s.type === 'ICD' ? rng.int(5000, 25000) : undefined,
      currentPendency: 0,
    });
  }

  return { facilities, terminals };
}
