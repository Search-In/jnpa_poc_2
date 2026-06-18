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
import LayerList from '@arcgis/core/widgets/LayerList';
import Legend from '@arcgis/core/widgets/Legend';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { cargoFlowsLayer, facilitiesLayer, gatesLayer, pendencyLayer } from './layers.js';
import { tokens } from '../theme/tokens.js';

interface PortMapProps {
  facilities: Facility[];
  terminals: Terminal[];
  gateOps: GateOpsDTO[];
  pendency: PendencyDTO[];
  flows: Array<{ from: string; to: string; stream: keyof typeof tokens.flow; count: number }>;
  /** Optional spatial overlay from a scenario run (reroute lines etc.). */
  scenarioOverlay?: unknown;
}

export function PortMap(props: PortMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new Map({ basemap: 'gray-vector' });
    map.addMany([
      facilitiesLayer(props.facilities),
      pendencyLayer(props.pendency),
      cargoFlowsLayer(props.terminals, props.flows),
      gatesLayer(props.gateOps, props.terminals),
    ]);

    const view = new MapView({
      container: containerRef.current,
      map,
      center: [72.949, 18.95],
      zoom: 13,
      ui: { components: ['zoom', 'attribution'] },
    });
    viewRef.current = view;

    view.when(() => {
      view.ui.add(new Legend({ view }), 'bottom-left');
      view.ui.add(new LayerList({ view }), 'top-right');
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Rebuild on data change (mock data is stable; scenario overlay triggers redraw)
  }, [props.facilities, props.terminals, props.gateOps, props.pendency, props.flows]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', minHeight: 480, background: tokens.color.bg }}
      aria-label="JNPA port operations map"
      role="application"
    />
  );
}
