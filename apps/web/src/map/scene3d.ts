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
 * Models (all CC0 — see public/models/CREDITS.md):
 *   • ship-cargo-a.glb / -b        — container vessels (Kenney Watercraft Kit)
 *   • cargo-container-a/b/c.glb     — ISO containers
 *   • cargo-pile-a/b.glb            — container stacks (yard blocks)
 *   • gate.glb                      — gate frame
 *   • truck.glb / delivery.glb      — trucks on the port road
 *   • sts-crane.glb                 — quay/gantry crane (poly.pizza, CC-BY 3.0,
 *                                     J-Toastie) standing on the waterline
 *   • container-ship.glb            — hero container vessel (poly.pizza,
 *                                     CC-BY 3.0, Alex Safayan)
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
// ---------------------------------------------------------------------------

function craneGraphics(terminals: Terminal[]): Graphic[] {
  const out: Graphic[] = [];
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const quay = t.quayLengthM ?? 800;
    const n = Math.max(3, Math.min(9, Math.round(quay / 200)));
    for (let i = 0; i < n; i++) {
      const frac = (i + 0.5) / n;
      const alongM = (frac - 0.5) * quay;
      // Cranes stand ~25 m inland of the waterline so the boom reaches over ships.
      const pkey = `crane:${t.terminalId}:${i}`;
      const [cx, cy] = withOverride(pkey, place(lng, lat, alongM, 30));
      out.push(
        new Graphic({
          geometry: new Point({ longitude: cx, latitude: cy, spatialReference: { wkid: 4326 } }),
          attributes: {
            objectId: stableOid(pkey),
            pkey,
            craneId: `${t.terminalId}-STS${i + 1}`,
            terminalId: t.terminalId,
            heading: placementStore.get(pkey)?.heading ?? QUAY_HEADING,
          },
        }),
      );
    }
  }
  return out;
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

/**
 * Resolve the CURRENT effective position of a movable asset by placement key —
 * the override if one exists, else the DERIVED quay-frame position. Single source
 * of the derive math for the transform panel (rotate/nudge need a base point for
 * a first-time edit). Returns null for an unknown/unmatched pkey.
 *
 * pkey formats: `vessel:<T>` · `crane:<T>:<i>` · `yard:<T>:<i>` · `gate3d:<GATEID>`
 * · `truckroute:<T>` · `rake:<siding>` · `tug` (the live-mover anchors).
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
    const t = byId.get(a ?? '');
    if (!t) return null;
    const [lng, lat] = centroid(t);
    const quay = t.quayLengthM ?? 800;
    const n = Math.max(3, Math.min(9, Math.round(quay / 200)));
    const i = Number(b) || 0;
    const alongM = ((i + 0.5) / n - 0.5) * quay;
    return place(lng, lat, alongM, 30);
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
  return gateOps
    .filter((g) => gateToPos.has(g.gateId) && byTerminal.has(g.terminalId))
    .map((g) => {
      const [lng, lat] = gateToPos.get(g.gateId)!;
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
        attributes: {
          objectId: stableOid(`gate3d:${g.gateId}`),
          pkey: `gate3d:${g.gateId}`,
          gateId: g.gateId,
          terminalId: g.terminalId,
          queueLength: g.queueLength,
          avgTxnTimeMin: g.avgTxnTimeMin,
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
      { name: 'headingDelta', type: 'double' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      // Composite gate-house that matches the reference cockpit's gate: a wide flat
      // CANOPY roof spanning the lanes on two support POSTS, with a red BOOM barrier
      // model across the road. Multiple symbolLayers render as one gate; the boom
      // GLB makes it read instantly as a checkpoint. Canopy is queue-coloured below.
      symbol: {
        type: 'point-3d',
        symbolLayers: [
          // Red boom barrier across the road (real GLB) — the recognisable gate.
          { type: 'object', resource: { href: `${MODELS}/gate-boom.glb` }, heading: QUAY_HEADING + 90, height: 6, anchor: 'bottom' },
          // Canopy roof slab over the lanes.
          { type: 'object', resource: { primitive: 'cube' }, width: 34, depth: 9, height: 1.6, material: { color: [230, 233, 235] }, anchor: 'bottom', heading: QUAY_HEADING },
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
    popupTemplate: {
      title: 'Gate {gateId}',
      content: 'Terminal: {terminalId}<br/>Queue: {queueLength}<br/>Avg txn: {avgTxnTimeMin} min',
    } as never,
  });
}

// ---------------------------------------------------------------------------
// Trucks — a queue of real truck GLBs trailing inland from each gate along the
// access road; the queue LENGTH is the live gate queue (capped for perf). This
// keeps moving/waiting vehicles on the port road, not scattered on the water.
// ---------------------------------------------------------------------------

const MAX_TRUCKS_PER_GATE = 12;

function truckGraphics(gateOps: GateOpsDTO[], terminals: Terminal[]): Graphic[] {
  const out: Graphic[] = [];
  const tById = new Map(terminals.map((t) => [t.terminalId, t] as const));
  for (const g of gateOps) {
    const t = tById.get(g.terminalId);
    if (!t || t.geom.type !== 'Point') continue;
    const gi = t.gates.indexOf(g.gateId);
    if (gi < 0) continue;
    // Anchor the queue at the gate's ACTUAL position (honours a drag override),
    // then trail trucks inland from there so they follow a repositioned gate.
    const [glng, glat] = gatePosition(t, gi);
    const nTrucks = Math.min(MAX_TRUCKS_PER_GATE, g.queueLength);
    for (let k = 0; k < nTrucks; k++) {
      // Small landward trail behind the gate, in the same quay frame (no bias —
      // glng/glat already include it).
      const [lng, lat] = offsetFrom(glng, glat, (rand01(g.gateId, `off${k}`) - 0.5) * 10, 10 + k * 14);
      out.push(
        new Graphic({
          geometry: new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }),
          attributes: {
            objectId: stableOid(`truck:${g.gateId}:${k}`),
            gateId: g.gateId,
            model: k % 3 === 0 ? 'pickup-realistic' : 'truck-realistic',
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
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'unique-value',
      field: 'model',
      uniqueValueInfos: [
        { model: 'truck-realistic', h: 8 },
        { model: 'pickup-realistic', h: 5 },
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
    // A ~120 m × 60 m patch on the road just inland of the gate, where trucks
    // queue. Build its ring by offsetting the gate point in the quay frame.
    const c0 = offsetFrom(glng, glat, -60, -25);
    const ring = [c0, offsetFrom(glng, glat, 60, -25), offsetFrom(glng, glat, 60, 90), offsetFrom(glng, glat, -60, 90), c0];
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
    // STS cranes — same count rule as craneGraphics (quay/200, clamp 3..9).
    const quay = t.quayLengthM ?? 800;
    const nCranes = Math.max(3, Math.min(9, Math.round(quay / 200)));
    for (let i = 0; i < nCranes; i++) push(`crane:${t.terminalId}:${i}`, `${t.terminalId}-STS${i + 1}`);
    // Yard blocks (3×4 = 12).
    for (let i = 0; i < YARD_ROWS * YARD_COLS; i++) push(`yard:${t.terminalId}:${i}`, `${t.terminalId}-Y${i + 1}`);
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

// ---- per-kind builders for in-place diffing --------------------------------

export const graphicsFor3d = {
  decks: terminalDeckGraphics,
  yards: yardBlockGraphics,
  cranes: craneGraphics,
  vessels: vesselGraphics,
  gates: gate3dGraphics,
  trucks: truckGraphics,
  channel: channelGraphics,
  congestion: congestionGraphics,
  picks: pickGraphicsFor,
};
