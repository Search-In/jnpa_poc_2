/**
 * PortMap — the ArcGIS spatial spine (Addendum A: "ArcGIS is the canvas"). Uses
 * the modern Map components (<arcgis-map> + sub-component widgets, no deprecated
 * widget classes). Builds all A.1 operational layers client-side from adapter
 * data so it renders offline; if ARCGIS_WEBMAP_ID is set it would overlay the
 * real JNPA WebMap. Map tools (A.2): legend, layer list, time slider, basemap.
 */
import { useEffect, useRef } from 'react';
import Map from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import LayerList from '@arcgis/core/widgets/LayerList';
import Legend from '@arcgis/core/widgets/Legend';
import BasemapToggle from '@arcgis/core/widgets/BasemapToggle';
import Expand from '@arcgis/core/widgets/Expand';
import { initialBasemap, installBasemapFallback } from './basemapFallback.js';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import {
  cargoFlowsLayer,
  facilitiesLayer,
  gatesLayer,
  highlightedAssetsLayer,
  pendencyLayer,
  graphicsFor,
  applyGraphics,
  highlightGraphics,
} from './layers.js';
import { tokens } from '../theme/tokens.js';

interface PortMapProps {
  facilities: Facility[];
  terminals: Terminal[];
  gateOps: GateOpsDTO[];
  pendency: PendencyDTO[];
  flows: Array<{ from: string; to: string; stream: keyof typeof tokens.flow; count: number }>;
  /** Optional spatial overlay from a scenario run (reroute lines etc.). */
  scenarioOverlay?: unknown;
  /** Asset ids the simulator is driving — drawn with a highlight halo. */
  highlights?: string[];
}

/**
 * Build a resolver from a live id → short value string (e.g. a gate's queue, a
 * facility's pendency), so the map's spotlight label can show the exact number
 * the scenario is changing — pin-point, not just the asset name.
 */
function makeValueOf(gateOps: GateOpsDTO[], pendency: PendencyDTO[]): (id: string) => string | undefined {
  // Plain records (not JS Map — `Map` here is the ArcGIS class import).
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

export function PortMap(props: PortMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const mapRef = useRef<Map | null>(null);
  // Stable refs to each operational layer, created once and edited in place.
  const layersRef = useRef<{
    facilities: FeatureLayer;
    pendency: FeatureLayer;
    flows: FeatureLayer;
    gates: FeatureLayer;
  } | null>(null);
  const highlightRef = useRef<FeatureLayer | null>(null);
  // Last spotlight id-set we zoomed to, so we only re-frame when it changes
  // (not on every sim tick that merely re-creates the highlights array).
  const lastZoomKey = useRef<string>('');
  // Latest props for the init effect's first layer build (init runs once).
  const propsRef = useRef(props);
  propsRef.current = props;

  // ---- init: create the view + layers + widgets ONCE (never on data change) ----
  // Re-creating the view every sim tick would tear down the basemap, zoom and
  // widgets each second, so init is decoupled from the data effect below.
  useEffect(() => {
    if (!containerRef.current) return;

    // Basemap survives ArcGIS token death / no-Wi-Fi: online 'hybrid' normally,
    // but auto-swaps to a bundled local offline base if tiles fail (spec §3).
    const map = new Map({ basemap: initialBasemap() });
    mapRef.current = map;

    // Build the operational layers once; the data effect edits their features
    // in place thereafter so only changed markers transition (no blink).
    const p0 = propsRef.current;
    const layers = {
      facilities: facilitiesLayer(p0.facilities),
      pendency: pendencyLayer(p0.pendency),
      flows: cargoFlowsLayer(p0.terminals, p0.flows),
      gates: gatesLayer(p0.gateOps, p0.terminals),
    };
    layersRef.current = layers;
    map.addMany([layers.facilities, layers.pendency, layers.flows, layers.gates]);

    // Highlight layer created once (empty) and edited in place; always on top.
    const highlight = highlightedAssetsLayer(
      p0.highlights ?? [],
      p0.facilities,
      p0.terminals,
    );
    // First label values use the initial data; the update effect re-applies the
    // labelled graphics (with live values) immediately after.
    highlightRef.current = highlight;
    map.add(highlight);

    const view = new MapView({
      container: containerRef.current,
      map,
      center: [72.949, 18.95],
      zoom: 13,
      ui: { components: ['zoom', 'attribution'] },
    });
    viewRef.current = view;

    // Auto-swap to the bundled offline basemap if the online tiles fail (token
    // death / no Wi-Fi). The operational layers stay legible on a neutral canvas.
    const teardownFallback = installBasemapFallback(view);

    view.when(() => {
      // Legend wrapped in an Expand so operators can minimise it — the
      // bottom-left box collapses to a single button and expands on click.
      // Collapsed by default so it doesn't obscure the map on load.
      view.ui.add(
        new Expand({
          view,
          content: new Legend({ view }),
          expanded: false,
          expandTooltip: 'Show legend',
          collapseTooltip: 'Hide legend',
        }),
        'bottom-left',
      );
      // Layer list wrapped in an Expand so it's closable too — collapses to a
      // single button at top-right and expands on click. Collapsed by default
      // so it doesn't obscure the map on load.
      view.ui.add(
        new Expand({
          view,
          content: new LayerList({ view }),
          expanded: false,
          expandTooltip: 'Show layers',
          collapseTooltip: 'Hide layers',
        }),
        'top-right',
      );
      // Basemap toggle (A.2 map tools): switch between the satellite/imagery
      // default and the gray vector basemap. 'hybrid' keeps street/place labels
      // over the imagery so operators can still read the port layout. Skipped in
      // offline mode (both online options need tiles the offline base can't serve).
      const bm = view.map?.basemap;
      if (!(bm && bm.id === 'jnpa-offline')) {
        view.ui.add(new BasemapToggle({ view, nextBasemap: 'gray-vector' }), 'bottom-right');
      }
    });

    return () => {
      teardownFallback();
      view.destroy();
      viewRef.current = null;
      mapRef.current = null;
      layersRef.current = null;
      highlightRef.current = null;
    };
  }, []);

  // ---- data: edit each operational layer's features IN PLACE on change ----
  // applyGraphics diffs by stable objectId and issues one applyEdits per layer,
  // so only the markers whose data actually changed transition — the rest stay
  // put. This removes the whole-layer "blink" the old remove/re-add caused.
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    void applyGraphics(layers.facilities, graphicsFor.facilities(props.facilities));
    void applyGraphics(layers.pendency, graphicsFor.pendency(props.pendency));
    void applyGraphics(layers.flows, graphicsFor.flows(props.terminals, props.flows));
    void applyGraphics(layers.gates, graphicsFor.gates(props.gateOps, props.terminals));
  }, [props.facilities, props.terminals, props.gateOps, props.pendency, props.flows]);

  // Highlight halos are edited in place too, so adding/removing a driven asset
  // fades just that ring in/out instead of recreating the layer. When the set of
  // spotlighted assets changes we also pan/zoom the map to frame them, so the
  // map view stays synced with the guided What-If tour ("show me on the map").
  useEffect(() => {
    const layer = highlightRef.current;
    const view = viewRef.current;
    if (!layer) return;
    const valueOf = makeValueOf(props.gateOps, props.pendency);
    const next = highlightGraphics(props.highlights ?? [], props.facilities, props.terminals, valueOf);
    void applyGraphics(layer, next);

    const zoomKey = [...(props.highlights ?? [])].sort().join('|');
    if (view && next.length > 0 && zoomKey !== lastZoomKey.current) {
      lastZoomKey.current = zoomKey;
      const targets = next.map((g) => g.geometry).filter(Boolean);
      view.when(() => {
        void view.goTo(
          targets.length === 1 ? { target: targets[0], zoom: Math.max(view.zoom, 15) } : { target: targets },
          { duration: 700, easing: 'ease-in-out' },
        ).catch(() => { /* goTo rejects if interrupted by a newer animation — fine */ });
      });
    } else if (next.length === 0) {
      lastZoomKey.current = '';
    }
  // gateOps/pendency in deps so the map label refreshes the live value as it
  // moves; the zoom is still guarded by lastZoomKey so it only re-frames on a
  // spotlight change, not on every value tick.
  }, [props.highlights, props.facilities, props.terminals, props.gateOps, props.pendency]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 480, background: tokens.color.bg }}
      aria-label="JNPA port operations map"
      role="application"
    />
  );
}
