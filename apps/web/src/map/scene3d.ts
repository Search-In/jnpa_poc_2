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
 * pickup-realistic.glb, cargo-pile-a/b.glb, cargo-container-a/b/c.glb.
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
// ISO container ≈ 2.6 m; we stack a touch taller for legibility. Trimmed from
// 5.8 m so each stack renders ~10.1 × 4.5 m instead of ~12.7 × 5.7 m — a 37%
// smaller footprint, which opens up real aisles between the compacted blocks.
const CONTAINER_H_M = 4.6;
const YARD_MODELS = ['red', 'green', 'blue'] as const;

/**
 * Anchor position (override-aware) of one yard block — the base of its stack.
 * These twelve points per terminal are the ONLY ground in the scene that is known
 * to be paved container yard, so they are also what the loose yard cargo is
 * derived from.
 */
function yardBlockPos(t: Terminal, i: number): [number, number] {
  const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
  const quay = t.quayLengthM ?? 800;
  const r = Math.floor(i / YARD_COLS);
  const c = i % YARD_COLS;
  const alongM = (c - (YARD_COLS - 1) / 2) * (quay / YARD_COLS);
  const offsetM = 230 + r * 70; // landward rows
  return withOverride(`yard:${t.terminalId}:${i}`, place(lng, lat, alongM, offsetM));
}

function yardBlockGraphics(terminals: Terminal[], pendency: PendencyDTO[]): Graphic[] {
  const pendById = new Map(pendency.map((p) => [p.facilityId, p.pendency] as const));
  const out: Graphic[] = [];
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const cap = t.capacityTEU ?? 6000;
    const totalPend = pendById.get(t.terminalId) ?? cap * 0.35;
    for (let r = 0; r < YARD_ROWS; r++) {
      for (let c = 0; c < YARD_COLS; c++) {
        const i = r * YARD_COLS + c;
        const pkey = `yard:${t.terminalId}:${i}`;
        // The whole stack sits at the block anchor (honours a placement override).
        const [bx, by] = yardBlockPos(t, i);
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
// v4 — REFERENCE-MATCHED CRANE GROUPS. Each surveyed ANCHOR crane
// (`crane:<T>:<i>`, positioned from data/positions.json) keeps its exact
// coordinate and heading; SIBLINGS are derived beside it along its own rail —
// the axis perpendicular to its boom, i.e. heading ± 90°, which is the quay line.
// Nothing else moves: terminals, ships, yards, gates, roads and truck routes are
// untouched, and every crane stays on the berth's rail.
//
// The group SIZES come from the JNPA scale-model reference photographs, not from
// a uniform rule (v3's flat "3–4 everywhere" read as an artificial stamp):
//   • GTIPL          — three groups of 3 · 2 · 4 with clear gaps between them
//   • BMCT PSA (T4)  — tight runs of 2–3 broken up by lone cranes standing apart
//   • NSFT / JNPCT   — 2 · 3 · 2
//   • NSICT DP World — one long run with a smaller detached group beside it
// so the quay shows singles, pairs, threes and fours, never one repeated block.
// In-group pitch is jittered per cluster too, so no two groups measure alike.
//
// Non-overlap is budgeted, not guessed: a cluster may only spread within
// (nearestAnchorDistance / 2 − CRANE_BODY_M) of its anchor. Because BOTH
// neighbours obey the same bound, cranes of adjacent clusters always stay
// ≥ 2 × CRANE_BODY_M (≈18 m) apart, and cranes inside one cluster ≥
// CRANE_SPACING_MIN_M apart — both comfortably wider than the model's ~7.5 m
// along-rail footprint. A group is dropped one crane at a time until it fits, so
// a berth never gets more cranes than its rail can actually hold.
// ---------------------------------------------------------------------------

/**
 * Rendered along-rail footprint of sts-crane.glb: 1.6 native units × the
 * (68 m / 14.607 u) scale ≈ 7.5 m, rounded up so neighbours keep an air gap.
 */
const CRANE_BODY_M = 9;
/** In-group pitch (m) is drawn from this range per cluster, then jittered again
 *  per step — real STS cranes park 30–50 m apart and never at one exact pitch. */
const CRANE_PITCH_MIN_M = 28;
const CRANE_PITCH_MAX_M = 48;
/** Hard floor for in-cluster spacing (m) — still well clear of CRANE_BODY_M. */
const CRANE_SPACING_MIN_M = 15;
/** Room assumed around an anchor with no neighbouring crane at all (m). */
const CRANE_ISOLATED_NN_M = 400;

/**
 * Crane group SIZE at each berth position, in along-quay order, traced off the
 * JNPA reference photographs (one entry per surveyed anchor on that quay). The
 * 1s are the lone cranes standing apart from the working groups in the reference.
 */
const CRANE_GROUP_PATTERN: Record<string, number[]> = {
  // Long run + a smaller detached group (NSICT DP World photo).
  NSICT: [4, 3, 2],
  // 2 · 3 · 2 rhythm of the adjacent DP World quay.
  NSIGT: [3, 2, 3],
  // A lone crane, then the photo's 3 · 2 · 4 groups.
  GTI: [1, 3, 2, 4],
  // T4's long quay: a working group, tight pairs, and single cranes parked between.
  BMCT: [3, 2, 1, 2, 2, 2, 1, 2, 1],
  // NSFT photo: a pair, the main group of 3, and a pair.
  JNPCT: [2, 3, 2],
};
/** Rhythm used for a quay with no reference photo — varied, never uniform. */
const CRANE_GROUP_FALLBACK = [2, 3, 1, 4, 2, 3, 2, 1, 3];

/** Derived crane count for a terminal — quay/200, clamped 3..9 (unchanged rule). */
function craneAnchorCount(t: Terminal): number {
  return Math.max(3, Math.min(9, Math.round((t.quayLengthM ?? 800) / 200)));
}

/** Metres between two lng/lat points in the local (JNPA-latitude) metric frame. */
function metresBetween(a: [number, number], b: [number, number]): number {
  return Math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT);
}

// ---- per-terminal quay axis ------------------------------------------------
// The port-wide QUAY_BEARING_DEG (208°) is the average of the whole wharf, but
// each terminal's own quay runs at its own bearing — the surveyed crane anchors
// fit a straight line to within ±3 m at every terminal, and those lines range
// from 203.8° (NSIGT) to 221.4° (BMCT/GTI). Using the port-wide value left the
// booms of the southern terminals up to 13° off square to their own quay.
// So each terminal's crane heading is FITTED from its own anchors instead.

/** The port-wide seaward bearing — used only to orient the fitted normal. */
const SEAWARD_BEARING_DEG = (QUAY_BEARING_DEG + 90) % 360;
/** An anchor further than this (m) off the fitted line is left out of the fit,
 *  so one crane dragged off its rail can't swing the whole terminal's booms. */
const QUAY_FIT_TOLERANCE_M = 60;

/**
 * Heading (deg) that points a crane's boom SEAWARD, square to the quay line
 * fitted through `points` (a terminal's crane anchors). Total-least-squares, with
 * one outlier-rejection pass. Falls back to the port-wide heading if there aren't
 * enough anchors to fit a line.
 */
function fitQuayHeading(points: [number, number][]): number {
  if (points.length < 2) return QUAY_HEADING;
  const origin = points[0]!;
  const east = points.map((p) => (p[0] - origin[0]) * M_PER_DEG_LON);
  const north = points.map((p) => (p[1] - origin[1]) * M_PER_DEG_LAT);
  const fit = (idx: number[]) => {
    const mx = idx.reduce((s, i) => s + east[i]!, 0) / idx.length;
    const my = idx.reduce((s, i) => s + north[i]!, 0) / idx.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const i of idx) {
      const dx = east[i]! - mx;
      const dy = north[i]! - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    // Principal axis of the anchor scatter = the quay line.
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { dirE: Math.cos(th), dirN: Math.sin(th), mx, my };
  };
  const all = points.map((_, i) => i);
  let f = fit(all);
  const residual = (i: number, g: ReturnType<typeof fit>) =>
    Math.abs((east[i]! - g.mx) * -g.dirN + (north[i]! - g.my) * g.dirE);
  const kept = all.filter((i) => residual(i, f) <= QUAY_FIT_TOLERANCE_M);
  if (kept.length >= 2 && kept.length < all.length) f = fit(kept);
  // Of the axis's two normals, the boom takes the one pointing at the water.
  const norm = (deg: number) => ((deg % 360) + 360) % 360;
  const axis = norm((Math.atan2(f.dirE, f.dirN) * 180) / Math.PI);
  const off = (a: number) => Math.abs(((a - SEAWARD_BEARING_DEG + 540) % 360) - 180);
  const plus = norm(axis + 90);
  const minus = norm(axis - 90);
  return off(plus) <= off(minus) ? plus : minus;
}

/** Fitted seaward crane heading per terminalId (see {@link fitQuayHeading}). */
export function quayHeadings(terminals: Terminal[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const quay = t.quayLengthM ?? 800;
    const n = craneAnchorCount(t);
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const pkey = `crane:${t.terminalId}:${i}`;
      pts.push(withOverride(pkey, place(lng, lat, ((i + 0.5) / n - 0.5) * quay, 30)));
    }
    out.set(t.terminalId, fitQuayHeading(pts));
  }
  return out;
}

/**
 * Along-rail offsets (m) for one crane group. Element 0 is ALWAYS 0 — the
 * surveyed anchor never moves. `budgetM` is how far a sibling may sit from the
 * anchor without encroaching on the neighbouring group; `groupSize` is the size
 * the reference pattern asks for, which is reduced if the rail is too short.
 */
function craneClusterOffsets(pkey: string, budgetM: number, groupSize: number): number[] {
  // Every group gets its own base pitch, and every step inside it wobbles around
  // that pitch, so two groups of the same size still measure differently.
  const base = CRANE_PITCH_MIN_M + rand01(pkey, 'pitch') * (CRANE_PITCH_MAX_M - CRANE_PITCH_MIN_M);
  const d = [0, 1, 2].map((i) => base * (0.85 + rand01(pkey, `step${i}`) * 0.3));
  // Which side of the anchor the group grows towards, so the quay isn't mirrored.
  const flip = rand01(pkey, 'side') < 0.5 ? 1 : -1;
  for (let k = Math.max(1, Math.min(4, groupSize)); k > 1; k--) {
    // 2 → one neighbour · 3 → one either side · 4 → a pair on one side.
    const raw =
      k === 2 ? [0, d[0]!] : k === 3 ? [0, d[0]!, -d[1]!] : [0, -d[0]!, d[1]!, d[1]! + d[2]!];
    const extent = Math.max(...raw.map((v) => Math.abs(v)));
    const fit = extent > budgetM ? budgetM / extent : 1;
    const sorted = [...raw].sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, (sorted[i]! - sorted[i - 1]!) * fit);
    // Too tight for this rail — try the same group with one crane fewer.
    if (minGap >= CRANE_SPACING_MIN_M) return raw.map((v) => v * fit * flip);
  }
  return [0]; // a lone crane, exactly as the reference shows at some berths
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
  // Group size the reference pattern asks for at each anchor, by pkey.
  const groupSize = new Map<string, number>();
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const quay = t.quayLengthM ?? 800;
    const n = craneAnchorCount(t);
    const derived: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      derived.push(withOverride(`crane:${t.terminalId}:${i}`, place(lng, lat, ((i + 0.5) / n - 0.5) * quay, 30)));
    }
    // Boom square to THIS terminal's quay, fitted from its own anchors — not the
    // port-wide average bearing, which is up to 13° off at the southern quays.
    const quayHeading = fitQuayHeading(derived);
    const mine: CranePlacement[] = derived.map((pos, i) => {
      const pkey = `crane:${t.terminalId}:${i}`;
      return {
        pkey,
        terminalId: t.terminalId,
        craneId: `${t.terminalId}-STS${i + 1}`,
        // Cranes stand ~30 m inland of the waterline so the boom reaches over ships.
        pos,
        heading: placementStore.get(pkey)?.heading ?? quayHeading,
      };
    });
    // Read the reference pattern in ALONG-QUAY order, not index order, so the
    // photographed sequence of group sizes lands in the photographed sequence of
    // berths (the surveyed anchor indices are not sorted along the quay). Rank on
    // the FITTED axis so the order follows this terminal's real quay.
    const railRad = ((quayHeading + 90) * Math.PI) / 180;
    const rankAlong = (p: [number, number]) =>
      (p[0] - lng) * M_PER_DEG_LON * Math.sin(railRad) + (p[1] - lat) * M_PER_DEG_LAT * Math.cos(railRad);
    const pattern = CRANE_GROUP_PATTERN[t.terminalId] ?? CRANE_GROUP_FALLBACK;
    [...mine]
      .sort((a, b) => rankAlong(a.pos) - rankAlong(b.pos))
      .forEach((c, rank) => groupSize.set(c.pkey, pattern[rank % pattern.length]!));
    anchors.push(...mine);
  }

  // 2. Grow each anchor into its reference-sized group along its own rail.
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
    craneClusterOffsets(a.pkey, budgetM, groupSize.get(a.pkey) ?? 2).forEach((offM, j) => {
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

/**
 * Real JNPA gate names, by the gate id the rest of the system uses.
 *
 * The ids are deliberately NOT renamed: scenario definitions, the sim registry,
 * the causal graph and the KPI / gateway / notification / scenario-engine tests
 * all key off them. So the real-world name lives here as the DISPLAY label — it
 * is what the 3D label, the popup and the asset tree show — while the id stays
 * stable for everything downstream. Positions live in data/positions.json.
 */
export const GATE_NAMES: Record<string, string> = {
  'JNPCT-G1': 'North Gate',
  'JNPCT-G2': 'JNPCT Gate 2',
  'GTI-G2': 'Central Gate',
  'NSICT-G1': 'NSICT Entry Gate',
  'NSIGT-G1': 'NSIGT Entry Gate',
  'GTI-G1': 'GTI Entry Gate',
  'BMCT-G1': 'BMCT Entry Gate',
};

/** Display name for a gate id, falling back to the id itself. */
export function gateName(gateId: string): string {
  return GATE_NAMES[gateId] ?? gateId;
}

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

/** Current heading (deg) for a movable pkey — the override's, else the quay default.
 *  Pass `terminals` to get a crane's FITTED per-terminal quay heading. */
export function pkeyHeading(pkey: string, terminals?: Terminal[]): number {
  const o = placementStore.get(pkey);
  if (o?.heading != null) return o.heading;
  // Vessels default to quay bearing + 90 (hull along the quay).
  if (pkey.startsWith('vessel:')) return (QUAY_HEADING + 90) % 360;
  // Cranes (anchors and cluster siblings) point square to their OWN terminal's
  // quay; a sibling inherits whatever its anchor is set to.
  const craneParts = pkey.startsWith('crane:') ? pkey.split(':') : [];
  if (craneParts.length >= 3) {
    if (craneParts.length === 4) {
      const anchor = placementStore.get(craneParts.slice(0, 3).join(':'));
      if (anchor?.heading != null) return anchor.heading;
    }
    const fitted = terminals ? quayHeadings(terminals).get(craneParts[1]!) : undefined;
    return fitted ?? QUAY_HEADING;
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
          // Labelled in 3D so the entry and exit sides read at a glance, under
          // the gate's REAL JNPA name rather than its internal id.
          role,
          gateName: gateName(g.gateId),
          roleLabel:
            role === 'BOTH' ? `${gateName(g.gateId)} · IN/OUT` : `${gateName(g.gateId)} · ${role} GATE`,
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
      { name: 'gateName', type: 'string' },
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
      title: '{gateName}',
      content: 'Gate id: {gateId}<br/>Terminal: {terminalId}<br/>Direction: {role}<br/>Queue: {queueLength}<br/>Avg txn: {avgTxnTimeMin} min',
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
// Rail track — the physical permanent way the shunting rake runs on. Until now
// the only railway in the scene was the moving train itself, so between shunts
// there was nothing on the ground to show where the line goes.
//
// The corridor is the line marked in red on the JNPA reference image: a straight
// 1509 m run from above the BMCT gates, ESE (140°) along the port's landward
// boundary, ending on the JNPCT-G2 OUT gate. It stays at least 160 m clear of
// every container stack and 229 m clear of every truck route, so the track never
// crosses the container yard or a road.
//
// The port runs TWO lines, but only T1's rails are drawn here:
//   • T1 — the reference corridor above (BMCT end → JNPCT-G2). No permanent way is
//          visible on the basemap along it, so we lay our own.
//   • T2 — the original central-yard siding. The basemap ALREADY shows that track,
//          so drawing ours over it produced a visible double line. T2 therefore
//          renders its rake only (see `drawTrack` in RAIL_LINES) and the train runs
//          on the imagery's own rails.
// Each drawn line's geometry is derived from the SAME `rake:<siding>` anchor + heading
// its train uses, so the rails and that rake can never drift apart — dragging or
// rotating an anchor in the placement editor moves both together. Drawn with the
// line-3d symbol the channel layer already uses: a ballast band, a dashed dark
// band that reads as sleepers, and a thin steel line for the rail heads. No new
// model, no new asset.
// ---------------------------------------------------------------------------

/**
 * The rail lines, by siding. `behindM` / `aheadM` are how far the permanent way is
 * drawn either side of that line's rake anchor, in metres.
 *
 * `drawTrack` is why T2 has no rails: the satellite basemap ALREADY shows the real
 * permanent way along the central yard siding, so drawing our own over it rendered
 * two tracks side by side. T2's rake still runs — only its duplicate rails are
 * suppressed, and it rides the line that is already in the imagery. T1 keeps its
 * rails because the reference corridor has none drawn on the basemap.
 */
export const RAIL_LINES = [
  // The JNPA reference corridor: 200 m back to the BMCT end, 1309 m on to JNPCT-G2.
  { siding: 'T1', name: 'JNPCT rail corridor', behindM: 200, aheadM: 1309, drawTrack: true },
  // The original central-yard siding — rake only; the basemap draws this track.
  { siding: 'T2', name: 'Central yard siding', behindM: 200, aheadM: 800, drawTrack: false },
] as const;

/** The line-3d rails: ballast, sleepers, then the rail heads on top. */
const RAIL_SYMBOL = {
  type: 'line-3d',
  symbolLayers: [
    { type: 'line', size: 7, material: { color: [126, 116, 104, 0.85] }, cap: 'butt' },
    { type: 'line', size: 5, material: { color: [72, 62, 54, 0.95] }, cap: 'butt', pattern: { type: 'style', style: 'dash' } },
    { type: 'line', size: 1.4, material: { color: [188, 192, 196] }, cap: 'butt' },
  ],
} as never;

export function railTrackLayer(terminals: Terminal[]): GraphicsLayer {
  const layer = new GraphicsLayer({ title: '3D · Rail track', elevationInfo: { mode: 'on-the-ground' } });
  for (const line of RAIL_LINES) {
    // Lines whose permanent way is already visible on the basemap draw no rails —
    // their rake runs on the track that is there (see RAIL_LINES).
    if (!line.drawTrack) continue;
    const pkey = `rake:${line.siding}`;
    const anchor = pkeyPosition(pkey, terminals);
    if (!anchor) continue;
    const heading = pkeyHeading(pkey);
    const back = metreOffset(anchor[0], anchor[1], (heading + 180) % 360, line.behindM);
    const fwd = metreOffset(anchor[0], anchor[1], heading, line.aheadM);
    layer.add(
      new Graphic({
        geometry: new Polyline({ paths: [[back, fwd]], spatialReference: { wkid: 4326 } }),
        symbol: RAIL_SYMBOL,
        attributes: { objectId: stableOid(`railtrack:${line.siding}`), siding: line.siding, name: line.name },
      }),
    );
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
/**
 * Lane-to-lane spacing (m), lateral; stays well inside the 36 m canopy span.
 * Must clear the WIDEST vehicle: truck-realistic renders 7.5 m across at its 8 m
 * symbol height, so the old 7 m pitch had neighbouring lanes interpenetrating by
 * half a metre. 10 m leaves a 2.5 m gap between lanes.
 */
const TRUCK_LANE_PITCH_M = 10;
/** Distance (m) the first row stops landward of the gate — clear of the canopy. */
const TRUCK_QUEUE_STANDOFF_M = 22;
/**
 * Row-to-row spacing (m) — wider than the longest vehicle, so no interpenetration.
 * Lane 0 is filled entirely with container-trucks, which render 23.1 m long, and
 * the ±2 m stop-line slop can pull two rows 4 m closer together. At the old 26 m
 * pitch that worst case left them exactly touching; 30 m keeps ~3 m of air.
 */
const TRUCK_QUEUE_PITCH_M = 30;

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
// Live traffic — Google-Maps-style congestion colouring ON the road network.
//
// The roads are the user-traced `truckroute:*` polylines. Each is cut into short
// SEGMENTS and every segment gets a congestion score in 0..1, which the renderer
// maps green → amber → red → dark red. Nothing about the roads themselves changes:
// this is a coloured overlay laid on the same geometry.
//
// The score is DERIVED FROM VEHICLES, never random:
//   1. vehicle density — every truck within TRAFFIC_CATCH_M of the segment counts,
//      taken from the live gate queues (which are driven by gateOps.queueLength)
//      plus, when the caller passes them, the positions of the moving trucks;
//      count ÷ TRAFFIC_JAM_VEHICLES gives the raw load.
//   2. gate friction — a gate is a choke point, so a share of its queue length is
//      added to nearby segments with a linear falloff over TRAFFIC_GATE_REACH_M.
// The two are summed and clamped, so a quiet road stays green, a road with a few
// trucks goes amber, and the approach to a gate with a long queue goes red.
//
// Two smoothing passes stop the overlay looking like a barcode:
//   • SPATIAL — a [1,2,1] kernel along each road, so neighbouring segments blend
//     instead of jumping from green to red across one joint.
//   • TEMPORAL — each rebuild eases toward the new value (TRAFFIC_EASING) instead
//     of snapping, so a queue change ramps in over a few updates.
// The eased state lives in `trafficState`, keyed by segment, and is the only
// mutable module state here.
//
// Cost: ~30 segments for the whole port, recomputed only when the caller asks
// (on a sim tick, or the periodic refresh in PortScene) — never per frame.
// ---------------------------------------------------------------------------

/** Length (m) of one coloured road segment. */
const TRAFFIC_SEGMENT_M = 50;
/** A vehicle within this distance (m) of a segment counts toward its load. */
const TRAFFIC_CATCH_M = 60;
/** Distance-weighted vehicle count that saturates one segment's density term. */
const TRAFFIC_JAM_VEHICLES = 9;
/** Ceiling on the density term alone, so vehicles never pin a segment at severe. */
const TRAFFIC_DENSITY_CAP = 0.75;
/** How far (m) a gate's queue bleeds congestion back down its approach road. */
const TRAFFIC_GATE_REACH_M = 170;
/** Queue length treated as a fully congested gate. */
const TRAFFIC_GATE_JAM_QUEUE = 14;
/** Ceiling on the gate-friction term alone. */
const TRAFFIC_GATE_CAP = 0.72;
/** Ends within this distance (m) are treated as one junction. */
const TRAFFIC_JUNCTION_M = 40;
/** Relaxation passes that walk congestion back up the approach (~50 m each). */
const TRAFFIC_SPREAD_PASSES = 4;
/** Share a segment inherits from its worst neighbour on each spread pass. */
const TRAFFIC_SPREAD_DECAY = 0.82;
/** A segment may sit at most this far above everything it touches. */
const TRAFFIC_DESPECKLE_DELTA = 0.18;
/** Fraction of the way the overlay moves toward its new value per rebuild. */
const TRAFFIC_EASING = 0.35;
/** Slower rate used when congestion is CLEARING — jams build fast, clear slowly. */
const TRAFFIC_RECOVERY_EASING = 0.14;

/** Eased congestion per segment key — the only mutable state in this module. */
const trafficState = new Map<string, number>();

/** Reset the eased traffic state (used by tests so runs are independent). */
export function resetTrafficState(): void {
  trafficState.clear();
}

/** Distance (m) from `p` to segment `a`–`b`. */
function pointToSegmentM(p: [number, number], a: [number, number], b: [number, number]): number {
  const ax = (a[0] - p[0]) * M_PER_DEG_LON;
  const ay = (a[1] - p[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - p[0]) * M_PER_DEG_LON;
  const by = (b[1] - p[1]) * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
  return Math.hypot(ax + u * dx, ay + u * dy);
}

/** One coloured piece of road, with its neighbours in the road graph. */
interface RoadSegment {
  key: string;
  routeId: string;
  a: [number, number];
  b: [number, number];
  /** Indices of segments this one flows into — along its road AND across junctions. */
  neighbours: number[];
}

/**
 * Cut every traced road into ~TRAFFIC_SEGMENT_M pieces and link them into a graph.
 *
 * Roads are discovered by scanning the placement store for EVERY `truckroute:*`
 * key that carries a path, rather than by walking the terminal list — so a route
 * traced for a new road, or for anything that isn't a terminal id, is picked up
 * with no code change.
 *
 * Two segments are neighbours when they are consecutive on the same road, or when
 * their ends meet within TRAFFIC_JUNCTION_M — that second case is what lets a
 * junction inherit congestion from every road feeding it.
 */
function roadSegments(): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (const [key, placement] of Object.entries(placementStore.all())) {
    if (!key.startsWith('truckroute:')) continue;
    const path = placement.path;
    if (!path || path.length < 2) continue;
    const routeId = key.slice('truckroute:'.length);
    let n = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const steps = Math.max(1, Math.round(metresBetween(a, b) / TRAFFIC_SEGMENT_M));
      for (let s = 0; s < steps; s++) {
        const u0 = s / steps;
        const u1 = (s + 1) / steps;
        out.push({
          key: `traffic:${routeId}:${n++}`,
          routeId,
          a: [a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0],
          b: [a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1],
          neighbours: [],
        });
      }
    }
  }
  // Link the graph: consecutive on one road, plus any ends that meet at a junction.
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const p = out[i]!;
      const q = out[j]!;
      const sameRoadRun = p.routeId === q.routeId && j === i + 1;
      const meets =
        Math.min(
          metresBetween(p.b, q.a),
          metresBetween(p.a, q.b),
          metresBetween(p.a, q.a),
          metresBetween(p.b, q.b),
        ) <= TRAFFIC_JUNCTION_M;
      if (!sameRoadRun && !meets) continue;
      p.neighbours.push(j);
      q.neighbours.push(i);
    }
  }
  return out;
}

/**
 * Congestion graphics for the road network. `vehicles` are extra live vehicle
 * positions (the moving trucks); omit them and the score still reflects the gate
 * queues, which is what drives the hotspots.
 */
function trafficGraphics(
  gateOps: GateOpsDTO[],
  terminals: Terminal[],
  vehicles: [number, number][] = [],
): Graphic[] {
  const segs = roadSegments();
  if (segs.length === 0) return [];

  // Every vehicle the scene knows about: the queued trucks (already a function of
  // the live gateOps) plus whatever movers the caller sampled.
  const queued = truckGraphics(gateOps, terminals).map((g) => {
    const geo = g.geometry as unknown as { longitude: number; latitude: number };
    return [geo.longitude, geo.latitude] as [number, number];
  });
  const allVehicles = [...queued, ...vehicles];

  // Gate positions + their live queue length — the choke points.
  const gatePoints: Array<{ p: [number, number]; queue: number }> = [];
  const byId = new Map(gateOps.map((g) => [g.gateId, g] as const));
  for (const t of terminals) {
    if (t.geom.type !== 'Point') continue;
    t.gates.forEach((gateId, i) => {
      const op = byId.get(gateId);
      if (op) gatePoints.push({ p: gatePosition(t, i), queue: op.queueLength });
    });
  }

  // ---- 1. raw load per segment ----
  const raw = segs.map((s) => {
    // (a) vehicle density — nearer vehicles weigh more, so the field is smooth
    // rather than flicking as a truck crosses the catch radius.
    let weighted = 0;
    for (const v of allVehicles) {
      const d = pointToSegmentM(v, s.a, s.b);
      if (d < TRAFFIC_CATCH_M) weighted += 1 - d / TRAFFIC_CATCH_M;
    }
    const density = Math.min(TRAFFIC_DENSITY_CAP, weighted / TRAFFIC_JAM_VEHICLES);

    // (b) gate friction — strongest at the gate, easing off down the approach.
    let gate = 0;
    for (const g of gatePoints) {
      const d = pointToSegmentM(g.p, s.a, s.b);
      if (d >= TRAFFIC_GATE_REACH_M) continue;
      const falloff = (1 - d / TRAFFIC_GATE_REACH_M) ** 1.6;
      gate = Math.max(gate, (g.queue / TRAFFIC_GATE_JAM_QUEUE) * falloff);
    }
    gate = Math.min(TRAFFIC_GATE_CAP, gate);

    // Combine as independent causes rather than a plain sum: either alone can
    // colour a road, both together tip it into severe, and neither can pin it at
    // the cap on its own — which is what kept whole roads solid dark red.
    return Math.max(0, Math.min(1, 1 - (1 - density) * (1 - gate)));
  });

  // ---- 2. spread congestion BACKWARD along the road graph ----
  // A queue doesn't stop at the gate; it tails back up the approach. Each pass
  // lets a segment inherit a decayed share of its worst neighbour, so congestion
  // walks along the carriageway (~one segment per pass) instead of only fading
  // radially. Because the graph includes junction links, a busy road also bleeds
  // into the roads that feed it — which is how junctions inherit their colour.
  const spread = [...raw];
  for (let pass = 0; pass < TRAFFIC_SPREAD_PASSES; pass++) {
    const prev = [...spread];
    for (let i = 0; i < segs.length; i++) {
      let inherited = 0;
      for (const j of segs[i]!.neighbours) inherited = Math.max(inherited, prev[j]! * TRAFFIC_SPREAD_DECAY);
      spread[i] = Math.max(spread[i]!, inherited);
    }
  }

  // ---- 3. spatial smoothing across the GRAPH, [1,2,1] in spirit ----
  // Same weighting as before — the segment counts double, its neighbours share
  // the other half — but neighbours now come from the graph, so the gradient runs
  // continuously through a junction instead of stopping at the road boundary.
  const smooth = spread.map((v, i) => {
    const nb = segs[i]!.neighbours;
    if (nb.length === 0) return v;
    const mean = nb.reduce((sum, j) => sum + spread[j]!, 0) / nb.length;
    return (2 * v + 2 * mean) / 4;
  });

  // ---- 4. despeckle: no isolated red island in a green road ----
  // If a segment sits far above everything touching it, it is an artefact of one
  // parked truck rather than a real jam; pull it down toward its neighbourhood.
  const clean = smooth.map((v, i) => {
    const nb = segs[i]!.neighbours;
    if (nb.length === 0) return v;
    const peak = Math.max(...nb.map((j) => smooth[j]!));
    return v - peak > TRAFFIC_DESPECKLE_DELTA ? peak + TRAFFIC_DESPECKLE_DELTA : v;
  });

  // ---- 5. temporal easing, so colours ramp rather than snap ----
  return segs.map((s, i) => {
    const target = clean[i]!;
    const prev = trafficState.get(s.key) ?? target;
    // Asymmetric, like real traffic: a jam forms quickly, and clears slowly, so a
    // road recovers red → orange → green over several updates rather than
    // flicking back to green the instant a queue empties.
    const rate = target > prev ? TRAFFIC_EASING : TRAFFIC_RECOVERY_EASING;
    const eased = prev + (target - prev) * rate;
    trafficState.set(s.key, eased);
    return new Graphic({
      geometry: new Polyline({ paths: [[s.a, s.b]], spatialReference: { wkid: 4326 } }),
      attributes: {
        objectId: stableOid(s.key),
        segmentId: s.key,
        routeId: s.routeId,
        // 0 = free flowing … 1 = jammed. Drives the colour ramp.
        congestion: Math.round(eased * 1000) / 1000,
        level:
          eased < 0.25 ? 'Free flowing' : eased < 0.5 ? 'Moderate' : eased < 0.75 ? 'Heavy' : 'Severe',
      },
    });
  });
}

/**
 * Google-Maps-style traffic ramp: free flowing → moderate → heavy → severe.
 * Alpha climbs with congestion so a clear road reads as a light hint over the
 * imagery while a jam is solid and unmissable.
 */
const TRAFFIC_STOPS = [
  { value: 0.0, color: [30, 168, 79, 0.62] }, // green, light
  { value: 0.4, color: [247, 181, 41, 0.86] }, // amber
  { value: 0.7, color: [219, 68, 55, 0.96] }, // red
  { value: 1.0, color: [138, 24, 20, 1.0] }, // dark red, solid
];
/** The ribbon thickens as it congests — thin when free flowing, fat when jammed. */
const TRAFFIC_WIDTH_STOPS = [
  { value: 0.0, size: 4 },
  { value: 0.4, size: 6 },
  { value: 1.0, size: 10 },
];

export function trafficLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: '3D · Live traffic',
    source: trafficGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'segmentId', type: 'string' },
      { name: 'routeId', type: 'string' },
      { name: 'congestion', type: 'double' },
      { name: 'level', type: 'string' },
    ],
    elevationInfo: { mode: 'on-the-ground' },
    renderer: {
      type: 'simple',
      symbol: {
        type: 'line-3d',
        symbolLayers: [
          // A dark casing under the colour so the ribbon stays legible over
          // satellite imagery, exactly like a map traffic overlay on the road.
          { type: 'line', size: 6, material: { color: [22, 24, 27, 0.55] }, cap: 'round', join: 'round' },
          { type: 'line', size: 6, material: { color: TRAFFIC_STOPS[0]!.color }, cap: 'round', join: 'round' },
        ],
      },
      visualVariables: [
        { type: 'color', field: 'congestion', stops: TRAFFIC_STOPS },
        // Heavier traffic draws a wider ribbon, so a jam reads even zoomed out.
        { type: 'size', field: 'congestion', stops: TRAFFIC_WIDTH_STOPS },
      ],
    } as never,
    popupTemplate: {
      title: 'Traffic — {level}',
      content: 'Road: {routeId}<br/>Congestion index: {congestion}',
    } as never,
  });
}

/**
 * The same traffic model rendered for the FLAT map (PortMap). Identical graphics
 * and identical colour ramp — only the symbol differs, because a 2D MapView needs
 * `simple-line` rather than `line-3d`.
 */
export function traffic2dLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Live traffic',
    source: trafficGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'segmentId', type: 'string' },
      { name: 'routeId', type: 'string' },
      { name: 'congestion', type: 'double' },
      { name: 'level', type: 'string' },
    ],
    renderer: {
      type: 'simple',
      symbol: { type: 'simple-line', width: 4, color: TRAFFIC_STOPS[0]!.color, cap: 'round', join: 'round' },
      visualVariables: [
        { type: 'color', field: 'congestion', stops: TRAFFIC_STOPS },
        { type: 'size', field: 'congestion', stops: TRAFFIC_WIDTH_STOPS },
      ],
    } as never,
    popupTemplate: {
      title: 'Traffic — {level}',
      content: 'Road: {routeId}<br/>Congestion index: {congestion}',
    } as never,
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

// ---------------------------------------------------------------------------
// Yard-area highlight — outlines the ONE yard block picked in the asset tree.
//
// There is no yard polygon anywhere in the project: a yard block is rendered as a
// stack of container models at a single point (`yard:<T>:<i>`). Rather than
// inventing a new shape or a new source of truth, the outline is derived from the
// block that is already there — its own position, its own heading, and the pitch
// of the grid it sits in — so it always frames exactly what is drawn and follows
// the block if it is dragged in the placement editor.
//
// The extent is half the distance to the block's nearest neighbour, clamped, so
// the outline fills its bay without ever bleeding into the next one (the yard
// pitch differs per terminal — 24 m at most, 36 m at JNPCT).
// ---------------------------------------------------------------------------

/** Fraction of the gap to the neighbouring block that the outline spans. */
const YARD_HIGHLIGHT_FILL = 0.45;
/** Clamp on the half-extent (m), so a lone or very tight block still reads. */
const YARD_HIGHLIGHT_MIN_M = 8;
const YARD_HIGHLIGHT_MAX_M = 18;

/** `NSICT-Y3` → `yard:NSICT:2`, or null when the id is not a yard block. */
export function yardPkeyFromAssetId(assetId: string): string | null {
  const m = assetId.match(/^(.+)-Y(\d+)$/);
  return m ? `yard:${m[1]}:${Number(m[2]) - 1}` : null;
}

/** Ground position of a yard block by its ASSET id, or null if not a yard. */
export function yardAssetPosition(assetId: string, terminals: Terminal[]): [number, number] | null {
  const pkey = yardPkeyFromAssetId(assetId);
  return pkey ? pkeyPosition(pkey, terminals) : null;
}

/**
 * Outline (and soft fill) for the selected yard block. Returns an empty array for
 * anything that is not a yard block, so the caller can hand it any asset id.
 */
export function yardHighlightGraphics(assetId: string, terminals: Terminal[]): Graphic[] {
  const pkey = yardPkeyFromAssetId(assetId);
  if (!pkey) return [];
  const centre = pkeyPosition(pkey, terminals);
  if (!centre) return [];
  const terminalId = pkey.split(':')[1]!;

  // Half-extent from the yard grid's own pitch — never overlaps the next bay.
  let nearest = Infinity;
  for (let i = 0; i < YARD_ROWS * YARD_COLS; i++) {
    const other = `yard:${terminalId}:${i}`;
    if (other === pkey) continue;
    const p = pkeyPosition(other, terminals);
    if (p) nearest = Math.min(nearest, metresBetween(centre, p));
  }
  const half = Number.isFinite(nearest)
    ? Math.max(YARD_HIGHLIGHT_MIN_M, Math.min(YARD_HIGHLIGHT_MAX_M, nearest * YARD_HIGHLIGHT_FILL))
    : YARD_HIGHLIGHT_MIN_M;

  // Square to the block's own heading, so the outline sits with the containers.
  const heading = placementStore.get(pkey)?.heading ?? QUAY_HEADING;
  const along = (heading + 90) % 360;
  const corner = (a: number, b: number): [number, number] => {
    const [x, y] = metreOffset(centre[0], centre[1], along, a);
    return metreOffset(x, y, heading, b);
  };
  const ring = [corner(-half, -half), corner(half, -half), corner(half, half), corner(-half, half)];

  return [
    new Graphic({
      geometry: new Polygon({ rings: [[...ring, ring[0]!]], spatialReference: { wkid: 4326 } }),
      symbol: {
        type: 'polygon-3d',
        symbolLayers: [
          {
            type: 'fill',
            // Cyan reads clearly against the containers and cannot be confused
            // with the traffic ramp (green/amber/red) or the amber pick ring.
            material: { color: [0, 214, 235, 0.18] },
            outline: { color: [0, 214, 235, 0.95], size: 2.5 },
          },
        ],
      } as never,
      attributes: { yardPkey: pkey, blockId: assetId },
    }),
  ];
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
  traffic: trafficGraphics,
  picks: pickGraphicsFor,
};
