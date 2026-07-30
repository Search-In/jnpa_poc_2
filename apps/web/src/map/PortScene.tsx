/**
 * PortScene — the 3D sea-port view (ArcGIS SceneView / WebGL). This is the 3D
 * toggle-mode counterpart to PortMap: same props, same sim-driven live data,
 * same in-place layer diffing, but rendered as a georeferenced 3D scene with
 * extruded quay decks, pendency-driven yard stacks, STS cranes, berthed vessels,
 * gate kiosks and a navigation channel (see scene3d.ts).
 *
 * Design borrowed from the reference twinship-3d-visualizer: an interactive 3D
 * canvas where selecting an asset frames the camera on it and shows details, and
 * an explorer tree stays in sync. Here that selection is exposed via an imperative
 * handle so the AssetExplorer tree (rendered by the dashboard) can drive the camera.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Map from '@arcgis/core/Map';
import SceneView from '@arcgis/core/views/SceneView';
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LayerList from '@arcgis/core/widgets/LayerList';
import Legend from '@arcgis/core/widgets/Legend';
import Expand from '@arcgis/core/widgets/Expand';
import { initialBasemap, installBasemapFallback, isOfflineRequested } from './basemapFallback.js';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, LiveVesselDTO, PendencyDTO } from '@jnpa/data';
import { applyGraphics } from './layers.js';
import {
  terminalDeckLayer,
  yardStackLayer,
  craneLayer,
  vesselLayer,
  liveVesselLayer,
  gate3dLayer,
  cctvLayer,
  railTrackLayer,
  truckLayer,
  channelLayer,
  congestionLayer,
  trafficLayer,
  spotlight3dLayer,
  spotlight3dGraphics,
  selectionLayer,
  selectionRing,
  yardHighlightGraphics,
  yardAssetPosition,
  routeDrawLayer,
  routeDrawGraphics,
  pickLayer,
  asset3dPosition,
  graphicsFor3d,
} from './scene3d.js';
import { buildSceneAnim, type SceneAnim } from './sceneAnim.js';
import { placementStore } from './placementStore.js';
import { tokens } from '../theme/tokens.js';

/** How often the road-traffic overlay is recoloured (ms). Not per frame. */
const TRAFFIC_REFRESH_MS = 3000;

/** Yard focus: closer and a touch flatter than a normal pick, over a longer beat. */
const YARD_FOCUS_ZOOM = 18;
const YARD_FOCUS_TILT = 58;
const YARD_FOCUS_MS = 1400;
/** Glide back out to the pre-focus camera when the yard is closed. */
const YARD_RETURN_MS = 1200;
/** Gateway base URL — same as VITE_GATEWAY_URL or falls back to relative /api. */
const GATEWAY_BASE = (import.meta as unknown as { env: Record<string, string> }).env?.VITE_GATEWAY_URL?.replace(/\/$/, '') ?? '';

async function fetchLiveVessels(): Promise<LiveVesselDTO[]> {
  const url = `${GATEWAY_BASE}/api/marine/vessels/live`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Live vessels fetch failed: ${res.status}`);
  return res.json() as Promise<LiveVesselDTO[]>;
}

/** Respect the OS "reduce motion" setting — freeze the animation clock if set. */
const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface PortSceneProps {
  facilities: Facility[];
  terminals: Terminal[];
  gateOps: GateOpsDTO[];
  pendency: PendencyDTO[];
  /** Live vessel positions from marine API (MMSI, name, lat, lon, course). */
  liveVessels?: Array<{ mmsi: string; vessel_name: string; lat: number; lon: number; course: number }>;
  /** Asset ids the simulator is driving — drawn with a 3D spotlight beam. */
  highlights?: string[];
  /**
   * Notify the parent when the user clicks an asset in the 3D scene. `pkey` is the
   * movable-asset placement key (vessel/crane/gate/yard) when the hit asset has
   * one, so the parent can open that asset's transform editor directly.
   */
  onSelect?: (assetId: string | null, pkey?: string) => void;
  /** Placement edit mode — a map click moves the selected asset to that spot. */
  editing?: boolean;
  /** The placement key of the asset to move on the next map click (from the tree). */
  movePkey?: string | null;
  /**
   * Route-draw mode: when set to a `truckroute:<T>` key, a map click APPENDS a
   * waypoint to that route's traced path (instead of moving an asset). Lets the
   * user trace the truck route along the real roads in the satellite imagery.
   */
  drawRouteKey?: string | null;
  /** Fired after a placement lands (so the parent can update the export count). */
  onPlacementsChanged?: () => void;
}

/** Named cinematic camera viewpoints (the template's OVERVIEW/CHANNEL/… presets). */
export type CameraPreset = 'overview' | 'channel' | 'gate' | 'rail' | 'crane';

/** Time-of-day lighting for the scene ("day" sun vs low golden "dusk"). */
export type Lighting = 'day' | 'dusk';

/** Imperative handle the AssetExplorer uses to fly the 3D camera to an asset. */
export interface PortSceneHandle {
  focus: (assetId: string) => void;
  clearSelection: () => void;
  /** Rebuild the operational layers from current data + placement overrides. */
  rebuild: () => void;
  /** Rebuild ONLY the layer(s) for one asset — instant per-asset move/rotate. */
  rebuildOne: (pkey: string) => void;
  /** Redraw the route-trace preview from the store (after undo/clear). */
  refreshRouteDraw: () => void;
  /** Fly the camera to a named cinematic viewpoint. */
  goToPreset: (preset: CameraPreset) => void;
  /** Switch scene lighting between bright day and golden dusk. */
  setLighting: (mode: Lighting) => void;
}

/**
 * Resolve a hit-test result to the clicked asset's { id, pkey }. `id` is the
 * focus/asset3dPosition key (terminalId/gateId/craneId/…); `pkey` is the movable
 * placement key (vessel/crane/gate/yard) carried on the graphic — used to open
 * that asset's transform editor. Yard-stack tiers only carry `pkey` on the base
 * tier, so we derive the id from `blockId`. Returns null if nothing pickable.
 */
function resolveHit(res: { results: Array<unknown> }): { id: string; pkey?: string } | null {
  // Prefer the topmost graphic that carries a usable id.
  for (const r of res.results) {
    const graphic = (r as { graphic?: { attributes?: Record<string, unknown> } }).graphic;
    if (!graphic) continue;
    const a = (graphic.attributes ?? {}) as Record<string, unknown>;
    // A pick marker carries pkey + pickId directly — the reliable click target.
    if (a.pickId && a.pkey) return { id: a.pickId as string, pkey: a.pkey as string };
    const id =
      (a.terminalId as string) ??
      (a.gateId as string) ??
      (a.facilityId as string) ??
      (a.craneId as string) ??
      (a.vesselId as string) ??
      (a.blockId as string) ??
      null;
    if (!id) continue;
    // pkey directly on the graphic (vessel/crane/gate + base yard tier), else
    // derive it for kinds where an upper tier / feature dropped it.
    let pkey = (a.pkey as string) || undefined;
    if (!pkey && a.gateId) pkey = `gate3d:${a.gateId as string}`;
    if (!pkey && a.blockId && a.terminalId) {
      // blockId "NSICT-Y3" → pkey "yard:NSICT:2" (Y is 1-indexed).
      const m = String(a.blockId).match(/-Y(\d+)$/);
      if (m) pkey = `yard:${a.terminalId as string}:${Number(m[1]) - 1}`;
    }
    // A gate graphic carries BOTH gateId and terminalId, so the generic order
    // above reports the TERMINAL. That selected the terminal's tree row — which
    // is reference-only and has no pkey — and the transform panel promptly closed
    // again, which is why Edit appeared not to work on gates. A gate identifies as
    // itself. (Vessels keep using terminalId: asset3dPosition keys them that way.)
    if (pkey?.startsWith('gate3d:')) return { id: pkey.slice('gate3d:'.length), pkey };
    return { id, ...(pkey ? { pkey } : {}) };
  }
  return null;
}

/** Live value resolver so the spotlight label shows the exact driven number. */
function makeValueOf(gateOps: GateOpsDTO[], pendency: PendencyDTO[]): (id: string) => string | undefined {
  const gate: Record<string, number> = {};
  for (const g of gateOps) gate[g.gateId] = g.queueLength;
  const pend: Record<string, number> = {};
  for (const p of pendency) pend[p.facilityId] = p.pendency;
  return (id: string) => {
    if (id in gate) return `${gate[id]} q`;
    if (id in pend) return `${pend[id]}`;
    return undefined;
  };
}

export const PortScene = forwardRef<PortSceneHandle, PortSceneProps>(function PortScene(props, ref) {
  const [showLiveVessels, setShowLiveVessels] = useState(false);
  const [liveVesselError, setLiveVesselError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const layersRef = useRef<{
    decks: FeatureLayer;
    yards: FeatureLayer;
    cranes: FeatureLayer;
    vessels: FeatureLayer;
    liveVessels: GraphicsLayer;
    gates: FeatureLayer;
    trucks: FeatureLayer;
    channel: FeatureLayer;
    congestion: FeatureLayer;
    traffic: FeatureLayer;
    picks: FeatureLayer;
  } | null>(null);
  const spotlightRef = useRef<FeatureLayer | null>(null);
  const selectionRef = useRef<GraphicsLayer | null>(null);
  const mapRef = useRef<Map | null>(null);
  const animRef = useRef<SceneAnim | null>(null);
  const animRebuildPending = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);
  const trafficTimerRef = useRef<number | null>(null);
  // Camera pose captured before the first yard was opened, so closing can return.
  const preFocusCameraRef = useRef<__esri.Camera | null>(null);
  const animClockRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const lastZoomKey = useRef<string>('');
  const propsRef = useRef(props);
  propsRef.current = props;
  // Latest editing flag + the asset to move, readable inside the once-registered
  // click handler (which is created only on mount).
  const editingRef = useRef<boolean>(!!props.editing);
  editingRef.current = !!props.editing;
  const movePkeyRef = useRef<string | null>(props.movePkey ?? null);
  movePkeyRef.current = props.movePkey ?? null;
  const drawRouteRef = useRef<string | null>(props.drawRouteKey ?? null);
  drawRouteRef.current = props.drawRouteKey ?? null;
  // A GraphicsLayer that previews the route being traced (line + waypoint dots).
  const routeDrawRef = useRef<GraphicsLayer | null>(null);

  // Re-apply every operational layer's graphics from current data — picks up any
  // placement overrides so a dragged asset (and its followers) move immediately.
  function rebuildLayers() {
    const layers = layersRef.current;
    const p = propsRef.current;
    if (!layers) return;
    void applyGraphics(layers.channel, graphicsFor3d.channel(p.terminals));
    void applyGraphics(layers.decks, graphicsFor3d.decks(p.terminals));
    void applyGraphics(layers.yards, graphicsFor3d.yards(p.terminals, p.pendency));
    void applyGraphics(layers.cranes, graphicsFor3d.cranes(p.terminals));
    void applyGraphics(layers.vessels, graphicsFor3d.vessels(p.terminals));
    void applyGraphics(layers.gates, graphicsFor3d.gates(p.gateOps, p.terminals));
    void applyGraphics(layers.trucks, graphicsFor3d.trucks(p.gateOps, p.terminals));
    void applyGraphics(layers.congestion, graphicsFor3d.congestion(p.gateOps, p.terminals));
    void applyGraphics(layers.picks, graphicsFor3d.picks(p.terminals, p.gateOps));
    refreshTraffic();
    rebuildAnim();
  }

  /**
   * Recolour the road network from current vehicle positions. Called on a sim tick
   * and on a slow interval (TRAFFIC_REFRESH_MS) — never per frame. The moving
   * trucks are read straight off the live animation layer, so the overlay follows
   * real vehicle density rather than a synthetic pattern; sceneAnim itself is not
   * touched, we only read the graphics it has already produced.
   */
  function refreshTraffic() {
    const layers = layersRef.current;
    const p = propsRef.current;
    if (!layers) return;
    const movers: [number, number][] = [];
    for (const layer of animRef.current?.layers ?? []) {
      if (layer.title !== '3D · Trucks (live)') continue;
      for (const g of layer.graphics.toArray()) {
        if (g.visible === false) continue;
        const geo = g.geometry as unknown as { longitude?: number; latitude?: number };
        if (typeof geo?.longitude === 'number' && typeof geo?.latitude === 'number') {
          movers.push([geo.longitude, geo.latitude]);
        }
      }
    }
    void applyGraphics(layers.traffic, graphicsFor3d.traffic(p.gateOps, p.terminals, movers));
  }

  // Redraw the route-trace preview (line + numbered dots) for the route being
  // drawn, from the placement store's current path. Empty layer when not drawing.
  function refreshRouteDraw() {
    const layer = routeDrawRef.current;
    if (!layer) return;
    layer.removeAll();
    const key = drawRouteRef.current;
    if (!key) return;
    const path = placementStore.getPath(key) ?? [];
    for (const g of routeDrawGraphics(path)) layer.add(g);
  }

  // Rebuild ONLY the layer(s) affected by a single asset's placement change, so a
  // rotate/nudge shows on the map INSTANTLY without re-applying all 8 layers +
  // the whole animation. Called on every control tick from the transform panel.
  function rebuildOne(pkey: string) {
    const layers = layersRef.current;
    const p = propsRef.current;
    if (!layers) return;
    const kind = pkey.split(':')[0];
    switch (kind) {
      case 'vessel':
        void applyGraphics(layers.vessels, graphicsFor3d.vessels(p.terminals));
        break;
      case 'crane':
        void applyGraphics(layers.cranes, graphicsFor3d.cranes(p.terminals));
        break;
      case 'yard':
        void applyGraphics(layers.yards, graphicsFor3d.yards(p.terminals, p.pendency));
        break;
      case 'gate3d':
        // A gate move drags its truck queue + congestion patch with it.
        void applyGraphics(layers.gates, graphicsFor3d.gates(p.gateOps, p.terminals));
        void applyGraphics(layers.trucks, graphicsFor3d.trucks(p.gateOps, p.terminals));
        void applyGraphics(layers.congestion, graphicsFor3d.congestion(p.gateOps, p.terminals));
        break;
      case 'truckroute':
      case 'rake':
      case 'tug':
        // Live movers bake their anchor at build time → rebuild the anim only.
        rebuildAnim();
        break;
      default:
        rebuildLayers();
    }
    // Move the pick marker with the asset (vessel/crane/gate/yard have markers).
    if (kind === 'vessel' || kind === 'crane' || kind === 'yard' || kind === 'gate3d') {
      void applyGraphics(layers.picks, graphicsFor3d.picks(p.terminals, p.gateOps));
    }
  }

  // Rebuild the live-motion layers (trucks/rake/tug) so moving a route/rake/tug
  // ANCHOR (truckroute:<T> / rake:T1 / tug placement override) takes effect — the
  // anim bakes overrides in at build time, so we tear it down and rebuild it.
  // Coalesced to one rebuild per frame so a fast slider drag on a mover anchor
  // doesn't tear down + rebuild the whole animation dozens of times a second.
  function rebuildAnim() {
    if (animRebuildPending.current) return;
    animRebuildPending.current = true;
    requestAnimationFrame(() => {
      animRebuildPending.current = false;
      const map = mapRef.current;
      const p = propsRef.current;
      if (!map) return;
      const old = animRef.current;
      if (old) {
        map.removeMany(old.layers);
        old.destroy();
      }
      const next = buildSceneAnim(p.terminals, p.gateOps);
      animRef.current = next;
      map.addMany(next.layers);
    });
  }

  // ---- imperative camera focus, shared by explorer clicks + internal picks ----
  function focusAsset(assetId: string) {
    const view = viewRef.current;
    const sel = selectionRef.current;
    if (!view) return;

    // Handle live vessels (from API data)
    if (assetId.startsWith('LIVE-')) {
      const liveLayer = layersRef.current?.liveVessels;
      if (liveLayer) {
        for (const graphic of liveLayer.graphics) {
          if (graphic.attributes?.vesselId === assetId) {
            const pt = graphic.geometry as { longitude: number; latitude: number };
            const lng = pt.longitude;
            const lat = pt.latitude;
            if (sel) {
              sel.removeAll();
              sel.add(selectionRing(lng, lat));
            }
            void view
              .goTo({ target: { type: 'point', longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }, tilt: 62, zoom: 17 } as never, {
                duration: 900,
                easing: 'ease-in-out',
              })
              .catch(() => { /* interrupted — fine */ });
            return;
          }
        }
      }
      return;
    }

    const pos = asset3dPosition(propsRef.current.facilities, propsRef.current.terminals);
    // Yard blocks are not in asset3dPosition (it keys terminals, gates, facilities
    // and the live movers), so resolve them from their own placement key.
    const p = pos.get(assetId) ?? yardAssetPosition(assetId, propsRef.current.terminals) ?? undefined;
    if (!p) return;
    const [lng, lat] = p;
    // One highlight at a time: removeAll() clears whatever was selected before, so
    // picking another yard swaps the outline and clearSelection() drops it.
    const yard = yardHighlightGraphics(assetId, propsRef.current.terminals);
    const isYard = yard.length > 0;
    if (sel) {
      sel.removeAll();
      // A yard block gets its AREA outlined; every other asset keeps the amber
      // pick ring exactly as before (a 90 m ring would swamp a ~20 m yard bay).
      if (isYard) for (const g of yard) sel.add(g);
      else sel.add(selectionRing(lng, lat));
    }
    // Diving into a yard remembers where the camera was, so closing the yard can
    // fly back to it. Only the FIRST dive stores it, so hopping between yards
    // still returns to wherever browsing started. Focusing anything else drops it.
    if (isYard) {
      if (!preFocusCameraRef.current && view.camera) preFocusCameraRef.current = view.camera.clone();
    } else {
      preFocusCameraRef.current = null;
    }
    // Same goTo the scene has always used — a yard just gets a closer, slightly
    // flatter framing over a longer beat, because a bay is ~20 m across.
    void view
      .goTo(
        {
          target: { type: 'point', longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } },
          tilt: isYard ? YARD_FOCUS_TILT : 62,
          zoom: isYard ? YARD_FOCUS_ZOOM : 17,
        } as never,
        { duration: isYard ? YARD_FOCUS_MS : 900, easing: 'ease-in-out' },
      )
      .catch(() => {
        /* goTo rejects if interrupted by a newer animation — fine */
      });
  }

  /**
   * Leave yard focus: drop the highlight and glide back to the camera pose the
   * scene held before the first yard was opened. No-op (beyond clearing the
   * highlight) if we never entered a yard, so every other asset is unaffected.
   */
  function clearYardFocus() {
    selectionRef.current?.removeAll();
    const view = viewRef.current;
    const previous = preFocusCameraRef.current;
    preFocusCameraRef.current = null;
    if (!view || !previous) return;
    void view.goTo(previous, { duration: YARD_RETURN_MS, easing: 'ease-in-out' }).catch(() => {
      /* interrupted by a newer animation — fine */
    });
  }

  // ---- cinematic camera presets (the template's OVERVIEW/CHANNEL/…) ----------
  // Each preset is a camera pose (position + heading/tilt) computed from real
  // terminal geography, so "GATE" actually frames the gates, "RAIL" the sidings,
  // etc. — not arbitrary coordinates.
  function goToPreset(preset: CameraPreset) {
    const view = viewRef.current;
    if (!view) return;
    const terms = propsRef.current.terminals.filter((t) => t.geom.type === 'Point');
    if (terms.length === 0) return;
    const coords = terms.map((t) => (t.geom as { coordinates: [number, number] }).coordinates);
    const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    // Poses tuned to the ~208° quay bearing (water SW, land NE).
    const POSES: Record<CameraPreset, { dLng: number; dLat: number; z: number; heading: number; tilt: number }> = {
      overview: { dLng: -0.012, dLat: -0.010, z: 1300, heading: 42, tilt: 68 },
      channel: { dLng: -0.020, dLat: -0.014, z: 700, heading: 32, tilt: 78 }, // low over the water looking up-channel
      gate: { dLng: 0.006, dLat: 0.004, z: 500, heading: 220, tilt: 74 }, // inland, looking seaward across the gates
      rail: { dLng: 0.010, dLat: 0.002, z: 550, heading: 250, tilt: 76 }, // over the sidings
      crane: { dLng: -0.006, dLat: -0.004, z: 420, heading: 50, tilt: 82 }, // tight on the crane line
    };
    const p = POSES[preset];
    void view
      .goTo(
        { position: { longitude: cx + p.dLng, latitude: cy + p.dLat, z: p.z }, heading: p.heading, tilt: p.tilt } as never,
        { duration: 1100, easing: 'ease-in-out' },
      )
      .catch(() => {
        /* interrupted — fine */
      });
  }

  function setLighting(mode: Lighting) {
    const view = viewRef.current;
    if (!view) return;
    const env = view.environment as unknown as {
      lighting?: { type?: string; date?: Date; directShadowsEnabled?: boolean };
      atmosphere?: { quality?: string };
      atmosphereEnabled?: boolean;
    };
    // Day = midday sun; dusk = low golden light. Fixed dates keep it deterministic
    // (no Date.now()); ArcGIS positions the sun from date+scene location.
    const when = mode === 'dusk' ? new Date('2026-06-16T12:45:00Z') /* ~18:15 IST */ : new Date('2026-06-16T06:30:00Z') /* ~12:00 IST */;
    if (env.lighting) {
      env.lighting.type = 'sun';
      env.lighting.date = when;
      env.lighting.directShadowsEnabled = true;
    }
  }

  useImperativeHandle(ref, () => ({
    focus: focusAsset,
    clearSelection: clearYardFocus,
    rebuild: rebuildLayers,
    rebuildOne,
    refreshRouteDraw,
    goToPreset,
    setLighting,
  }), []);

  // ---- init: build the scene view + 3D layers + widgets ONCE ----
  useEffect(() => {
    if (!containerRef.current) return;
    const p0 = propsRef.current;

    // Basemap + ground survive ArcGIS token death / no-Wi-Fi (spec §3): online
    // 'hybrid' + world-elevation normally, but offline uses the bundled local
    // base and flat ground (both online sources fetch tiles that need a token).
    const offline = isOfflineRequested();
    const map = new Map({
      basemap: initialBasemap(),
      ...(offline ? {} : { ground: 'world-elevation' }),
    });
    mapRef.current = map;

    // Build 3D layers once; the data effect edits features in place thereafter.
    const layers = {
      channel: channelLayer(p0.terminals),
      decks: terminalDeckLayer(p0.terminals),
      yards: yardStackLayer(p0.terminals, p0.pendency),
      cranes: craneLayer(p0.terminals),
      vessels: vesselLayer(p0.terminals),
      liveVessels: liveVesselLayer(),
      gates: gate3dLayer(p0.gateOps, p0.terminals),
      trucks: truckLayer(p0.gateOps, p0.terminals),
      congestion: congestionLayer(p0.gateOps, p0.terminals),
      traffic: trafficLayer(p0.gateOps, p0.terminals),
      picks: pickLayer(p0.terminals, p0.gateOps),
    };
    layersRef.current = layers;
    // Order matters for readability: channel + congestion + decks under
    // stacks/cranes/ships (the heatmap is a ground wash, drawn early). The pick
    // markers go LAST so they sit on top and hitTest picks them first.
    map.addMany([layers.channel, layers.congestion, layers.traffic, layers.decks, layers.yards, layers.cranes, layers.vessels, layers.liveVessels, layers.gates, layers.trucks, layers.picks]);

    // Static CCTV surveillance towers beside each toll plaza (gate3d). Position
    // is derived from the gate anchors, so it never changes on a sim tick — added
    // as a standalone layer (not part of the in-place data diff above).
    map.add(cctvLayer(p0.gateOps, p0.terminals));


    // The permanent way the shunting rake runs on — derived from the same
    //  anchor, so the rails always sit under the train.
    map.add(railTrackLayer(p0.terminals));

    const spotlight = spotlight3dLayer(p0.highlights ?? [], p0.facilities, p0.terminals);
    spotlightRef.current = spotlight;
    map.add(spotlight);

    const selection = selectionLayer();
    selectionRef.current = selection;
    map.add(selection);

    const routeDraw = routeDrawLayer();
    routeDrawRef.current = routeDraw;
    map.add(routeDraw);

    // Live-motion layers (moving trucks, shunting rake, crane hoists). These are
    // GraphicsLayers mutated per-frame — NOT part of the in-place-diff data path
    // and carry no pkey, so the placement editor and sim overlay never touch them.
    const anim = buildSceneAnim(p0.terminals, p0.gateOps);
    animRef.current = anim;
    map.addMany(anim.layers);

    const view = new SceneView({
      container: containerRef.current,
      map,
      // Tilted camera SW of the wharf (over the water) looking NE at the quays so
      // the berthed ships, cranes and yards read in one frame. Position derived
      // from the real terminal centroid (~72.942, 18.945); the eye sits close and
      // low (~900 m up, ~1.2 km SW), heading ~45°, so the 3D port fills the frame.
      camera: { position: { longitude: 72.9320, latitude: 18.9380, z: 900 }, tilt: 72, heading: 42 },
      qualityProfile: 'high',
      environment: {
        atmosphereEnabled: true,
        // Fixed midday sun (deterministic — no Date.now); the day/dusk toggle
        // swaps this date to reposition the sun. directShadows give the models
        // depth so cranes/ships read as solid 3D, not flat symbols.
        lighting: { type: 'sun', date: new Date('2026-06-16T06:30:00Z'), directShadowsEnabled: true },
      } as never,
      ui: { components: ['zoom', 'compass', 'navigation-toggle', 'attribution'] },
    });
    viewRef.current = view;

    // Auto-swap to the bundled offline basemap if the online tiles fail.
    const teardownFallback = installBasemapFallback(view);

    view.when(() => {
      view.ui.add(
        new Expand({ view, content: new Legend({ view }), expanded: false, expandTooltip: 'Show legend' }),
        'bottom-left',
      );
      view.ui.add(
        new Expand({ view, content: new LayerList({ view }), expanded: false, expandTooltip: 'Show layers' }),
        'top-right',
      );

      // ---- animation loop: advance the live movers each frame ----
      // Skips work while the tab/document is hidden or the container is not laid
      // out (3D toggle off), and freezes when the OS asks to reduce motion.
      const step = (now: number) => {
        rafRef.current = requestAnimationFrame(step);
        const prev = lastFrameRef.current || now;
        lastFrameRef.current = now;
        const dt = Math.min(0.1, (now - prev) / 1000); // clamp big gaps (tab switch)
        const container = containerRef.current;
        const visible =
          !REDUCED_MOTION &&
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          !!container &&
          container.clientWidth > 0;
        if (visible) {
          animClockRef.current += dt;
          animRef.current?.tick(animClockRef.current, dt);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    });

    // Click behaviour depends on mode:
    //  • EDIT mode → click-to-PLACE: move the asset selected in the tree (movePkey)
    //    to the clicked ground point. This uses view.toMap() on the click (reliable),
    //    NOT 3D-mesh hit-testing (which doesn't pick glTF object symbols reliably).
    //  • normal mode → click-to-SELECT: hit-test, resolve the asset id, fly to it.
    const clickHandle = view.on('click', (event) => {
      // Route-draw mode wins: each click appends a waypoint to the traced route,
      // and the preview line/dots redraw immediately. This is how the user traces
      // the truck route along the roads in the satellite imagery.
      const drawKey = drawRouteRef.current;
      if (drawKey) {
        event.stopPropagation();
        const mp = event.mapPoint;
        if (mp && typeof mp.longitude === 'number' && typeof mp.latitude === 'number') {
          placementStore.appendWaypoint(drawKey, mp.longitude, mp.latitude);
          refreshRouteDraw();
          rebuildAnim(); // trucks pick up the new waypoint as it's drawn
          propsRef.current.onPlacementsChanged?.();
        }
        return;
      }
      if (editingRef.current) {
        // In edit mode, a click on an ASSET selects it (opens its editor); a click
        // on empty GROUND places the currently-selected asset there. So hit-test
        // first, and only fall through to click-to-place when nothing was hit.
        event.stopPropagation();
        const mp = event.mapPoint;
        void view.hitTest(event).then((res) => {
          const hit = resolveHit(res);
          if (hit?.id) {
            // Clicked an asset → select it + open its editor (don't move).
            focusAsset(hit.id);
            propsRef.current.onSelect?.(hit.id, hit.pkey);
            return;
          }
          // Empty ground → place the selected asset at the clicked point.
          const pkey = movePkeyRef.current;
          if (pkey && mp && typeof mp.longitude === 'number' && typeof mp.latitude === 'number') {
            const prev = placementStore.get(pkey);
            placementStore.set(pkey, { lng: mp.longitude, lat: mp.latitude, heading: prev?.heading });
            rebuildOne(pkey);
            propsRef.current.onPlacementsChanged?.();
          }
        });
        return;
      }
      void view.hitTest(event).then((res) => {
        const hit = resolveHit(res);
        if (hit?.id) {
          // For live vessels, skip camera movement; just show the modal
          if (!hit.id.startsWith('LIVE-')) {
            focusAsset(hit.id);
          }
          propsRef.current.onSelect?.(hit.id, hit.pkey);
        }
      });
    });

    // Cursor affordance: a crosshair while editing (click-to-place), pointer over
    // pickable assets otherwise.
    const moveHandle = view.on('pointer-move', (event) => {
      if (drawRouteRef.current) {
        if (containerRef.current) containerRef.current.style.cursor = 'crosshair';
        return;
      }
      // In edit mode: pointer over an asset (you'd SELECT it), crosshair over
      // ground when something is selected (you'd PLACE it), else default.
      void view.hitTest(event).then((res) => {
        const overAsset = !!resolveHit(res);
        if (!containerRef.current) return;
        if (editingRef.current) {
          containerRef.current.style.cursor = overAsset ? 'pointer' : movePkeyRef.current ? 'crosshair' : 'default';
        } else {
          containerRef.current.style.cursor = overAsset ? 'pointer' : 'default';
        }
      });
    });

    // Traffic recolour on a slow timer — the moving trucks shift the density even
    // when no sim tick arrives. Deliberately NOT in the rAF loop: ~30 segments ×
    // a few dozen vehicles is cheap, but it has no business running at 60 fps.
    trafficTimerRef.current = setInterval(() => {
      const container = containerRef.current;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!container || container.clientWidth === 0) return;
      refreshTraffic();
    }, TRAFFIC_REFRESH_MS) as unknown as number;

    return () => {
      if (trafficTimerRef.current != null) clearInterval(trafficTimerRef.current);
      trafficTimerRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastFrameRef.current = 0;
      animRef.current?.destroy();
      animRef.current = null;
      teardownFallback();
      clickHandle.remove();
      moveHandle.remove();
      view.destroy();
      viewRef.current = null;
      mapRef.current = null;
      layersRef.current = null;
      spotlightRef.current = null;
      selectionRef.current = null;
      preFocusCameraRef.current = null;
      routeDrawRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the route-trace preview whenever draw mode / the drawn route changes
  // (enter draw mode → show existing waypoints; leave → clear the preview).
  useEffect(() => {
    refreshRouteDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.drawRouteKey]);

  // Fetch live vessel data from the backend, refreshing every 60 seconds (only when toggle is on).
  useEffect(() => {
    const liveLayer = layersRef.current?.liveVessels;
    const vesselLayer = layersRef.current?.vessels;
    if (!liveLayer || !vesselLayer) return;

    if (!showLiveVessels) {
      // Hide live vessels and show regular berthed vessels.
      liveLayer.visible = false;
      liveLayer.removeAll();
      vesselLayer.visible = true;
      setLiveVesselError(null);
      return;
    }

    // Show live vessels and hide regular berthed vessels.
    liveLayer.visible = true;
    vesselLayer.visible = false;
    let cancelled = false;

    const load = async () => {
      try {
        const vessels = await fetchLiveVessels();
        if (cancelled || !liveLayer) return;
        const graphics = graphicsFor3d.liveVessels(vessels);
        liveLayer.removeAll();
        for (const graphic of graphics) liveLayer.add(graphic);
        setLiveVesselError(null);
      } catch (err) {
        if (!cancelled) setLiveVesselError(err instanceof Error ? err.message : 'Fetch failed');
      }
    };

    void load();
    const interval = setInterval(() => { void load(); }, 300000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [showLiveVessels]);


  // ---- data: edit each 3D layer's features IN PLACE on change ----
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    void applyGraphics(layers.channel, graphicsFor3d.channel(props.terminals));
    void applyGraphics(layers.decks, graphicsFor3d.decks(props.terminals));
    void applyGraphics(layers.yards, graphicsFor3d.yards(props.terminals, props.pendency));
    void applyGraphics(layers.cranes, graphicsFor3d.cranes(props.terminals));
    void applyGraphics(layers.vessels, graphicsFor3d.vessels(props.terminals));
    void applyGraphics(layers.gates, graphicsFor3d.gates(props.gateOps, props.terminals));
    void applyGraphics(layers.trucks, graphicsFor3d.trucks(props.gateOps, props.terminals));
    void applyGraphics(layers.congestion, graphicsFor3d.congestion(props.gateOps, props.terminals));
    void applyGraphics(layers.picks, graphicsFor3d.picks(props.terminals, props.gateOps));
    // Feed live queue lengths to the moving trucks so they visibly slow at a
    // congested gate (the animation reads congestion, it doesn't fake it).
    animRef.current?.setGateQueues(props.gateOps);
    // Recolour the roads from the new queue lengths straight away, so a sim tick
    // shows up in the traffic overlay without waiting for the next interval.
    refreshTraffic();
  }, [props.terminals, props.pendency, props.gateOps]);

  // Pick markers stay hit-testable at all times (a hidden layer isn't picked), but
  // they're bumped to a clearly-visible opacity in Edit mode and kept very faint
  // otherwise, so clicking an asset works everywhere without cluttering the view.
  useEffect(() => {
    const layers = layersRef.current;
    if (layers) layers.picks.opacity = props.editing ? 1 : 0.12;
  }, [props.editing]);

  // ---- spotlight halos edited in place + camera reframes on spotlight change ----
  useEffect(() => {
    const layer = spotlightRef.current;
    const view = viewRef.current;
    if (!layer) return;
    const valueOf = makeValueOf(props.gateOps, props.pendency);
    const next = spotlight3dGraphics(props.highlights ?? [], props.facilities, props.terminals, valueOf);
    void applyGraphics(layer, next);

    const zoomKey = [...(props.highlights ?? [])].sort().join('|');
    if (view && next.length > 0 && zoomKey !== lastZoomKey.current) {
      lastZoomKey.current = zoomKey;
      const targets = next.map((g) => g.geometry).filter(Boolean);
      view.when(() => {
        void view
          .goTo({ target: targets, tilt: 60 } as never, { duration: 800, easing: 'ease-in-out' })
          .catch(() => {
            /* interrupted by a newer animation — fine */
          });
      });
    } else if (next.length === 0) {
      lastZoomKey.current = '';
    }
  }, [props.highlights, props.facilities, props.terminals, props.gateOps, props.pendency]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', minHeight: 480, background: tokens.color.bg }}
        aria-label="JNPA 3D sea-port scene"
        role="application"
      />
      {/* Live AIS vessels toggle — floating button in top-left */}
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 52,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <button
          id="live-vessels-toggle-3d"
          onClick={() => setShowLiveVessels((v) => !v)}
          title={showLiveVessels ? 'Hide live AIS vessels' : 'Show live AIS vessels'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            background: showLiveVessels ? '#00d4ff' : 'rgba(0,0,0,0.75)',
            color: showLiveVessels ? '#003366' : '#fff',
            border: '1px solid ' + (showLiveVessels ? '#003366' : 'rgba(255,255,255,0.25)'),
            borderRadius: 6,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            backdropFilter: 'blur(4px)',
            transition: 'all 0.2s ease',
          }}
        >
          <span style={{ fontSize: 14 }}>⚓</span>
          {showLiveVessels ? 'Live AIS: ON' : 'Live AIS: OFF'}
        </button>
        {liveVesselError && (
          <div
            style={{
              fontSize: 11,
              color: '#ff6b6b',
              background: 'rgba(0,0,0,0.75)',
              padding: '4px 8px',
              borderRadius: 4,
              maxWidth: 200,
            }}
          >
            {liveVesselError}
          </div>
        )}
      </div>
    </div>
  );
});
