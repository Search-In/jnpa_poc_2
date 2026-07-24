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
 * and a Pune-belt CFS physically on top of JNPA — geographically nonsense and
 * the cause of the mis-aligned map markers. Each now sits at its true location
 * (CFS/ICDs at their real cities; on-port depots/plaza near JNPT) so both the
 * 2D map and the 3D scene place them where they actually are. Sources are the
 * respective facility's published address / OSM; good enough for a PoC twin and
 * clearly better than random. Replace with surveyed points before production.
 */
const SATELLITE_COORDS: Record<string, [number, number]> = {
  // Off-port CFS — synthetic-but-plausible nodes placed on the real
  // Nhava Sheva / Uran / Panvel / Dronagiri CFS belt (Guardrail §10: NO real
  // CFS brand names — these are demonstration entities at plausible locations).
  'CFS-DRONAGIRI-1': [72.9975, 18.8895], // Dronagiri node, Navi Mumbai (near port)
  'CFS-DRONAGIRI-2': [72.9880, 18.8790], // Dronagiri node, second cluster
  'CFS-URAN-1': [72.9560, 18.8760], // Uran belt
  'CFS-PANVEL-1': [73.1005, 18.9894], // Panvel
  'CFS-PANVEL-2': [73.0820, 18.9720], // Panvel, second cluster
  'CFS-TALOJA-1': [73.0980, 19.0810], // Taloja industrial belt
  'CFS-JNPT-SEZ-1': [72.9720, 18.9260], // JNPT SEZ road CFS
  'CFS-KALAMBOLI-1': [73.1010, 19.0270], // Kalamboli
  // Off-port ICDs — synthetic hinterland nodes at representative regions.
  'ICD-NORTH-1': [77.6050, 28.5610], // northern hinterland (Delhi-NCR region)
  'ICD-NORTH-2': [75.8570, 30.9010], // northern hinterland (Punjab region)
  'ICD-WEST-1': [72.6350, 23.0220], // western hinterland (Gujarat region)
  'ICD-CENTRAL-1': [79.0490, 21.1180], // central hinterland (Nagpur region)
  'ICD-SOUTH-1': [77.5946, 12.9716], // southern hinterland (Karnataka region)
  // On/near-port JNPA facilities — clustered around the port road network.
  'DPE-WEST': [72.9480, 18.9464], // Direct Port Entry (was [72.9430,18.9490] — sat ~300 m SEAWARD of the quay line, i.e. in Thane Creek; a land-side facility, so nudged ESE onto the landward port band, same corridor — cf. CPP-1)
  'DPD-CENTRAL': [72.9550, 18.9537], // Direct Port Delivery yard (was [72.9505,18.9560] — sat ~240 m seaward in the creek; nudged ESE onto the developed land band east of the quay)
  'ECD-1': [72.9640, 18.9420], // Empty container depot, JNPT SEZ road
  'ECD-2': [72.9670, 18.9385], // Empty container depot, JNPT SEZ road
  'CPP-1': [72.9560, 18.9500], // Centralized Parking Plaza, port-entry landside (was 18.9605 — fell in the creek N of the port; moved S onto the developed yard band, same lng corridor)
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
  // Guardrail §10: NO real CFS/company brand names — all synthetic-but-plausible
  // demonstration entities. The ~30-CFS / ~50-ICD ecosystem (spec §2) is modelled
  // here at a representative sample (8 CFS on the Nhava Sheva/Uran/Panvel/Dronagiri
  // belt + 5 hinterland ICDs); operators are synthetic node designations, not real
  // firms. Provenance: synthetic (see docs/ASSUMPTIONS.md + seed/jnpa_grounding.json).
  const satellites: Array<{ id: string; type: Facility['type']; name: string; operator: string }> = [
    { id: 'CFS-DRONAGIRI-1', type: 'CFS', name: 'Dronagiri CFS 1', operator: 'CFS Operator A (synthetic)' },
    { id: 'CFS-DRONAGIRI-2', type: 'CFS', name: 'Dronagiri CFS 2', operator: 'CFS Operator B (synthetic)' },
    { id: 'CFS-URAN-1', type: 'CFS', name: 'Uran CFS 1', operator: 'CFS Operator C (synthetic)' },
    { id: 'CFS-PANVEL-1', type: 'CFS', name: 'Panvel CFS 1', operator: 'CFS Operator D (synthetic)' },
    { id: 'CFS-PANVEL-2', type: 'CFS', name: 'Panvel CFS 2', operator: 'CFS Operator E (synthetic)' },
    { id: 'CFS-TALOJA-1', type: 'CFS', name: 'Taloja CFS 1', operator: 'CFS Operator F (synthetic)' },
    { id: 'CFS-JNPT-SEZ-1', type: 'CFS', name: 'JNPT SEZ CFS 1', operator: 'CFS Operator G (synthetic)' },
    { id: 'CFS-KALAMBOLI-1', type: 'CFS', name: 'Kalamboli CFS 1', operator: 'CFS Operator H (synthetic)' },
    { id: 'ICD-NORTH-1', type: 'ICD', name: 'ICD North 1', operator: 'ICD Operator N1 (synthetic)' },
    { id: 'ICD-NORTH-2', type: 'ICD', name: 'ICD North 2', operator: 'ICD Operator N2 (synthetic)' },
    { id: 'ICD-WEST-1', type: 'ICD', name: 'ICD West 1', operator: 'ICD Operator W1 (synthetic)' },
    { id: 'ICD-CENTRAL-1', type: 'ICD', name: 'ICD Central 1', operator: 'ICD Operator C1 (synthetic)' },
    { id: 'ICD-SOUTH-1', type: 'ICD', name: 'ICD South 1', operator: 'ICD Operator S1 (synthetic)' },
    { id: 'DPE-WEST', type: 'DPE', name: 'Direct Port Entry (West)', operator: 'JNPA' },
    { id: 'DPD-CENTRAL', type: 'DPD', name: 'Direct Port Delivery Yard', operator: 'JNPA' },
    { id: 'ECD-1', type: 'ECD', name: 'Empty Container Depot 1', operator: 'ECD Operator 1 (synthetic)' },
    { id: 'ECD-2', type: 'ECD', name: 'Empty Container Depot 2', operator: 'ECD Operator 2 (synthetic)' },
    { id: 'CPP-1', type: 'CPP', name: 'Centralized Parking Plaza', operator: 'JNPA' },
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
