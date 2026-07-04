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

/**
 * Real-world coordinates for the off-port satellite facilities (EPSG:4326
 * [lng, lat]). These were previously scattered at random within 0.05° of the
 * port centroid by jitterPoint, which put "ICD Dadri" (near Greater Noida, UP)
 * and "Pune CFS" (Pune) physically on top of JNPA — geographically nonsense and
 * the cause of the mis-aligned map markers. Each now sits at its true location
 * (CFS/ICDs at their real cities; on-port depots/plaza near JNPT) so both the
 * 2D map and the 3D scene place them where they actually are. Sources are the
 * respective facility's published address / OSM; good enough for a PoC twin and
 * clearly better than random. Replace with surveyed points before production.
 */
const SATELLITE_COORDS: Record<string, [number, number]> = {
  // Off-port CFS / ICDs — at their real cities (far from the port).
  'CFS-PUNE': [73.9143, 18.6298], // Chakan/Pune industrial belt
  'CFS-DRONAGIRI': [72.9975, 18.8895], // Dronagiri node, Navi Mumbai (near port)
  'CFS-PANVEL': [73.1005, 18.9894], // Panvel
  'ICD-DADRI': [77.6050, 28.5610], // ICD Dadri, Greater Noida, UP (CONCOR)
  'ICD-NAGPUR': [79.0490, 21.1180], // ICD Nagpur (CONCOR)
  // On/near-port JNPA facilities — clustered around the port road network.
  'DPE-WEST': [72.9430, 18.9490], // Direct Port Entry, west of the terminals
  'DPD-CENTRAL': [72.9505, 18.9560], // Direct Port Delivery yard, central
  'ECD-MAEU': [72.9640, 18.9420], // Maersk empty depot, JNPT SEZ road
  'ECD-MSC': [72.9670, 18.9385], // MSC empty depot, JNPT SEZ road
  'CPP-1': [72.9560, 18.9605], // Central Parking Plaza, port entry
};

/** Real coordinate for a satellite id, or a deterministic fallback near port. */
function satellitePoint(rng: Rng, id: string): GeoPoint {
  const real = SATELLITE_COORDS[id];
  if (real) return { type: 'Point', coordinates: [real[0], real[1]] };
  // Fallback for any future id without a mapping: small deterministic offset.
  return {
    type: 'Point',
    coordinates: [PORT_CENTER[0] + rng.float(-0.02, 0.02), PORT_CENTER[1] + rng.float(-0.02, 0.02)],
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
      geom: satellitePoint(rng, s.id),
      capacityTEU: s.type === 'CFS' || s.type === 'ICD' ? rng.int(5000, 25000) : undefined,
      currentPendency: 0,
    });
  }

  return { facilities, terminals };
}
