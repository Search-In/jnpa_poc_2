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
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import Map from '@arcgis/core/Map';
import SceneView from '@arcgis/core/views/SceneView';
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LayerList from '@arcgis/core/widgets/LayerList';
import Legend from '@arcgis/core/widgets/Legend';
import Expand from '@arcgis/core/widgets/Expand';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { applyGraphics } from './layers.js';
import {
  terminalDeckLayer,
  yardStackLayer,
  craneLayer,
  vesselLayer,
  gate3dLayer,
  truckLayer,
  channelLayer,
  spotlight3dLayer,
  spotlight3dGraphics,
  selectionLayer,
  selectionRing,
  asset3dPosition,
  graphicsFor3d,
} from './scene3d.js';
import { placementStore } from './placementStore.js';
import { tokens } from '../theme/tokens.js';

interface PortSceneProps {
  facilities: Facility[];
  terminals: Terminal[];
  gateOps: GateOpsDTO[];
  pendency: PendencyDTO[];
  /** Asset ids the simulator is driving — drawn with a 3D spotlight beam. */
  highlights?: string[];
  /** Notify the parent when the user clicks an asset in the 3D scene. */
  onSelect?: (assetId: string | null) => void;
  /** Placement edit mode — a map click moves the selected asset to that spot. */
  editing?: boolean;
  /** The placement key of the asset to move on the next map click (from the tree). */
  movePkey?: string | null;
  /** Fired after a placement lands (so the parent can update the export count). */
  onPlacementsChanged?: () => void;
}

/** Imperative handle the AssetExplorer uses to fly the 3D camera to an asset. */
export interface PortSceneHandle {
  focus: (assetId: string) => void;
  clearSelection: () => void;
  /** Rebuild the operational layers from current data + placement overrides. */
  rebuild: () => void;
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const layersRef = useRef<{
    decks: FeatureLayer;
    yards: FeatureLayer;
    cranes: FeatureLayer;
    vessels: FeatureLayer;
    gates: FeatureLayer;
    trucks: FeatureLayer;
    channel: FeatureLayer;
  } | null>(null);
  const spotlightRef = useRef<FeatureLayer | null>(null);
  const selectionRef = useRef<GraphicsLayer | null>(null);
  const lastZoomKey = useRef<string>('');
  const propsRef = useRef(props);
  propsRef.current = props;
  // Latest editing flag + the asset to move, readable inside the once-registered
  // click handler (which is created only on mount).
  const editingRef = useRef<boolean>(!!props.editing);
  editingRef.current = !!props.editing;
  const movePkeyRef = useRef<string | null>(props.movePkey ?? null);
  movePkeyRef.current = props.movePkey ?? null;

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
  }

  // ---- imperative camera focus, shared by explorer clicks + internal picks ----
  function focusAsset(assetId: string) {
    const view = viewRef.current;
    const sel = selectionRef.current;
    if (!view) return;
    const pos = asset3dPosition(propsRef.current.facilities, propsRef.current.terminals);
    const p = pos.get(assetId);
    if (!p) return;
    const [lng, lat] = p;
    // Drop a transient amber selection ring and tilt the camera in on the asset.
    if (sel) {
      sel.removeAll();
      sel.add(selectionRing(lng, lat));
    }
    void view
      .goTo({ target: { type: 'point', longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }, tilt: 62, zoom: 17 } as never, {
        duration: 900,
        easing: 'ease-in-out',
      })
      .catch(() => {
        /* goTo rejects if interrupted by a newer animation — fine */
      });
  }

  useImperativeHandle(ref, () => ({
    focus: focusAsset,
    clearSelection: () => selectionRef.current?.removeAll(),
    rebuild: rebuildLayers,
  }), []);

  // ---- init: build the scene view + 3D layers + widgets ONCE ----
  useEffect(() => {
    if (!containerRef.current) return;
    const p0 = propsRef.current;

    const map = new Map({ basemap: 'hybrid', ground: 'world-elevation' });

    // Build 3D layers once; the data effect edits features in place thereafter.
    const layers = {
      channel: channelLayer(p0.terminals),
      decks: terminalDeckLayer(p0.terminals),
      yards: yardStackLayer(p0.terminals, p0.pendency),
      cranes: craneLayer(p0.terminals),
      vessels: vesselLayer(p0.terminals),
      gates: gate3dLayer(p0.gateOps, p0.terminals),
      trucks: truckLayer(p0.gateOps, p0.terminals),
    };
    layersRef.current = layers;
    // Order matters for readability: channel + decks under stacks/cranes/ships.
    map.addMany([layers.channel, layers.decks, layers.yards, layers.cranes, layers.vessels, layers.gates, layers.trucks]);

    const spotlight = spotlight3dLayer(p0.highlights ?? [], p0.facilities, p0.terminals);
    spotlightRef.current = spotlight;
    map.add(spotlight);

    const selection = selectionLayer();
    selectionRef.current = selection;
    map.add(selection);

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
        lighting: { type: 'sun', directShadowsEnabled: true },
      },
      ui: { components: ['zoom', 'compass', 'navigation-toggle', 'attribution'] },
    });
    viewRef.current = view;

    view.when(() => {
      view.ui.add(
        new Expand({ view, content: new Legend({ view }), expanded: false, expandTooltip: 'Show legend' }),
        'bottom-left',
      );
      view.ui.add(
        new Expand({ view, content: new LayerList({ view }), expanded: false, expandTooltip: 'Show layers' }),
        'top-right',
      );
    });

    // Click behaviour depends on mode:
    //  • EDIT mode → click-to-PLACE: move the asset selected in the tree (movePkey)
    //    to the clicked ground point. This uses view.toMap() on the click (reliable),
    //    NOT 3D-mesh hit-testing (which doesn't pick glTF object symbols reliably).
    //  • normal mode → click-to-SELECT: hit-test, resolve the asset id, fly to it.
    const clickHandle = view.on('click', (event) => {
      if (editingRef.current) {
        const pkey = movePkeyRef.current;
        if (!pkey) return; // nothing selected to move — ignore the click
        event.stopPropagation();
        const mp = event.mapPoint;
        if (mp && typeof mp.longitude === 'number' && typeof mp.latitude === 'number') {
          const prev = placementStore.get(pkey);
          placementStore.set(pkey, { lng: mp.longitude, lat: mp.latitude, heading: prev?.heading });
          rebuildLayers();
          propsRef.current.onPlacementsChanged?.();
        }
        return;
      }
      void view.hitTest(event).then((res) => {
        const g = res.results.find((r) => 'graphic' in r)?.graphic as { attributes?: Record<string, unknown> } | undefined;
        const a = g?.attributes ?? {};
        const id =
          (a.terminalId as string) ??
          (a.gateId as string) ??
          (a.facilityId as string) ??
          (a.craneId as string) ??
          (a.vesselId as string) ??
          (a.blockId as string) ??
          null;
        if (id) {
          focusAsset(id);
          propsRef.current.onSelect?.(id);
        }
      });
    });

    // Cursor affordance: a crosshair while editing (click-to-place), pointer over
    // pickable assets otherwise.
    const moveHandle = view.on('pointer-move', (event) => {
      if (editingRef.current) {
        if (containerRef.current) containerRef.current.style.cursor = movePkeyRef.current ? 'crosshair' : 'not-allowed';
        return;
      }
      void view.hitTest(event).then((res) => {
        const hit = res.results.some((r) => 'graphic' in r);
        if (containerRef.current) containerRef.current.style.cursor = hit ? 'pointer' : 'default';
      });
    });

    return () => {
      clickHandle.remove();
      moveHandle.remove();
      view.destroy();
      viewRef.current = null;
      layersRef.current = null;
      spotlightRef.current = null;
      selectionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [props.terminals, props.pendency, props.gateOps]);

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
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 480, background: tokens.color.bg }}
      aria-label="JNPA 3D sea-port scene"
      role="application"
    />
  );
});
