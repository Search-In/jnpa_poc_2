/**
 * scene3d.ts — the 3D sea-port builders for the ArcGIS SceneView (WebGL 3D).
 *
 * v2: everything is now laid out in a QUAY-ALIGNED frame and uses REAL glTF
 * meshes (CC0, vendored under /public/models) instead of coloured boxes.
 *
 * Geometry frame — the real JNPA wharf runs on a ~208° bearing (NNE→SSW) with
 * the Thane Creek navigation channel (open water) on the WEST/SW side. So for
 * each terminal centroid we build a local frame:
 *   • `along`  — metres parallel to the quay (+ = toward BMCT / south)
 *   • `offset` — metres perpendicular; NEGATIVE = seaward (water, ships, cranes
 *                boom this way), POSITIVE = landward (yards, gates, roads).
 * This makes ships berth on the water face, cranes face the water, and container
 * yards/gates sit inland — matching the actual port, instead of the old
 * axis-aligned boxes scattered around each point.
 *
 * Models actually rendered here (all CC0/CC-BY — see public/models/CREDITS.md):
 *   • ship-cargo-a.glb / -b         — berthed container vessels (Kenney Watercraft)
 *   • yard-container-red/green/blue — the stacked ISO boxes of each yard block
 *   • cargo-pile-a/b.glb,
 *     cargo-container-a/b/c.glb     — loose cargo decorating the quay apron
 *   • toll-naka.glb                 — the gate / toll-plaza structure
 *   • truck-realistic.glb,
 *     container-truck.glb           — the trucks queued at each gate
 *   • sts-crane.glb                 — quay/gantry crane (poly.pizza, CC-BY 3.0,
 *                                     J-Toastie) standing on the waterline
 *
 * Vendored but NOT referenced by the scene today: container-ship.glb (a
 * higher-detail hull whose geometry sits partly below its origin, so swapping it
 * in needs a re-tuned symbol height + waterline offset), gate.glb,
 * gate-realistic.glb, gate-boom.glb, shipping-port.glb, truck.glb, delivery.glb,
 * pickup-realistic.glb.
 *
 * Colours still come from theme tokens (§14). Live updates reuse the stable
 * objectId + applyGraphics diff from layers.ts (in-place, no blink).
 */
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import Polyline from '@arcgis/core/geometry/Polyline';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { tokens } from '../theme/tokens.js';
import { stableOid } from './layers.js';
import { placementStore } from './placementStore.js';

/**
 * If the user has dragged the asset with this placement key, return its override
 * [lng, lat]; otherwise return the derived position. Every draggable graphic
 * also carries `pkey` so the edit-mode drag handler knows which asset it moved.
 */
function withOverride(pkey: string, derived: [number, number]): [number, number] {
  const o = placementStore.get(pkey);
  return o ? [o.lng, o.lat] : derived;
}

// ---- quay-aligned local frame ---------------------------------------------

const LAT = 18.945;
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);
const dLat = (m: number) => m / M_PER_DEG_LAT;
const dLon = (m: number) => m / M_PER_DEG_LON;

/** Real JNPA wharf bearing (deg): NNE→SSW, JNPCT(N) → BMCT(S). */
export const QUAY_BEARING_DEG = 208;
const BRG = (QUAY_BEARING_DEG * Math.PI) / 180;
// Unit vector in metres for the "along-quay" axis (points down-quay, ~SSW).
const alongE = Math.sin(BRG); // east component of "along"
const alongN = Math.cos(BRG); // north component of "along"
// SEAWARD points at the Thane Creek channel — to the WEST/SW of the quays. That
// is the along-axis rotated +90° (bearing ≈ 298°, i.e. WNW→ has west component).
const SEAWARD_BRG = ((QUAY_BEARING_DEG + 90) % 360) * (Math.PI / 180); // ≈298°
const seaE = Math.sin(SEAWARD_BRG); // ≈ -0.88 (west)
const seaN = Math.cos(SEAWARD_BRG); // ≈ +0.47 (slightly north)

/**
 * Place a point relative to a terminal centroid in the quay frame.
 * @param alongM  metres down-quay (+south / toward BMCT)
 * @param offsetM metres perpendicular: NEGATIVE = seaward (water, ships, cranes),
 *                POSITIVE = landward (yards, gates, roads).
 */
// Global landward bias (m): the config berth centroids sit seaward of the
// visible quay edge on the imagery (they mark the channel-side berth line, not
// the terminal yards), so nudge the whole quay frame inland so the waterline,
// ships and cranes seat on the real wharf and the yards land on the real
// container blocks rather than in open water.
const LANDWARD_BIAS_M = 150;

export function place(lng: number, lat: number, alongM: number, offsetM: number): [number, number] {
  // +offsetM landward = OPPOSITE of the seaward unit vector.
  const off = offsetM + LANDWARD_BIAS_M;
  const e = alongM * alongE - off * seaE;
  const n = alongM * alongN - off * seaN;
  return [lng + dLon(e), lat + dLat(n)];
}

/** Shift an absolute point by along/offset metres in the quay frame (NO bias) —
 *  for trailing assets (truck queues) relative to an already-placed anchor. */
export function offsetFrom(lng: number, lat: number, alongM: number, offsetM: number): [number, number] {
  const e = alongM * alongE - offsetM * seaE;
  const n = alongM * alongN - offsetM * seaN;
  return [lng + dLon(e), lat + dLat(n)];
}

/**
 * Bearing (deg, compass) from point A to point B in the local quay frame — used
 * to face a moving model along its travel direction. Uses the same metric frame
 * as {@link place} so headings are consistent with the static asset headings.
 */
export function headingBetween(a: [number, number], b: [number, number]): number {
  const e = (b[0] - a[0]) * M_PER_DEG_LON;
  const n = (b[1] - a[1]) * M_PER_DEG_LAT;
  const deg = (Math.atan2(e, n) * 180) / Math.PI; // 0 = north, CW positive
  return (deg + 360) % 360;
}

/**
 * Heading (deg) that aligns a model's long axis PARALLEL to the quay.
 * `MODEL_ROTATION_DEG` spins every 3D model in place (positions unchanged): all
 * item headings derive from QUAY_HEADING (+ per-model offset), so this one lever
 * rotates the whole fleet uniformly. Set to 90 to turn every model a quarter turn.
 */
const MODEL_ROTATION_DEG = 90;
const QUAY_HEADING = (QUAY_BEARING_DEG + MODEL_ROTATION_DEG) % 360;

/** Deterministic 0..1 from a key — no Math.random (stable replays). */
function rand01(key: string, salt = ''): number {
  let h = 2166136261;
  const s = key + '|' + salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

const MODELS = '/models';

// A polygon rectangle in the quay frame (used for the flat quay apron deck).
function quayRect(lng: number, lat: number, alongLenM: number, offsetDepthM: number, offsetCenterM: number): number[][] {
  const a = alongLenM / 2;
  const o0 = offsetCenterM - offsetDepthM / 2;
  const o1 = offsetCenterM + offsetDepthM / 2;
  const c1 = place(lng, lat, -a, o0);
  const c2 = place(lng, lat, a, o0);
  const c3 = place(lng, lat, a, o1);
  const c4 = place(lng, lat, -a, o1);
  return [c1, c2, c3, c4, c1];
}

// ---------------------------------------------------------------------------
// Quay decks — flat apron platform per terminal, hugging the waterline.
// ---------------------------------------------------------------------------

function terminalDeckGraphics(terminals: Terminal[]): Graphic[] {
  return terminals
    .filter((t) => t.geom.type === 'Point')
    .map((t) => {
      const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
      const quay = t.quayLengthM ?? 800;
      // A thin quay-edge apron strip: 40 m deep, sitting just landward of the
      // waterline (centre +20 m). The satellite basemap already shows the real
      // concrete, so this is only a subtle edge to seat the cranes on — not a
      // giant slab over the water (the old 200 m deck read as a floating plane).
      return new Graphic({
        geometry: new Polygon({ rings: [quayRect(lng, lat, quay, 40, 20)], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`deck:${t.terminalId}`),
          terminalId: t.terminalId,
          name: t.name,
          operator: t.operator,
          status: t.status,
        },
      });
    });
}

export function terminalDeckLayer(terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Quay apron',
    // Hidden by default (the terminal-footprint slab); still in the LayerList so
    // it can be toggled back on during a demo.
    visible: false,
    source: terminalDeckGraphics(terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'terminalId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'operator', type: 'string' },
      { name: 'status', type: 'string' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [
          // Low, muted concrete apron that blends with the imagery rather than a
          // bright white slab; a thin edge line marks the quay.
          { type: 'extrude', size: 1, material: { color: [120, 128, 138, 0.55] }, edges: { type: 'solid', color: tokens.color.border, size: 0.5 } },
        ],
      },
    } as never,
    popupTemplate: { title: '{name}', content: 'Operator: {operator}<br/>Status: {status}' } as never,
  });
}

// ---------------------------------------------------------------------------
// Container-yard stacks — REAL ISO-container GLBs stacked into blocks behind each
// quay (matching the reference cockpit's stacked-box yards, not a single pile).
// Each block is a grid position; the stack HEIGHT (number of container tiers)
// scales with live pendency, so a full terminal literally stacks higher. Each
// tier is one container GLB at an increasing `z`, coloured red/green/blue per
// line. The block's `pkey` anchors the whole stack, so the placement editor
// moves every container in the block together.
// ---------------------------------------------------------------------------

const YARD_ROWS = 3;
const YARD_COLS = 4;
const CONTAINER_H_M = 5.8; // ISO container ≈ 2.6 m; we stack a touch taller for legibility
const YARD_MODELS = ['red', 'green', 'blue'] as const;

function yardBlockGraphics(terminals: Terminal[], pendency: PendencyDTO[]): Graphic[] {
  const pendById = new Map(pendency.map((p) => [p.facilityId, p.pendency] as const));
  const out: Graphic[] = [];
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const cap = t.capacityTEU ?? 6000;
    const totalPend = pendById.get(t.terminalId) ?? cap * 0.35;
    const quay = t.quayLengthM ?? 800;
    for (let r = 0; r < YARD_ROWS; r++) {
      for (let c = 0; c < YARD_COLS; c++) {
        const alongM = (c - (YARD_COLS - 1) / 2) * (quay / YARD_COLS);
        const offsetM = 230 + r * 70; // landward rows
        const i = r * YARD_COLS + c;
        const pkey = `yard:${t.terminalId}:${i}`;
        // The whole stack sits at the block anchor (honours a placement override).
        const [bx, by] = withOverride(pkey, place(lng, lat, alongM, offsetM));
        const jitter = 0.5 + rand01(t.terminalId, `blk${i}`) * 1.0;
        const frac = Math.max(0.05, Math.min(1, (totalPend / (cap * 0.9)) * jitter));
        // 1..6 container tiers driven by pendency (reference: h = 2 + …).
        const tiers = 1 + Math.round(frac * 5);
        const fillPct = Math.round(frac * 100);
        for (let k = 0; k < tiers; k++) {
          // Colour by fill severity for the top tier, else cycle line liveries so
          // the block reads as a real mixed container stack.
          const model = k === tiers - 1 && fillPct >= 66 ? 'red' : YARD_MODELS[(i + k) % YARD_MODELS.length]!;
          out.push(
            new Graphic({
              geometry: new Point({ longitude: bx, latitude: by, z: k * CONTAINER_H_M, spatialReference: { wkid: 4326 } }),
              attributes: {
                // Each tier is its own feature; only the base tier carries the
                // block pkey (the editor anchor) so a drag moves the block once.
                objectId: stableOid(`${pkey}:${k}`),
                ...(k === 0 ? { pkey } : {}),
                blockId: `${t.terminalId}-Y${i + 1}`,
                terminalId: t.terminalId,
                tier: k,
                fillPct,
                model,
                // Honour a rotation override on the block (all tiers share it).
                heading: placementStore.get(pkey)?.heading ?? QUAY_HEADING,
              },
            }),
          );
        }
      }
    }
  }
  return out;
}

export function yardStackLayer(terminals: Terminal[], pendency: PendencyDTO[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Yard stacks (pendency)',
    source: yardBlockGraphics(terminals, pendency) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'blockId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'tier', type: 'integer' },
      { name: 'fillPct', type: 'integer' },
      { name: 'model', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    // relative-to-ground so each tier's `z` lifts it into a real stack.
    elevationInfo: { mode: 'relative-to-ground' },
    renderer: {
      type: 'unique-value',
      field: 'model',
      uniqueValueInfos: YARD_MODELS.map((m) => ({
        value: m,
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'object',
              resource: { href: `${MODELS}/yard-container-${m}.glb` },
              height: CONTAINER_H_M,
              anchor: 'bottom',
            },
          ],
        },
      })),
      // Per-block heading so a rotated yard block keeps its orientation.
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: {
      title: 'Yard block {blockId}',
      content: 'Terminal: {terminalId}<br/>Fill: {fillPct}%',
    } as never,
  });
}

// ---------------------------------------------------------------------------
// STS gantry cranes — real quay-crane GLB (sts-crane.glb) on the waterline,
// booming out over the water. Positioned along the quay; count scales with quay
// length. The crane model's long footprint is on Z, so heading orients its boom
// toward the water.
//
// v3 — CRANE CLUSTERS. A working container berth runs 3–4 STS cranes side by side
// on ONE rail, not a single lonely gantry (see the JNPA reference imagery). So each
// surveyed ANCHOR crane (`crane:<T>:<i>`, positioned from data/positions.json)
// keeps its exact coordinate and heading, and 2–3 SIBLINGS are derived beside it
// along its own rail — the axis perpendicular to its boom, i.e. heading ± 90°,
// which is the quay line. Nothing else moves: terminals, ships, yards and gates
// are untouched.
//
// Non-overlap is budgeted, not guessed: a cluster may only spread within
// (nearestAnchorDistance / 2 − CRANE_BODY_M) of its anchor. Because BOTH
// neighbours obey the same bound, cranes of adjacent clusters always stay
// ≥ 2 × CRANE_BODY_M (≈18 m) apart, and cranes inside one cluster ≥
// CRANE_SPACING_MIN_M apart — both comfortably wider than the model's ~7.5 m
// along-rail footprint.
// ---------------------------------------------------------------------------

/**
 * Rendered along-rail footprint of sts-crane.glb: 1.6 native units × the
 * (68 m / 14.607 u) scale ≈ 7.5 m, rounded up so neighbours keep an air gap.
 */
const CRANE_BODY_M = 9;
/** Preferred centre-to-centre spacing of STS cranes working one berth (m). */
const CRANE_SPACING_PREF_M = 42;
/** Hard floor for in-cluster spacing (m) — still well clear of CRANE_BODY_M. */
const CRANE_SPACING_MIN_M = 15;
/** Room assumed around an anchor with no neighbouring crane at all (m). */
const CRANE_ISOLATED_NN_M = 400;

/** Derived crane count for a terminal — quay/200, clamped 3..9 (unchanged rule). */
function craneAnchorCount(t: Terminal): number {
  return Math.max(3, Math.min(9, Math.round((t.quayLengthM ?? 800) / 200)));
}

/** Metres between two lng/lat points in the local (JNPA-latitude) metric frame. */
function metresBetween(a: [number, number], b: [number, number]): number {
  return Math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT);
}

/**
 * Along-rail offsets (m) for one crane cluster. Element 0 is ALWAYS 0 — the
 * surveyed anchor never moves. `budgetM` is how far a sibling may sit from the
 * anchor without encroaching on the neighbouring cluster (see the header note).
 */
function craneClusterOffsets(pkey: string, budgetM: number): number[] {
  if (budgetM < CRANE_SPACING_MIN_M) return [0]; // no room — the anchor stands alone
  // 3 or 4 cranes per berth group, deterministic per anchor (stable replays).
  const want = rand01(pkey, 'clusterN') < 0.45 ? 3 : 4;
  if (want === 4) {
    // A 4th crane means two siblings stacked on one side (at d and 2d), so each
    // step may only use half the budget.
    const d = Math.min(CRANE_SPACING_PREF_M, budgetM / 2);
    if (d >= CRANE_SPACING_MIN_M) {
      // Flip which side carries the pair per anchor, so a berth line of clusters
      // doesn't read as the same stamp repeated.
      return rand01(pkey, 'clusterSide') < 0.5 ? [0, -d, d, 2 * d] : [0, d, -d, -2 * d];
    }
  }
  const d3 = Math.min(CRANE_SPACING_PREF_M, budgetM);
  return [0, -d3, d3];
}

/** One rendered crane: an anchor (`crane:<T>:<i>`) or a sibling (`…:<i>:<j>`). */
interface CranePlacement {
  pkey: string;
  terminalId: string;
  craneId: string;
  pos: [number, number];
  heading: number;
}

/**
 * Every crane in the scene, anchors AND cluster siblings, with its effective
 * (override-aware) position + heading. Single source of the cluster math, shared
 * by craneGraphics, pkeyPosition and the pick markers so they can never drift.
 */
export function cranePlacements(terminals: Terminal[]): CranePlacement[] {
  // 1. The surveyed anchors — position/heading rule unchanged from v2.
  const anchors: CranePlacement[] = [];
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const quay = t.quayLengthM ?? 800;
    const n = craneAnchorCount(t);
    for (let i = 0; i < n; i++) {
      const alongM = ((i + 0.5) / n - 0.5) * quay;
      const pkey = `crane:${t.terminalId}:${i}`;
      anchors.push({
        pkey,
        terminalId: t.terminalId,
        craneId: `${t.terminalId}-STS${i + 1}`,
        // Cranes stand ~30 m inland of the waterline so the boom reaches over ships.
        pos: withOverride(pkey, place(lng, lat, alongM, 30)),
        heading: placementStore.get(pkey)?.heading ?? QUAY_HEADING,
      });
    }
  }

  // 2. Grow each anchor into a 3–4 crane cluster along its own rail.
  const out: CranePlacement[] = [];
  for (const a of anchors) {
    let nn = CRANE_ISOLATED_NN_M;
    for (const b of anchors) {
      if (b === a) continue;
      const d = metresBetween(a.pos, b.pos);
      if (d < nn) nn = d;
    }
    const budgetM = Math.max(0, nn / 2 - CRANE_BODY_M);
    // The rail runs perpendicular to the boom: the model's boom points along
    // `heading`, so siblings step along heading + 90° (negative offsets = −90°).
    const railBrg = (a.heading + 90) % 360;
    craneClusterOffsets(a.pkey, budgetM).forEach((offM, j) => {
      if (j === 0) {
        out.push(a); // the anchor itself — exact surveyed position, untouched
        return;
      }
      const pkey = `${a.pkey}:${j}`;
      const derived = metreOffset(a.pos[0], a.pos[1], railBrg, offM);
      out.push({
        pkey,
        terminalId: a.terminalId,
        craneId: `${a.craneId}.${j}`,
        pos: withOverride(pkey, derived),
        // Siblings share their anchor's rail unless individually rotated.
        heading: placementStore.get(pkey)?.heading ?? a.heading,
      });
    });
  }
  return out;
}

function craneGraphics(terminals: Terminal[]): Graphic[] {
  return cranePlacements(terminals).map(
    (c) =>
      new Graphic({
        geometry: new Point({ longitude: c.pos[0], latitude: c.pos[1], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(c.pkey),
          pkey: c.pkey,
          craneId: c.craneId,
          terminalId: c.terminalId,
          heading: c.heading,
        },
      }),
  );
}

export function craneLayer(terminals: Terminal[]): FeatureLayer {
  // Real STS crane GLB. Native height ≈ 14.6u; scale to a ~68 m real STS crane.
  // The crane's boom footprint is along the model's Z; heading orients the whole
  // crane so its rail runs along the quay and the boom cantilevers seaward.
  return new FeatureLayer({
    title: '3D · STS cranes',
    source: craneGraphics(terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'craneId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          {
            type: 'object',
            resource: { href: `${MODELS}/sts-crane.glb` },
            height: 68,
            anchor: 'bottom',
          },
        ],
      },
      // Per-feature heading so a rotated crane keeps its dragged orientation.
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Crane {craneId}', content: 'Terminal: {terminalId}' } as never,
  });
}

// ---------------------------------------------------------------------------
// Vessels — real container-ship GLB berthed on the WATER side of each operating
// terminal, hull PARALLEL to the quay.
// ---------------------------------------------------------------------------

function vesselGraphics(terminals: Terminal[]): Graphic[] {
  return terminals
    .filter((t) => t.geom.type === 'Point' && t.status === 'OPERATING')
    .map((t, idx) => {
      const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
      const quay = t.quayLengthM ?? 800;
      // Berth alongside in open water, seaward of the quay edge (offset must
      // clear the landward bias so the hull sits on water, not the apron).
      const alongShift = (rand01(t.terminalId, 'berth') - 0.5) * quay * 0.25;
      const pkey = `vessel:${t.terminalId}`;
      const [bx, by] = withOverride(pkey, place(lng, lat, alongShift, -230));
      const loa = Math.min(quay * 0.9, 330);
      return new Graphic({
        geometry: new Point({ longitude: bx, latitude: by, spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(pkey),
          pkey,
          vesselId: `MV-JNPA-${idx + 1}`,
          terminalId: t.terminalId,
          loaM: Math.round(loa),
          hull: idx % 2 === 0 ? 'a' : 'b',
          heading: placementStore.get(pkey)?.heading ?? QUAY_HEADING + 90,
        },
      });
    });
}

export function vesselLayer(terminals: Terminal[]): FeatureLayer {
  // ship-cargo GLB long axis (Z=10.55u) → heading aligns it along the quay.
  return new FeatureLayer({
    title: '3D · Vessels',
    source: vesselGraphics(terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'vesselId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'loaM', type: 'double' },
      { name: 'hull', type: 'string' },
      { name: 'heading', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground', offset: 0 },
    renderer: {
      type: 'unique-value',
      field: 'hull',
      uniqueValueInfos: ['a', 'b'].map((h) => ({
        value: h,
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'object',
              resource: { href: `${MODELS}/ship-cargo-${h}.glb` },
              height: 40,
              anchor: 'bottom',
            },
          ],
        },
      })),
      // Per-vessel heading (model long axis is Z; default = quay bearing + 90).
      visualVariables: [{ type: 'rotation', field: 'heading' }],
    } as never,
    popupTemplate: { title: 'Vessel {vesselId}', content: 'Berthed at {terminalId}<br/>LOA: {loaM} m' } as never,
  });
}

// ---------------------------------------------------------------------------
// Gates — real gate GLB landward of the yard, coloured/scaled by live queue.
// A short truck queue (delivery GLBs) trails inland from each gate.
// ---------------------------------------------------------------------------

/** Gate positions: landward of the yards, on the port access road. Honours a
 *  drag override on the gate so its truck queue + highlight halo follow it. */
function gatePosition(t: Terminal, gateIndex: number): [number, number] {
  const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
  const quay = t.quayLengthM ?? 800;
  const alongM = (gateIndex - (t.gates.length - 1) / 2) * (quay / Math.max(1, t.gates.length));
  const gateId = t.gates[gateIndex];
  return withOverride(`gate3d:${gateId}`, place(lng, lat, alongM, 470)); // inland, access road
}

// ---- IN / OUT gate designation ---------------------------------------------
// A truck ENTERS the port driving seaward (from the inland access road toward the
// quay), i.e. along the SEAWARD bearing (≈298°). Per the JNPA gate convention the
// IN lanes sit to the RIGHT of that travel direction and the OUT lanes to the
// LEFT. Right of 298° is bearing ≈028°, which is the NEGATIVE end of the
// along-quay axis (that axis points at 208°) — so of a terminal's gates, the one
// with the SMALLEST along-quay coordinate is the IN gate and the largest is OUT.
//
// This is a geometric designation of the gates that already exist: it reads their
// committed (override-aware) positions and assigns identity. It never moves a
// gate — the placements in data/positions.json stay exactly as surveyed.

/** IN = entering the port · OUT = leaving · BOTH = a single bidirectional gate. */
export type GateRole = 'IN' | 'OUT' | 'BOTH';

/** Along-quay coordinate (m) of a point, relative to a terminal centroid. */
function alongOf(t: Terminal, p: [number, number]): number {
  const [clng, clat] = (t.geom as { coordinates: [number, number] }).coordinates;
  const e = (p[0] - clng) * M_PER_DEG_LON;
  const n = (p[1] - clat) * M_PER_DEG_LAT;
  return e * alongE + n * alongN;
}

/**
 * gateId → IN / OUT / BOTH for every gate, derived from the gates' effective
 * positions (see the note above). A terminal with one gate is bidirectional;
 * with two, the right-hand one is IN and the left-hand one OUT; with three or
 * more, the extreme right is IN, the extreme left is OUT and any gate between
 * them handles both directions (a JNPA-style multi-lane gate complex).
 */
export function gateRoles(terminals: Terminal[]): Map<string, GateRole> {
  const roles = new Map<string, GateRole>();
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const ranked = t.gates
      .map((gateId, i) => ({ gateId, along: alongOf(t, gatePosition(t, i)) }))
      .sort((a, b) => a.along - b.along); // smallest along = right of inbound travel
    if (ranked.length === 1) {
      roles.set(ranked[0]!.gateId, 'BOTH');
      continue;
    }
    ranked.forEach((g, i) => {
      roles.set(g.gateId, i === 0 ? 'IN' : i === ranked.length - 1 ? 'OUT' : 'BOTH');
    });
  }
  return roles;
}

/**
 * Resolve the CURRENT effective position of a movable asset by placement key —
 * the override if one exists, else the DERIVED quay-frame position. Single source
 * of the derive math for the transform panel (rotate/nudge need a base point for
 * a first-time edit). Returns null for an unknown/unmatched pkey.
 *
 * pkey formats: `vessel:<T>` · `crane:<T>:<i>` (anchor) · `crane:<T>:<i>:<j>`
 * (cluster sibling) · `yard:<T>:<i>` · `gate3d:<GATEID>` · `truckroute:<T>` ·
 * `rake:<siding>` · `tug` (the live-mover anchors).
 */
export function pkeyPosition(pkey: string, terminals: Terminal[]): [number, number] | null {
  const override = placementStore.get(pkey);
  if (override) return [override.lng, override.lat];
  const [kind, a, b] = pkey.split(':');
  const opTerminals = terminals.filter((t) => t.geom.type === 'Point');
  const byId = new Map(opTerminals.map((t) => [t.terminalId, t] as const));
  const centroid = (t: Terminal) => (t.geom as { coordinates: [number, number] }).coordinates;

  // ---- live-mover anchors (must match sceneAnim.ts default anchors exactly) ----
  if (kind === 'truckroute') {
    const t = byId.get(a ?? '');
    if (!t) return null;
    const [lng, lat] = centroid(t);
    return place(lng, lat, 0, 620); // gate-approach point
  }
  if (kind === 'rake') {
    const t1 = opTerminals[0];
    if (!t1) return null;
    const [lng, lat] = centroid(t1);
    return place(lng, lat, 400, 700); // rail line inland
  }
  if (kind === 'tug') {
    const t = opTerminals.find((x) => x.status === 'OPERATING') ?? opTerminals[0];
    if (!t) return null;
    const [lng, lat] = centroid(t);
    return place(lng, lat, 0, -520); // out in the channel
  }

  if (kind === 'vessel') {
    const t = byId.get(a ?? '');
    if (!t) return null;
    const [lng, lat] = centroid(t);
    const quay = t.quayLengthM ?? 800;
    const alongShift = (rand01(t.terminalId, 'berth') - 0.5) * quay * 0.25;
    return place(lng, lat, alongShift, -230);
  }
  if (kind === 'crane') {
    // Anchors AND cluster siblings (`crane:<T>:<i>:<j>`) resolve through the same
    // cluster builder, so a sibling's derived position matches what is rendered.
    return cranePlacements(terminals).find((c) => c.pkey === pkey)?.pos ?? null;
  }
  if (kind === 'yard') {
    const t = byId.get(a ?? '');
    if (!t) return null;
    const [lng, lat] = centroid(t);
    const quay = t.quayLengthM ?? 800;
    const i = Number(b) || 0;
    const r = Math.floor(i / YARD_COLS);
    const c = i % YARD_COLS;
    const alongM = (c - (YARD_COLS - 1) / 2) * (quay / YARD_COLS);
    const offsetM = 230 + r * 70;
    return place(lng, lat, alongM, offsetM);
  }
  if (kind === 'gate3d') {
    const gateId = pkey.slice('gate3d:'.length);
    for (const t of terminals) {
      if (t.geom.type !== 'Point') continue;
      const gi = t.gates.indexOf(gateId);
      if (gi >= 0) return gatePosition(t, gi);
    }
  }
  return null;
}

/** Current heading (deg) for a movable pkey — the override's, else the quay default. */
export function pkeyHeading(pkey: string): number {
  const o = placementStore.get(pkey);
  if (o?.heading != null) return o.heading;
  // Vessels default to quay bearing + 90 (hull along the quay).
  if (pkey.startsWith('vessel:')) return (QUAY_HEADING + 90) % 360;
  // A crane cluster sibling (`crane:<T>:<i>:<j>`) shares its anchor's rail.
  const craneParts = pkey.startsWith('crane:') ? pkey.split(':') : [];
  if (craneParts.length === 4) {
    return placementStore.get(craneParts.slice(0, 3).join(':'))?.heading ?? QUAY_HEADING;
  }
  // Live-mover anchors (route / rake / tug) run along the raw quay BEARING.
  if (pkey.startsWith('truckroute:') || pkey.startsWith('rake:') || pkey === 'tug') return QUAY_BEARING_DEG;
  return QUAY_HEADING;
}

function gate3dGraphics(gateOps: GateOpsDTO[], terminals: Terminal[]): Graphic[] {
  const byTerminal = new Map(terminals.map((t) => [t.terminalId, t] as const));
  const gateToPos = new Map<string, [number, number]>();
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    t.gates.forEach((g, i) => gateToPos.set(g, gatePosition(t, i)));
  }
  const roles = gateRoles(terminals);
  return gateOps
    .filter((g) => gateToPos.has(g.gateId) && byTerminal.has(g.terminalId))
    .map((g) => {
      const [lng, lat] = gateToPos.get(g.gateId)!;
      const role = roles.get(g.gateId) ?? 'BOTH';
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`gate3d:${g.gateId}`),
          pkey: `gate3d:${g.gateId}`,
          gateId: g.gateId,
          terminalId: g.terminalId,
          queueLength: g.queueLength,
          avgTxnTimeMin: g.avgTxnTimeMin,
          // IN / OUT / BOTH — the direction this gate handles (see gateRoles).
          // Labelled in 3D so the entry and exit sides read at a glance.
          role,
          roleLabel: role === 'BOTH' ? `${g.gateId} · IN/OUT` : `${g.gateId} · ${role} GATE`,
          // Rotation DELTA from the composite gate's default orientation, so a
          // rotation override spins both the boom and canopy together. 0 = default.
          headingDelta: (placementStore.get(`gate3d:${g.gateId}`)?.heading ?? QUAY_HEADING) - QUAY_HEADING,
        },
      });
    });
}

export function gate3dLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Gates',
    source: gate3dGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'gateId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'queueLength', type: 'integer' },
      { name: 'avgTxnTimeMin', type: 'double' },
      { name: 'role', type: 'string' },
      { name: 'roleLabel', type: 'string' },
      { name: 'headingDelta', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      // Composite toll-naka gate-house, modelled on the reference cockpit's gate:
      // a realistic gate gantry/booth (gate-realistic.glb) as the toll-naka structure,
      // a wide flat CANOPY roof spanning the lanes, and a red BOOM barrier model across
      // the road. Multiple symbolLayers render as one gate at the gate point; together
      // they read instantly as a toll naka / checkpoint. Canopy stays queue-coloured.
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          // Indian toll-naka model (procedurally generated, own geometry): a green arched
          // canopy spanning the road on blue pillars, with grey booths and red boom
          // barriers baked in, so trucks pass UNDER the canopy. Sized to ~35 m span.
          { type: 'object', resource: { href: `${MODELS}/toll-naka.glb` }, heading: QUAY_HEADING, height: 9, anchor: 'bottom' },
          // Compact queue-coloured apron pad (the live congestion cue — the ONLY layer the
          // queueLength colour visualVariable tints; the toll-naka GLB keeps its own colours).
          { type: 'object', resource: { primitive: 'cube' }, width: 12, depth: 6, height: 0.5, material: { color: [230, 233, 235] }, anchor: 'bottom', heading: QUAY_HEADING },
        ],
      },
      visualVariables: [
        // The canopy reddens with the live gate queue (green→amber→red).
        {
          type: 'color',
          field: 'queueLength',
          stops: [
            { value: 0, color: tokens.congestion.GREEN },
            { value: 8, color: tokens.congestion.AMBER },
            { value: 16, color: tokens.congestion.RED },
          ],
        },
        // Rotate the whole gate (boom + canopy) by the override delta.
        { type: 'rotation', field: 'headingDelta' },
      ],
    } as never,
    // "NSICT-G2 · IN GATE" floating over each toll naka, so the entry side and the
    // exit side of every terminal read at a glance (green for IN, amber for OUT).
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.roleLabel' },
        symbol: {
          type: 'label-3d',
          symbolLayers: [
            {
              type: 'text',
              material: { color: tokens.color.text },
              halo: { color: tokens.color.bgPanel, size: 1.5 },
              size: 11,
              font: { weight: 'bold' },
            },
          ],
          // Lift the text clear of the ~9 m toll canopy.
          verticalOffset: { screenLength: 34, maxWorldLength: 90, minWorldLength: 14 },
          callout: { type: 'line', size: 1, color: tokens.color.border },
        },
      },
    ] as never,
    popupTemplate: {
      title: 'Gate {gateId}',
      content: 'Terminal: {terminalId}<br/>Direction: {role}<br/>Queue: {queueLength}<br/>Avg txn: {avgTxnTimeMin} min',
    } as never,
  });
}

// ---------------------------------------------------------------------------
// CCTV surveillance towers — a procedural multi-camera pole beside each toll
// plaza (gate3d), modelled on the reference photo: a tall light-grey mast with a
// dark mounting hub near the top and THREE silver "bullet" cameras on short
// brackets, each capped with a dark lens hood and fanned ~120° apart. No CCTV GLB
// ships with the app, so it is assembled from the same object PRIMITIVES the
// scene already uses (cylinders/cube/sphere, like the crane hoist box). It is
// anchored off the SAME (override-aware) gate position via offsetFrom, on the
// approach-road shoulder clear of the lanes. Decorative only: a plain GraphicsLayer
// with no pkey/sim/data coupling, so the placement editor and overlays ignore it.
// ---------------------------------------------------------------------------
const CCTV_MAST_H = 8.5; // m — mast height
const CCTV_MAST_D = 0.9; // m — mast diameter
// Beside the toll: +alongM sits just outside the ~35 m lane span; +offsetM is
// landward, onto the approach-road shoulder (before the lanes), never in traffic.
const CCTV_FLANK_ALONG_M = 22;
const CCTV_FLANK_OFFSET_M = 18;
const CCTV_MAST_GREY = [178, 183, 188];
const CCTV_METAL_DARK = [38, 41, 45];
const CCTV_CAM_SILVER = [206, 210, 214];

/** A point-3d symbol for one object primitive, sized in metres and oriented. */
function cctvPrim(
  primitive: 'cylinder' | 'cube' | 'sphere',
  w: number, d: number, h: number,
  color: number[], anchor: 'bottom' | 'center', heading: number, tilt?: number,
) {
  return {
    type: 'point-3d',
    symbolLayers: [
      { type: 'object', resource: { primitive }, width: w, depth: d, height: h, material: { color }, anchor, heading, ...(tilt != null ? { tilt } : {}) },
    ],
  } as never;
}

/** Offset a point by `distM` metres along compass bearing `brgDeg`. */
function metreOffset(lng: number, lat: number, brgDeg: number, distM: number): [number, number] {
  const r = (brgDeg * Math.PI) / 180;
  return [lng + dLon(Math.sin(r) * distM), lat + dLat(Math.cos(r) * distM)];
}

/** Build every part-graphic of one CCTV tower standing at (lng,lat), fanning the
 *  camera cluster around `heading` (the toll's orientation). */
function cctvTowerGraphics(lng: number, lat: number, heading: number, gateId: string): Graphic[] {
  const parts: Graphic[] = [];
  let n = 0;
  const add = (l: number, la: number, z: number, symbol: unknown) =>
    parts.push(new Graphic({
      geometry: new Point({ longitude: l, latitude: la, z, spatialReference: { wkid: 4326 } }),
      symbol: symbol as never,
      attributes: { objectId: stableOid(`cctv:${gateId}:${n++}`), gateId },
    }));

  // One realistic bullet camera pointing outward along compass bearing `brg`,
  // mounted at height `z`. Composed of a mount arm + U-clamp, a rear cap, a silver
  // barrel, an overhanging sun-shield visor, a front lens hood, and a glass lens —
  // all laid along `brg` (cylinders use tilt 90 to lie horizontal along it).
  const bulletCamera = (brg: number, z: number) => {
    const p = (distM: number) => metreOffset(lng, lat, brg, distM);
    // Tubular mount arm from the hub out to the camera's underside.
    const [arml, arma] = p(0.7);
    add(arml, arma, z - 0.06, cctvPrim('cylinder', 0.15, 0.15, 0.9, CCTV_METAL_DARK, 'center', brg, 90));
    // U-mount clamp bracket under the barrel.
    const [ul, ula] = p(1.32);
    add(ul, ula, z - 0.33, cctvPrim('cube', 0.26, 0.34, 0.52, CCTV_METAL_DARK, 'center', brg));
    // Dark rear cap (back of the camera).
    const [rl, rla] = p(1.12);
    add(rl, rla, z, cctvPrim('cylinder', 0.6, 0.6, 0.16, CCTV_METAL_DARK, 'center', brg, 90));
    // Silver barrel — the main camera body.
    const [bl, bla] = p(1.78);
    add(bl, bla, z, cctvPrim('cylinder', 0.56, 0.56, 1.3, CCTV_CAM_SILVER, 'center', brg, 90));
    // Sun-shield visor on top, overhanging the lens (the signature bullet-cam hood).
    const [vl, vla] = p(2.0);
    add(vl, vla, z + 0.33, cctvPrim('cube', 0.64, 1.75, 0.1, CCTV_METAL_DARK, 'center', brg));
    // Front lens hood — a slightly wider dark ring at the barrel mouth.
    const [fl, fla] = p(2.42);
    add(fl, fla, z, cctvPrim('cylinder', 0.64, 0.64, 0.34, CCTV_METAL_DARK, 'center', brg, 90));
    // Glass lens — a dark disc set in the hood.
    const [gl, gla] = p(2.58);
    add(gl, gla, z, cctvPrim('sphere', 0.42, 0.42, 0.3, [18, 20, 24], 'center', brg));
  };

  // Mast — tall light-grey pole (base seated on the ground).
  add(lng, lat, 0, cctvPrim('cylinder', CCTV_MAST_D, CCTV_MAST_D, CCTV_MAST_H, CCTV_MAST_GREY, 'bottom', heading));
  // Rounded dark cap on the pole top.
  add(lng, lat, CCTV_MAST_H, cctvPrim('sphere', CCTV_MAST_D * 1.05, CCTV_MAST_D * 1.05, CCTV_MAST_D * 0.7, CCTV_METAL_DARK, 'center', heading));
  // Dark spherical mounting hub near the top, where the camera arms meet.
  const hubZ = CCTV_MAST_H - 1.2;
  add(lng, lat, hubZ, cctvPrim('sphere', 1.05, 1.05, 1.0, CCTV_METAL_DARK, 'center', heading));

  // Three bullet cameras fanned 120° apart around the hub, pointing outward.
  const camZ = hubZ + 0.1;
  for (let i = 0; i < 3; i++) bulletCamera((heading + 40 + i * 120) % 360, camZ);
  return parts;
}

export function cctvLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): GraphicsLayer {
  // relative-to-ground honours each part's z (mast base z=0 sits on the ground;
  // the hub/cameras float near the mast top).
  const layer = new GraphicsLayer({ title: '3D · CCTV towers', elevationInfo: { mode: 'relative-to-ground' } });
  const byTerminal = new Map(terminals.map((t) => [t.terminalId, t] as const));
  const gateToPos = new Map<string, [number, number]>();
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    t.gates.forEach((g, i) => gateToPos.set(g, gatePosition(t, i)));
  }
  for (const g of gateOps) {
    if (!gateToPos.has(g.gateId) || !byTerminal.has(g.terminalId)) continue;
    const [glng, glat] = gateToPos.get(g.gateId)!;
    // One tower beside the toll approach (shoulder, clear of the lanes).
    const [lng, lat] = offsetFrom(glng, glat, CCTV_FLANK_ALONG_M, CCTV_FLANK_OFFSET_M);
    // Fan the cameras around the toll's own orientation (override-aware).
    const heading = placementStore.get(`gate3d:${g.gateId}`)?.heading ?? QUAY_HEADING;
    for (const part of cctvTowerGraphics(lng, lat, heading, g.gateId)) layer.add(part);
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Quay-apron cargo — decorative container stacks and box piles on the concrete
// between the crane rail and the container yards, which on the JNPA imagery is
// never bare: it is where boxes land off the ship before the straddle carriers
// take them inland. It uses the CC0 cargo GLBs that already ship with the app
// (cargo-pile-a/b, cargo-container-a/b/c) and were previously unreferenced.
//
// Everything is DERIVED from the crane cluster, so it can never drift: a stack
// goes in the middle of the gap between two neighbouring cranes of the same
// cluster, set back on the apron. Gaps narrower than APRON_MIN_GAP_M are skipped,
// which keeps every stack at least that far from the next one. Like the CCTV
// towers this is a plain decorative GraphicsLayer — no pkey, no sim coupling, so
// the placement editor and the in-place data diff never touch it.
// ---------------------------------------------------------------------------

/** Skip gaps tighter than this (m) so two stacks can never touch. */
const APRON_MIN_GAP_M = 20;
/** The two apron rows, in metres landward of the crane rail. */
const APRON_ROWS_M = [46, 68];
/** Cargo models cycled across the apron, with the height (m) each renders at. */
const APRON_CARGO = [
  { model: 'cargo-pile-a', height: 5 },
  { model: 'cargo-container-a', height: 3.2 },
  { model: 'cargo-pile-b', height: 5 },
  { model: 'cargo-container-b', height: 3.2 },
  { model: 'cargo-container-c', height: 3.2 },
] as const;

export function apronCargoLayer(terminals: Terminal[]): GraphicsLayer {
  const layer = new GraphicsLayer({ title: '3D · Quay apron cargo', elevationInfo: { mode: 'on-the-ground' } });
  // Group the cranes back into their clusters so we only bridge gaps on one rail.
  const clusters = new Map<string, CranePlacement[]>();
  for (const c of cranePlacements(terminals)) {
    const anchor = c.pkey.split(':').slice(0, 3).join(':');
    clusters.set(anchor, [...(clusters.get(anchor) ?? []), c]);
  }
  let seq = 0;
  for (const [anchorKey, members] of clusters) {
    const anchor = members[0]!;
    // Order the cluster along its own rail, then take each consecutive pair.
    const railBrg = (anchor.heading + 90) % 360;
    const rad = (railBrg * Math.PI) / 180;
    const railE = Math.sin(rad);
    const railN = Math.cos(rad);
    const along = (c: CranePlacement) =>
      (c.pos[0] - anchor.pos[0]) * M_PER_DEG_LON * railE + (c.pos[1] - anchor.pos[1]) * M_PER_DEG_LAT * railN;
    const ordered = [...members].sort((a, b) => along(a) - along(b));
    for (let i = 0; i < ordered.length - 1; i++) {
      const gapM = along(ordered[i + 1]!) - along(ordered[i]!);
      if (gapM < APRON_MIN_GAP_M) continue;
      const mid: [number, number] = [
        (ordered[i]!.pos[0] + ordered[i + 1]!.pos[0]) / 2,
        (ordered[i]!.pos[1] + ordered[i + 1]!.pos[1]) / 2,
      ];
      const key = `${anchorKey}:apron${i}`;
      const row = APRON_ROWS_M[Math.floor(rand01(key, 'row') * APRON_ROWS_M.length) % APRON_ROWS_M.length]!;
      const cargo = APRON_CARGO[Math.floor(rand01(key, 'model') * APRON_CARGO.length) % APRON_CARGO.length]!;
      const [lng, lat] = offsetFrom(mid[0], mid[1], 0, row);
      layer.add(
        new Graphic({
          geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
          // Boxes lie square to the quay, like the yard stacks; a small yaw wobble
          // keeps the apron from reading as a stamped-out row.
          symbol: {
            type: 'point-3d',
            symbolLayers: [
              {
                type: 'object',
                resource: { href: `${MODELS}/${cargo.model}.glb` },
                height: cargo.height,
                anchor: 'bottom',
                heading: (anchor.heading + (rand01(key, 'yaw') - 0.5) * 10 + 360) % 360,
              },
            ],
          } as never,
          attributes: { objectId: stableOid(`apron:${seq++}`), terminalId: anchor.terminalId, cargo: cargo.model },
        }),
      );
    }
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Trucks — a queue of real truck GLBs trailing inland from each gate along the
// access road; the queue LENGTH is the live gate queue (capped for perf). This
// keeps moving/waiting vehicles on the port road, not scattered on the water.
//
// The queue is a few PARALLEL LANES, not one long single file, which is both how
// a JNPA gate complex actually queues and what keeps the vehicles clear of each
// other and of the gate structure. All three pitches below are derived from the
// RENDERED sizes rather than eyeballed: the container-truck GLB is ~23 m long ×
// 4.4 m wide at its 8 m symbol height, and the toll-naka canopy spans 36 m across
// the road × 14 m deep (so ±7 m of the gate point). Previously the queue stepped
// 14 m per truck from only 10 m out, i.e. 23 m vehicles overlapped each other and
// the first one stood inside the canopy.
// ---------------------------------------------------------------------------

const MAX_TRUCKS_PER_GATE = 12;
/** Parallel approach lanes at a gate (12 queued trucks → 3 × 4 deep). */
const TRUCK_QUEUE_LANES = 3;
/** Lane-to-lane spacing (m), lateral; stays well inside the 36 m canopy span. */
const TRUCK_LANE_PITCH_M = 7;
/** Distance (m) the first row stops landward of the gate — clear of the canopy. */
const TRUCK_QUEUE_STANDOFF_M = 22;
/** Row-to-row spacing (m) — wider than the longest vehicle, so no interpenetration. */
const TRUCK_QUEUE_PITCH_M = 26;

function truckGraphics(gateOps: GateOpsDTO[], terminals: Terminal[]): Graphic[] {
  const out: Graphic[] = [];
  const tById = new Map(terminals.map((t) => [t.terminalId, t] as const));
  const roles = gateRoles(terminals);
  for (const g of gateOps) {
    const t = tById.get(g.terminalId);
    if (!t || t.geom.type !== 'Point') continue;
    const gi = t.gates.indexOf(g.gateId);
    if (gi < 0) continue;
    // Anchor the queue at the gate's ACTUAL position (honours a drag override),
    // then trail trucks inland from there so they follow a repositioned gate.
    const [glng, glat] = gatePosition(t, gi);
    // At an OUT gate the traffic is leaving the port, so those vehicles face the
    // opposite way to the ones waiting to come IN (a 180° delta on the shared
    // base heading — the base orientation of IN/BOTH queues is unchanged).
    const headingDelta = roles.get(g.gateId) === 'OUT' ? 180 : 0;
    const nTrucks = Math.min(MAX_TRUCKS_PER_GATE, g.queueLength);
    for (let k = 0; k < nTrucks; k++) {
      // Lane-major fill: lanes side by side across the road, rows back from the
      // gate. Same quay frame as the gate (no bias — glng/glat already include it).
      const lane = k % TRUCK_QUEUE_LANES;
      const row = Math.floor(k / TRUCK_QUEUE_LANES);
      const lateralM = (lane - (TRUCK_QUEUE_LANES - 1) / 2) * TRUCK_LANE_PITCH_M;
      // A little slop in the stop line so the rows don't read as a rigid grid.
      const slopM = (rand01(g.gateId, `slop${k}`) - 0.5) * 4;
      const landwardM = TRUCK_QUEUE_STANDOFF_M + row * TRUCK_QUEUE_PITCH_M + slopM;
      const [lng, lat] = offsetFrom(glng, glat, lateralM, landwardM);
      out.push(
        new Graphic({
          geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
          attributes: {
            objectId: stableOid(`truck:${g.gateId}:${k}`),
            gateId: g.gateId,
            // Two vehicle types: the heavy truck (truck-realistic) is unchanged; only the
            // former light-pickup slot now uses the blue container truck. Queue
            // count/behaviour unchanged.
            model: k % 3 === 0 ? 'container-truck' : 'truck-realistic',
            headingDelta,
          },
        }),
      );
    }
  }
  return out;
}

export function truckLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Trucks (gate queues)',
    source: truckGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'gateId', type: 'string' },
      { name: 'model', type: 'string' },
      { name: 'headingDelta', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'unique-value',
      field: 'model',
      uniqueValueInfos: [
        { model: 'truck-realistic', h: 8 },
        { model: 'container-truck', h: 8 },
      ].map(({ model, h }) => ({
        value: model,
        symbol: {
          type: 'point-3d',
          // Realistic Quaternius models: turned to face along the access road
          // (QUAY_HEADING + 180 — a 90° turn from the previous +90 orientation).
          symbolLayers: [
            { type: 'object', resource: { href: `${MODELS}/${model}.glb` }, heading: (QUAY_HEADING + 180) % 360, height: h, anchor: 'bottom' },
          ],
        },
      })),
      // Adds to the symbol heading above: 0 for the IN queues (base orientation
      // unchanged), 180 at an OUT gate so departing traffic faces the other way.
      visualVariables: [{ type: 'rotation', field: 'headingDelta' }],
    } as never,
    popupTemplate: { title: 'Truck at {gateId}', content: 'Waiting in the gate queue.' } as never,
  });
}

// ---------------------------------------------------------------------------
// Congestion heatmap — a translucent apron patch over each gate's access road
// that reddens and rises as the live gate queue grows (the flat-map "congestion
// heatmap" made legible in 3D). Purely a colour/height read on live queue data.
// ---------------------------------------------------------------------------

function congestionGraphics(gateOps: GateOpsDTO[], terminals: Terminal[]): Graphic[] {
  const tById = new Map(terminals.map((t) => [t.terminalId, t] as const));
  const out: Graphic[] = [];
  for (const g of gateOps) {
    const t = tById.get(g.terminalId);
    if (!t || t.geom.type !== 'Point') continue;
    const gi = t.gates.indexOf(g.gateId);
    if (gi < 0) continue;
    const [glng, glat] = gatePosition(t, gi);
    // A ~120 m × 135 m patch on the road just inland of the gate, where trucks
    // queue. Build its ring by offsetting the gate point in the quay frame. The
    // landward edge reaches past the deepest queue row (STANDOFF + 3 × PITCH =
    // 100 m) so the heatmap actually sits under the whole queue, not half of it.
    const c0 = offsetFrom(glng, glat, -60, -25);
    const ring = [c0, offsetFrom(glng, glat, 60, -25), offsetFrom(glng, glat, 60, 110), offsetFrom(glng, glat, -60, 110), c0];
    out.push(
      new Graphic({
        geometry: new Polygon({ rings: [ring], spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`cong:${g.gateId}`),
          gateId: g.gateId,
          terminalId: g.terminalId,
          queueLength: g.queueLength,
        },
      }),
    );
  }
  return out;
}

export function congestionLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Congestion heatmap',
    source: congestionGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polygon',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'gateId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'queueLength', type: 'integer' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [{ type: 'extrude', size: 2, material: { color: [45, 187, 106, 0.25] } }],
      },
      visualVariables: [
        // Reddens with queue…
        {
          type: 'color',
          field: 'queueLength',
          stops: [
            { value: 2, color: [45, 187, 106, 0.18] },
            { value: 9, color: [242, 169, 59, 0.32] },
            { value: 16, color: [224, 69, 69, 0.45] },
          ],
        },
        // …and rises so a congested gate is visible even from a shallow angle.
        { type: 'size', field: 'queueLength', axis: 'height', valueUnit: 'meters', stops: [
          { value: 2, size: 1 }, { value: 16, size: 10 },
        ] },
      ],
    } as never,
    popupTemplate: { title: 'Gate congestion {gateId}', content: 'Queue: {queueLength} trucks' } as never,
  });
}

// ---------------------------------------------------------------------------
// Navigation channel + a tug on the water, seaward of the quays.
// ---------------------------------------------------------------------------

function channelGraphics(terminals: Terminal[]): Graphic[] {
  const pts = terminals
    .filter((t) => t.geom.type === 'Point')
    .map((t) => (t.geom as { coordinates: [number, number] }).coordinates);
  if (pts.length < 2) return [];
  // Channel ~600 m seaward of each quay centroid, following the wharf line —
  // out in open water so it marks the approach lane without crossing the berths.
  const path = pts.map(([lng, lat]) => place(lng, lat, 0, -600));
  return [
    new Graphic({
      geometry: new Polyline({ paths: [path], spatialReference: { wkid: 4326 } }),
      attributes: { objectId: 1, name: 'Approach channel' },
    }),
  ];
}

export function channelLayer(terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Channel',
    source: channelGraphics(terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'name', type: 'string' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'line-3d',
        symbolLayers: [
          // A subtle dashed lane marker rather than a solid painted road.
          { type: 'line', size: 4, material: { color: [26, 115, 194, 0.5] }, cap: 'round', pattern: { type: 'style', style: 'dash' } },
        ],
      },
    } as never,
    popupTemplate: { title: '{name}', content: 'JNPA approach channel (Thane Creek)' } as never,
  });
}

// ---------------------------------------------------------------------------
// Spotlight halo — translucent beam around simulator-driven assets (3D twin of
// the flat highlight layer). Positions resolved by the SAME quay-frame rules so
// halos sit exactly over the real 3D asset.
// ---------------------------------------------------------------------------

export function asset3dPosition(facilities: Facility[], terminals: Terminal[]): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>();
  for (const f of facilities) {
    if (f.geom.type === 'Point') pos.set(f.facilityId, (f.geom as { coordinates: [number, number] }).coordinates);
  }
  const opTerminals = terminals.filter((t) => t.geom.type === 'Point');
  for (const t of opTerminals) {
    const c = (t.geom as { coordinates: [number, number] }).coordinates;
    pos.set(t.terminalId, c);
    t.gates.forEach((g, i) => pos.set(g, gatePosition(t, i)));
    // Live-mover anchors, so the tree can focus the camera on them.
    const rt = pkeyPosition(`truckroute:${t.terminalId}`, terminals);
    if (rt) pos.set(`route:${t.terminalId}`, rt);
  }
  // Rail rake + tug anchors + the approach-channel midpoint (reference focus).
  const rake = pkeyPosition('rake:T1', terminals);
  if (rake) pos.set('rake:T1', rake);
  const tug = pkeyPosition('tug', terminals);
  if (tug) pos.set('tug', tug);
  const t0 = opTerminals[0];
  if (t0) {
    const c = (t0.geom as { coordinates: [number, number] }).coordinates;
    pos.set('channel', place(c[0], c[1], 0, -600)); // channel line, seaward
  }
  return pos;
}

export function spotlight3dGraphics(
  assetIds: string[],
  facilities: Facility[],
  terminals: Terminal[],
  valueOf?: (id: string) => string | undefined,
): Graphic[] {
  const pos = asset3dPosition(facilities, terminals);
  return assetIds
    .filter((id) => pos.has(id))
    .map((id) => {
      const [lng, lat] = pos.get(id)!;
      const v = valueOf?.(id);
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
        attributes: { objectId: stableOid(`hl3d:${id}`), assetId: id, label: v ? `${id} · ${v}` : id },
      });
    });
}

export function spotlight3dLayer(assetIds: string[], facilities: Facility[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Live (simulated)',
    source: spotlight3dGraphics(assetIds, facilities, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'assetId', type: 'string' },
      { name: 'label', type: 'string' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          { type: 'object', resource: { primitive: 'cylinder' }, width: 70, depth: 70, height: 110, material: { color: [26, 115, 194, 0.16] }, anchor: 'bottom' },
        ],
      },
    } as never,
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.label' },
        symbol: {
          type: 'label-3d',
          symbolLayers: [{ type: 'text', material: { color: tokens.color.brand }, halo: { color: tokens.color.bgPanel, size: 1.5 }, size: 12, font: { weight: 'bold' } }],
        },
      },
    ] as never,
    popupTemplate: { title: 'Live: {assetId}', content: 'Driven by the simulator.' } as never,
  });
}

// ---- transient selection ring ---------------------------------------------

export function selectionLayer(): GraphicsLayer {
  return new GraphicsLayer({ title: '3D · Selection', listMode: 'hide' });
}

// ---- route-draw preview (tracing a truck route on the imagery) --------------

/** A GraphicsLayer for previewing the route being traced (line + waypoint dots). */
export function routeDrawLayer(): GraphicsLayer {
  return new GraphicsLayer({ title: '3D · Route (draw)', listMode: 'hide', elevationInfo: { mode: 'on-the-ground' } });
}

/**
 * Build the preview graphics for a traced route: a bright dashed polyline through
 * the clicked waypoints (closed back to the start, since trucks loop it) plus a
 * numbered dot at each waypoint. Rebuilt on every click while drawing.
 */
export function routeDrawGraphics(path: [number, number][]): Graphic[] {
  if (path.length === 0) return [];
  const out: Graphic[] = [];
  if (path.length >= 2) {
    const ring = [...path, path[0]!]; // close the loop like the trucks drive it
    out.push(
      new Graphic({
        geometry: new Polyline({ paths: [ring.map((p) => [p[0], p[1]])], spatialReference: { wkid: 4326 } }),
        symbol: {
          type: 'line-3d',
          symbolLayers: [{ type: 'line', size: 3, material: { color: tokens.color.brand }, cap: 'round', pattern: { type: 'style', style: 'dash' } }],
        } as never,
      }),
    );
  }
  path.forEach(([lng, lat], i) => {
    out.push(
      new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            { type: 'object', resource: { primitive: 'cylinder' }, width: 10, depth: 10, height: 3, material: { color: i === 0 ? [46, 187, 106, 1] : [26, 115, 194, 0.95] }, anchor: 'bottom' },
          ],
        } as never,
        attributes: { seq: i + 1 },
      }),
    );
  });
  return out;
}

export function selectionRing(lng: number, lat: number): Graphic {
  return new Graphic({
    geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        { type: 'object', resource: { primitive: 'cylinder' }, width: 90, depth: 90, height: 6, material: { color: [242, 169, 59, 0.9] }, anchor: 'bottom' },
      ],
    } as never,
  });
}

// ---- pick markers (reliable click targets over the glTF models) ------------
// ArcGIS SceneView.hitTest() is unreliable at picking glTF `object` symbols, so
// each movable asset also gets a small flat pick MARKER sitting exactly on it,
// carrying the same {id, pkey} attributes resolveHit() reads. hitTest picks these
// simple markers reliably → clicking an asset opens its editor. They're drawn on
// a thin translucent disc (subtle but visible enough to aim at) above the models.

/** One pick marker per movable asset (vessel / crane / gate / yard block). */
function pickMarkerGraphics(terminals: Terminal[], gateOps: GateOpsDTO[]): Graphic[] {
  const out: Graphic[] = [];
  const push = (pkey: string, id: string, extra: Record<string, unknown> = {}) => {
    const pos = pkeyPosition(pkey, terminals);
    if (!pos) return;
    out.push(
      new Graphic({
        geometry: new Point({ longitude: pos[0], latitude: pos[1], spatialReference: { wkid: 4326 } }),
        attributes: { objectId: stableOid(`pick:${pkey}`), pkey, pickId: id, ...extra },
      }),
    );
  };
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    // Vessel (operating terminals only, matching vesselGraphics).
    if (t.status === 'OPERATING') push(`vessel:${t.terminalId}`, t.terminalId);
    // Yard blocks (3×4 = 12).
    for (let i = 0; i < YARD_ROWS * YARD_COLS; i++) push(`yard:${t.terminalId}:${i}`, `${t.terminalId}-Y${i + 1}`);
  }
  // STS cranes — every crane craneGraphics renders (anchors + cluster siblings)
  // gets its own marker, so each one in a berth cluster is individually pickable.
  for (const c of cranePlacements(terminals)) {
    out.push(
      new Graphic({
        geometry: new Point({ longitude: c.pos[0], latitude: c.pos[1], spatialReference: { wkid: 4326 } }),
        attributes: { objectId: stableOid(`pick:${c.pkey}`), pkey: c.pkey, pickId: c.craneId },
      }),
    );
  }
  // Gates (from live gateOps so only real gates get a marker).
  for (const g of gateOps) push(`gate3d:${g.gateId}`, g.gateId);
  return out;
}

/** A hit-testable marker layer sitting above the models (see pickMarkerGraphics). */
export function pickLayer(terminals: Terminal[], gateOps: GateOpsDTO[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Pick targets',
    // Keep it out of the LayerList — it's an interaction aid, not a data layer.
    listMode: 'hide',
    // Faint by default (bumped to full opacity in Edit mode by PortScene); stays
    // hit-testable either way so clicking an asset opens its editor everywhere.
    opacity: 0.12,
    source: pickMarkerGraphics(terminals, gateOps) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'pkey', type: 'string' },
      { name: 'pickId', type: 'string' },
    ],
    // Sit slightly above ground so the disc floats over the models and is easy to
    // click; screen-size so it's a consistent, comfortable target at any zoom.
    elevationInfo: { mode: 'relative-to-ground', offset: 2 },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          {
            type: 'icon',
            resource: { primitive: 'circle' },
            size: 14,
            material: { color: [26, 115, 194, 0.25] },
            outline: { color: [26, 115, 194, 0.9], size: 1.5 },
          },
        ],
      },
    } as never,
    popupEnabled: false,
  });
}

function pickGraphicsFor(terminals: Terminal[], gateOps: GateOpsDTO[]): Graphic[] {
  return pickMarkerGraphics(terminals, gateOps);
}

// ---- live vessel graphics ----

function liveVesselGraphics(
  vessels: Array<{ mmsi: string; vessel_name: string; lat: number; lon: number; course: number }>,
): Graphic[] {
  const out: Graphic[] = [];
  for (const v of vessels) {
    // Deterministic hull type based on MMSI (alternates a/b)
    let hullHash = 0;
    for (let i = 0; i < v.mmsi.length; i++) {
      hullHash ^= v.mmsi.charCodeAt(i);
      hullHash = Math.imul(hullHash, 16777619);
    }
    const hull = (hullHash & 1) === 0 ? 'a' : 'b';

    out.push(
      new Graphic({
        geometry: new Point({
          longitude: v.lon,
          latitude: v.lat,
          spatialReference: { wkid: 4326 },
        }),
        symbol: {
          type: 'point-3d',
          symbolLayers: [
            {
              type: 'object',
              resource: { href: `${MODELS}/ship-cargo-${hull}.glb` },
              height: 40,
              anchor: 'bottom',
              heading: v.course,
            },
          ],
        } as never,
        attributes: {
          objectId: stableOid(`live-vessel:${v.mmsi}`),
          vesselId: `LIVE-${v.mmsi}`,
          mmsi: v.mmsi,
          name: v.vessel_name,
          course: v.course,
        },
      }),
    );
  }
  return out;
}

/** Live vessel layer — empty initially, populated by direct add/remove in PortScene. */
export function liveVesselLayer(): GraphicsLayer {
  return new GraphicsLayer({
    title: '3D · Live Vessels',
    elevationInfo: { mode: 'on-the-ground' },
    popupTemplate: { title: '{name}', content: 'MMSI: {mmsi}<br/>Course: {course}°' } as never,
  });
}

// ---- per-kind builders for in-place diffing --------------------------------

export const graphicsFor3d = {
  decks: terminalDeckGraphics,
  yards: yardBlockGraphics,
  cranes: craneGraphics,
  vessels: vesselGraphics,
  liveVessels: liveVesselGraphics,
  gates: gate3dGraphics,
  trucks: truckGraphics,
  channel: channelGraphics,
  congestion: congestionGraphics,
  picks: pickGraphicsFor,
};
