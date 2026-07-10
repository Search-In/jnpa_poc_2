/**
 * sceneAnim.ts — the LIVE MOTION layer of the 3D sea-port.
 *
 * The operational layers in scene3d.ts are data-driven FeatureLayers edited in
 * place on every sim tick (a few edits/second). That path is far too slow for
 * 60 fps motion, and it is also where the placement-editor and in-place diff
 * live — so we must NOT animate those.
 *
 * Instead, every MOVING thing (trucks driving the gate→terminal loop, a shunting
 * rake on the rail sidings, STS crane trolley/hoist boxes, a patrolling tug in
 * the channel) is a plain `Graphic` on a dedicated `GraphicsLayer`. Each frame we
 * mutate the graphic's `.geometry` (a new Point) and `.symbol` (heading) directly
 * — no queryFeatures / applyEdits round-trip, no blink, and nothing here carries a
 * `pkey`, so the placement editor never touches these decorative movers.
 *
 * All positions are laid out in the SAME quay-aligned metric frame as the static
 * assets (scene3d's `place` / `offsetFrom` / `headingBetween`), so an animated
 * truck drives along the very road the static gates sit on, at real JNPA
 * coordinates. Motion is a pure function of an elapsed-seconds clock `t`, so it
 * is deterministic and reduced-motion can simply stop advancing `t`.
 */
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import type { Terminal } from '@jnpa/schemas';
import type { GateOpsDTO } from '@jnpa/data';
import { place, headingBetween, QUAY_BEARING_DEG } from './scene3d.js';
import { placementStore } from './placementStore.js';
import { tokens } from '../theme/tokens.js';

const MODELS = '/models';

const M_PER_DEG_LAT_C = 110_574;
const M_PER_DEG_LON_C = 111_320 * Math.cos((18.945 * Math.PI) / 180);

/**
 * An anchor override for a whole mover group (truck route / rail rake / tug): the
 * user can drag the group's anchor and rotate it, and the entire route/track/boat
 * shifts + spins together. `deltaLng/deltaLat` translate every point of the group;
 * `rotDeg` rotates the group about its anchor. Derived from a placementStore entry
 * on the group's `pkey` (e.g. `truckroute:NSICT`, `rake:T1`, `tug`) vs its default
 * anchor position.
 */
function anchorTransform(pkey: string, defaultAnchor: LngLat, defaultHeading: number) {
  const o = placementStore.get(pkey);
  const deltaLng = o ? o.lng - defaultAnchor[0] : 0;
  const deltaLat = o ? o.lat - defaultAnchor[1] : 0;
  const rotDeg = o?.heading != null ? o.heading - defaultHeading : 0;
  const anchor: LngLat = o ? [o.lng, o.lat] : defaultAnchor;
  return { deltaLng, deltaLat, rotDeg, anchor };
}

/** Rotate point `p` about `pivot` by `deg` (compass, CW), in the local metric frame. */
function rotateAbout(p: LngLat, pivot: LngLat, deg: number): LngLat {
  if (deg === 0) return p;
  const rad = (deg * Math.PI) / 180;
  const e = (p[0] - pivot[0]) * M_PER_DEG_LON_C;
  const n = (p[1] - pivot[1]) * M_PER_DEG_LAT_C;
  // compass CW rotation of the (east,north) vector
  const e2 = e * Math.cos(rad) + n * Math.sin(rad);
  const n2 = -e * Math.sin(rad) + n * Math.cos(rad);
  return [pivot[0] + e2 / M_PER_DEG_LON_C, pivot[1] + n2 / M_PER_DEG_LAT_C];
}

/** Apply an anchor transform (translate then rotate about the moved anchor) to a point. */
function applyAnchor(p: LngLat, tr: { deltaLng: number; deltaLat: number; rotDeg: number; anchor: LngLat }): LngLat {
  const shifted: LngLat = [p[0] + tr.deltaLng, p[1] + tr.deltaLat];
  return rotateAbout(shifted, tr.anchor, tr.rotDeg);
}

// Model long-axis heading offsets (deg) so a model faces its travel direction.
// Quaternius truck/pickup point along +Y; the rake models point along +X.
const TRUCK_MODEL_OFFSET = 180; // truck models turned a further 90° to face along travel
const RAKE_MODEL_OFFSET = 90; // rake models' long axis is +X → +90° to face along-track

type LngLat = [number, number];

/** Safe cyclic array access (routes are non-empty by construction). */
function at(arr: LngLat[], i: number): LngLat {
  return arr[((i % arr.length) + arr.length) % arr.length] ?? arr[0]!;
}

/** An ObjectSymbol3D for a glTF model, scaled to `height` m and faced `heading`. */
function objectSymbol(href: string, height: number, heading: number, tiltable?: { tilt?: number }) {
  return {
    type: 'point-3d',
    symbolLayers: [
      {
        type: 'object',
        resource: { href },
        height,
        anchor: 'bottom',
        heading,
        ...(tiltable?.tilt != null ? { tilt: tiltable.tilt } : {}),
      },
    ],
  } as never;
}

/** A simple coloured primitive (used for the crane hoist box). */
function boxSymbol(color: number[], w: number, d: number, h: number, heading = 0) {
  return {
    type: 'point-3d',
    symbolLayers: [
      { type: 'object', resource: { primitive: 'cube' }, width: w, depth: d, height: h, material: { color }, anchor: 'center', heading },
    ],
  } as never;
}

// ---------------------------------------------------------------------------
// Route geometry — a closed loop each animated truck drives: from the port
// approach road, in through the gate, up the terminal apron, and back out. All
// waypoints are resolved in the quay frame from the terminal centroid, so the
// route hugs the real access road at real coordinates.
// ---------------------------------------------------------------------------

/** Waypoints (lng,lat) for one terminal's gate-in / apron / gate-out circuit. */
function truckRoute(t: Terminal): LngLat[] {
  const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
  const quay = t.quayLengthM ?? 800;
  const half = quay * 0.35;
  // offset (perpendicular): + = landward. Gate sits ~470 m inland; apron ~230 m.
  return [
    place(lng, lat, half + 120, 640), // far approach road, down-quay
    place(lng, lat, 0, 620), // road in front of the gate line
    place(lng, lat, 0, 470), // through the gate
    place(lng, lat, -half, 300), // onto the apron, up-quay
    place(lng, lat, -half, 230), // yard edge
    place(lng, lat, half, 230), // traverse the yard face
    place(lng, lat, half, 470), // back to the gate
    place(lng, lat, half + 120, 640), // out to the approach road
  ];
}

interface TruckMover {
  g: Graphic;
  wps: LngLat[];
  seg: number;
  u: number; // 0..1 along current segment
  speed: number; // m/s (scaled)
  gateId: string; // which gate this truck's speed keys off (queue → slower)
  model: string;
  /** True when following a user-DRAWN path (skip the synthetic gate-slowdown). */
  custom: boolean;
}

// ---------------------------------------------------------------------------
// Rail rake — a locomotive + wagons that shunts along the siding, waits, and
// re-enters. Laid along the quay bearing at the siding coordinate.
// ---------------------------------------------------------------------------

interface RakeCar {
  g: Graphic;
  offsetM: number; // metres behind the loco along the rake axis
}

interface Rake {
  cars: RakeCar[];
  origin: LngLat; // siding centroid
  axisDeg: number; // travel bearing along the siding
  headM: number; // metres the loco head has advanced from origin
  phase: 'run-in' | 'dwell' | 'run-out';
  dwellT: number;
}

// ---------------------------------------------------------------------------
// Crane hoist — a container box that rides up/down + trolleys in/out at each
// STS crane, so the cranes look like they are actually working boxes.
// ---------------------------------------------------------------------------

interface Hoist {
  g: Graphic;
  base: LngLat; // crane ground position (box stays vertically aligned here)
  phase: number; // animation phase offset
}

interface TugMover {
  g: Graphic;
  a: LngLat; // patrol leg endpoints
  b: LngLat;
  u: number; // 0..1 along the leg
  dir: 1 | -1; // ping-pong direction
  speed: number; // m/s
}

export interface SceneAnim {
  layers: GraphicsLayer[];
  /**
   * Advance all movers. `t` = elapsed seconds (for phase-based motion: crane
   * hoist, rake dwell); `dt` = seconds since the previous frame (for constant-
   * speed motion: trucks, rake travel), so speeds are per-SECOND not per-FRAME.
   */
  tick: (t: number, dt: number) => void;
  /** Update per-gate queue so truck speed reflects congestion (call on sim change). */
  setGateQueues: (gateOps: GateOpsDTO[]) => void;
  destroy: () => void;
}

/**
 * Build the animation layers + a tick(). `reduced` renders everything at its
 * rest pose but the caller simply stops advancing `t` — we still build the
 * movers so the scene is populated (static trucks/rake), just not moving.
 */
export function buildSceneAnim(terminals: Terminal[], gateOps: GateOpsDTO[]): SceneAnim {
  // Trucks + rake ride on the ground; the crane hoist box rides UP a cable, so
  // its layer must honour the graphic's `z` (relative-to-ground) — an on-the-
  // ground layer would clamp the box to the surface and it would never lift.
  const truckLayer = new GraphicsLayer({ title: '3D · Trucks (live)', listMode: 'hide', elevationInfo: { mode: 'on-the-ground' } });
  const railLayer = new GraphicsLayer({ title: '3D · Rail rake (live)', listMode: 'hide', elevationInfo: { mode: 'on-the-ground' } });
  const craneLayer = new GraphicsLayer({ title: '3D · Crane hoists (live)', listMode: 'hide', elevationInfo: { mode: 'relative-to-ground' } });

  const gateQueue = new Map<string, number>();
  for (const g of gateOps) gateQueue.set(g.gateId, g.queueLength);

  // ---- trucks: 2 per operating terminal, staggered along the loop ----
  const trucks: TruckMover[] = [];
  const opTerminals = terminals.filter((t) => t.geom.type === 'Point' && t.status === 'OPERATING');
  opTerminals.forEach((t, ti) => {
    // Per request: remove NSICT's two route trucks (blue container-truck + yellow
    // truck) that travel beside the T1 rail rake. Every other terminal's trucks
    // (and their index `ti`) are unchanged.
    if (t.terminalId === 'NSICT') return;
    // Preferred: a user-TRACED route polyline (waypoints clicked on the satellite
    // imagery) — the trucks follow the real roads exactly. Falls back to the
    // synthetic quay-frame loop (anchor-drag + rotate) when no path is drawn.
    const rkey = `truckroute:${t.terminalId}`;
    const drawn = placementStore.getPath(rkey);
    let wps: LngLat[];
    const usingDrawn = !!(drawn && drawn.length >= 2);
    if (usingDrawn) {
      wps = drawn!.map((p) => [p[0], p[1]] as LngLat);
    } else {
      const [tlng, tlat] = (t.geom as { coordinates: [number, number] }).coordinates;
      const routeAnchor = place(tlng, tlat, 0, 620);
      const tr = anchorTransform(rkey, routeAnchor, QUAY_BEARING_DEG);
      wps = truckRoute(t).map((p) => applyAnchor(p, tr));
    }
    const gateId = t.gates[0] ?? `${t.terminalId}-G1`;
    const perTerminal = 2;
    for (let k = 0; k < perTerminal; k++) {
      // Two vehicle types: the heavy truck (truck-realistic) is unchanged; only the former
      // light-pickup slot now uses the blue container truck. Spawn/route/heading/speed/scale
      // logic below is unchanged.
      const model: string = (ti + k) % 3 === 0 ? 'container-truck' : 'truck-realistic';
      const start = at(wps, 0);
      const g = new Graphic({
        geometry: new Point({ longitude: start[0], latitude: start[1], spatialReference: { wkid: 4326 } }),
        symbol: objectSymbol(`${MODELS}/${model}.glb`, model === 'pickup-realistic' ? 5 : 8, QUAY_BEARING_DEG),
        attributes: { kind: 'truck-live', gateId },
      });
      truckLayer.add(g);
      trucks.push({
        g,
        wps,
        seg: (ti + k) % wps.length,
        u: (k / perTerminal + ti * 0.17) % 1,
        // Yard-truck pace: ~5–7 m/s (≈18–25 km/h), realistic for internal port roads.
        speed: 5 + ((ti + k) % 3) * 0.8,
        gateId,
        model,
        custom: usingDrawn,
      });
    }
  });

  // ---- rail rake on siding T1 (the central yard siding) ----
  const rakes: Rake[] = [];
  const t1 = terminals.find((t) => t.geom.type === 'Point'); // fallback anchor
  // Siding centroids live in config; we approximate the rake origin off the
  // GTI/central cluster along the quay bearing. Use the first terminal's frame.
  if (t1) {
    const [lng, lat] = (t1.geom as { coordinates: [number, number] }).coordinates;
    // A rail line ~700 m inland, parallel to the quay. A `rake:T1` override drags
    // the whole track origin and rotates its axis (direction of travel).
    const defaultOrigin = place(lng, lat, 400, 700);
    const rakeTr = anchorTransform('rake:T1', defaultOrigin, QUAY_BEARING_DEG);
    const origin = applyAnchor(defaultOrigin, rakeTr);
    const axisDeg = (QUAY_BEARING_DEG + rakeTr.rotDeg) % 360; // rake runs along the (possibly rotated) axis
    const cars: RakeCar[] = [];
    // loco + 8 wagons (alternating flat wagon / container wagon), ~18 m each.
    const CAR_LEN = 18;
    for (let i = 0; i < 9; i++) {
      const model = i === 0 ? 'rail-loco' : i % 2 === 0 ? 'rail-container' : 'rail-wagon';
      const height = i === 0 ? 7 : 6;
      const g = new Graphic({
        geometry: new Point({ longitude: origin[0], latitude: origin[1], spatialReference: { wkid: 4326 } }),
        symbol: objectSymbol(`${MODELS}/${model}.glb`, height, axisDeg + RAKE_MODEL_OFFSET),
        attributes: { kind: 'rake-live', car: i },
      });
      railLayer.add(g);
      cars.push({ g, offsetM: i * CAR_LEN });
    }
    rakes.push({ cars, origin, axisDeg, headM: 0, phase: 'run-in', dwellT: 0 });
  }

  // ---- tug: a harbour tug patrolling the channel, seaward of the quays ----
  // Anchored at `tug`; the override drags + rotates its patrol beat. It idles
  // back and forth along a short seaward leg so it reads as a working craft.
  const tugLayer = new GraphicsLayer({ title: '3D · Tug (live)', listMode: 'hide', elevationInfo: { mode: 'on-the-ground' } });
  let tug: TugMover | null = null;
  {
    const anchorT = terminals.find((t) => t.geom.type === 'Point' && t.status === 'OPERATING') ?? terminals[0];
    if (anchorT && anchorT.geom.type === 'Point') {
      const [lng, lat] = (anchorT.geom as { coordinates: [number, number] }).coordinates;
      const defaultAnchor = place(lng, lat, 0, -520); // out in the channel
      const tr = anchorTransform('tug', defaultAnchor, QUAY_BEARING_DEG);
      // Patrol leg: ~180 m along the quay bearing, centred on the anchor.
      const legA = applyAnchor(place(lng, lat, -90, -520), tr);
      const legB = applyAnchor(place(lng, lat, 90, -520), tr);
      const g = new Graphic({
        geometry: new Point({ longitude: legA[0], latitude: legA[1], spatialReference: { wkid: 4326 } }),
        symbol: objectSymbol(`${MODELS}/boat-tug-a.glb`, 10, QUAY_BEARING_DEG),
        attributes: { kind: 'tug-live' },
      });
      tugLayer.add(g);
      tug = { g, a: legA, b: legB, u: 0, dir: 1, speed: 4 };
    }
  }

  // ---- crane hoists: one working box per operating terminal's mid crane ----
  // The box MUST sit at its crane. Cranes are placed from their positions.json
  // overrides (crane:<T>:<i>), which can be ~1 km from the terminal geom; the box
  // was previously anchored to the geom, so it floated in mid-air detached from
  // any crane. Anchor it to the mid crane's real position so it rides up over a
  // crane (the intended STS animation), not alone over the terminal.
  const hoists: Hoist[] = [];
  opTerminals.forEach((t, ti) => {
    // Per request: all crane hoist boxes removed (NSIGT green, GTI purple,
    // NSICT + JNPCT blue, BMCT orange).
    if (t.terminalId === 'NSIGT' || t.terminalId === 'GTI' || t.terminalId === 'NSICT' || t.terminalId === 'JNPCT' || t.terminalId === 'BMCT') return;
    const [lng, lat] = (t.geom as { coordinates: [number, number] }).coordinates;
    const quay = t.quayLengthM ?? 800;
    const nCranes = Math.max(3, Math.min(9, Math.round(quay / 200)));
    const midI = Math.floor(nCranes / 2);
    const midAlongM = ((midI + 0.5) / nCranes - 0.5) * quay;
    const ov = placementStore.get(`crane:${t.terminalId}:${midI}`);
    // Mid-crane position: its placement override if dragged, else the derived spot.
    const base: LngLat = ov ? [ov.lng, ov.lat] : place(lng, lat, midAlongM, 30);
    const g = new Graphic({
      geometry: new Point({ longitude: base[0], latitude: base[1], spatialReference: { wkid: 4326 } }),
      symbol: boxSymbol(craneBoxColor(ti), 12, 5, 5, QUAY_BEARING_DEG),
      attributes: { kind: 'hoist-live' },
    });
    craneLayer.add(g);
    hoists.push({ g, base, phase: ti * 1.3 });
  });

  // -----------------------------------------------------------------------

  function setGateQueues(next: GateOpsDTO[]) {
    for (const g of next) gateQueue.set(g.gateId, g.queueLength);
  }

  function tick(t: number, dt: number) {
    // Rail-rake track footprint (the static line the train shunts along). Any
    // yard truck rendering within ~40 m of it is clipped below, so the fleet
    // never draws on/beside the train. Only NSIGT/GTI routes ever reach it; every
    // other terminal's trucks (403 m–1.2 km away) are never affected.
    const rk0 = rakes[0];
    const railA = rk0?.origin;
    const railB = rk0 ? advance(rk0.origin, (rk0.axisDeg * Math.PI) / 180, 220) : null;
    // --- trucks ---
    for (const tr of trucks) {
      const a = at(tr.wps, tr.seg);
      const b = at(tr.wps, tr.seg + 1);
      const segLenM = metresBetween(a, b) || 1;
      // Trucks slow near the gate when its queue is long (congestion is visible).
      // Only for the synthetic route, whose seg indices 1/2/6 are the gate area;
      // a user-drawn path has arbitrary seg indices, so skip the slowdown there.
      const nearGate = !tr.custom && (tr.seg === 1 || tr.seg === 2 || tr.seg === 6);
      const q = gateQueue.get(tr.gateId) ?? 6;
      const speed = nearGate ? tr.speed * Math.max(0.25, 6 / Math.max(6, q)) : tr.speed;
      // metres this frame = speed(m/s) × dt(s); ÷ segment length → fraction of seg.
      tr.u += (speed * dt) / segLenM;
      while (tr.u >= 1) {
        tr.u -= 1;
        tr.seg = (tr.seg + 1) % tr.wps.length;
      }
      const cur = at(tr.wps, tr.seg);
      const nxt = at(tr.wps, tr.seg + 1);
      const lng = cur[0] + (nxt[0] - cur[0]) * tr.u;
      const lat = cur[1] + (nxt[1] - cur[1]) * tr.u;
      tr.g.geometry = new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } });
      const heading = (headingBetween(cur, nxt) + TRUCK_MODEL_OFFSET) % 360;
      tr.g.symbol = objectSymbol(`${MODELS}/${tr.model}.glb`, tr.model === 'pickup-realistic' ? 5 : 8, heading);
      // Clip: hide this truck only while it would render over the train track,
      // so no yard truck appears on/beside the rake. Trucks elsewhere are shown.
      tr.g.visible = !(railA != null && railB != null && distPtSegM([lng, lat], railA, railB) < 40);
    }

    // --- rail rake: run in ~220 m, dwell, run out (slow shunting pace) ---
    for (const rk of rakes) {
      const SPAN = 220;
      const RUN_SPEED = 3; // m/s — a rake creeps onto a siding
      if (rk.phase === 'run-in') {
        rk.headM += RUN_SPEED * dt;
        if (rk.headM >= SPAN) {
          rk.headM = SPAN;
          rk.phase = 'dwell';
          rk.dwellT = t;
        }
      } else if (rk.phase === 'dwell') {
        if (t - rk.dwellT > 10) rk.phase = 'run-out';
      } else {
        rk.headM += RUN_SPEED * dt;
        if (rk.headM >= SPAN * 2 + 180) {
          rk.headM = 0;
          rk.phase = 'run-in';
        }
      }
      const brg = (rk.axisDeg * Math.PI) / 180;
      for (const car of rk.cars) {
        const d = rk.headM - car.offsetM;
        // Advance the car d metres along the axis from origin.
        const [lng, lat] = advance(rk.origin, brg, d);
        car.g.geometry = new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } });
      }
    }

    // --- crane hoists: box rides straight up/down, locked to its crane's XY so
    //     it stays vertically aligned with the crane and never detaches. ---
    for (const h of hoists) {
      const p = (t * 0.6 + h.phase) % (Math.PI * 2);
      const lift = 8 + (Math.cos(p * 2) * 0.5 + 0.5) * 26; // box rides up and down
      h.g.geometry = new Point({ longitude: h.base[0], latitude: h.base[1], z: lift, spatialReference: { wkid: 4326 } });
    }

    // --- tug: ping-pong along its patrol leg, facing its travel direction ---
    if (tug) {
      const legLen = metresBetween(tug.a, tug.b) || 1;
      tug.u += (tug.dir * tug.speed * dt) / legLen;
      if (tug.u >= 1) { tug.u = 1; tug.dir = -1; }
      else if (tug.u <= 0) { tug.u = 0; tug.dir = 1; }
      const lng = tug.a[0] + (tug.b[0] - tug.a[0]) * tug.u;
      const lat = tug.a[1] + (tug.b[1] - tug.a[1]) * tug.u;
      tug.g.geometry = new Point({ longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } });
      const from = tug.dir === 1 ? tug.a : tug.b;
      const to = tug.dir === 1 ? tug.b : tug.a;
      tug.g.symbol = objectSymbol(`${MODELS}/boat-tug-a.glb`, 10, (headingBetween(from, to) + 90) % 360);
    }
  }

  function destroy() {
    truckLayer.removeAll();
    railLayer.removeAll();
    craneLayer.removeAll();
    tugLayer.removeAll();
  }

  return { layers: [truckLayer, railLayer, craneLayer, tugLayer], tick, setGateQueues, destroy };
}

// ---- small metric helpers (match scene3d's LAT-based scale) ----------------

const M_PER_DEG_LAT = 110_574;
const LAT0 = 18.945;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

function metresBetween(a: LngLat, b: LngLat): number {
  const e = (b[0] - a[0]) * M_PER_DEG_LON;
  const n = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(e, n);
}

/** Advance `d` metres from `p` along compass bearing `brg` (radians). */
function advance(p: LngLat, brg: number, d: number): LngLat {
  const e = Math.sin(brg) * d;
  const n = Math.cos(brg) * d;
  return [p[0] + e / M_PER_DEG_LON, p[1] + n / M_PER_DEG_LAT];
}

/** Distance (m) from point `p` to segment `a`–`b`, in the local metric frame. */
function distPtSegM(p: LngLat, a: LngLat, b: LngLat): number {
  const ax = (a[0] - p[0]) * M_PER_DEG_LON_C, ay = (a[1] - p[1]) * M_PER_DEG_LAT_C;
  const bx = (b[0] - p[0]) * M_PER_DEG_LON_C, by = (b[1] - p[1]) * M_PER_DEG_LAT_C;
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy || 1;
  const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L));
  return Math.hypot(ax + u * dx, ay + u * dy);
}

/** Hoist-box colour per terminal, cycling the flow-stream palette. */
function craneBoxColor(i: number): number[] {
  const palette = [
    tokens.flow.IMPORT,
    tokens.flow.EXPORT,
    tokens.flow.TRANSSHIP,
    tokens.flow.ITRHO,
  ];
  return hexToRgb(palette[i % palette.length] ?? tokens.flow.IMPORT);
}

function hexToRgb(hex: string): number[] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 0.95];
}

