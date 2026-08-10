/**
 * ArcGIS operational feature layers (Addendum A.1). Built as client-side
 * FeatureLayers from adapter data so the map renders OFFLINE in mock mode — no
 * portal item or token required. Each layer maps 1:1 to the A.1 table. Renderers
 * pull every colour from theme tokens (§14).
 */
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polyline from '@arcgis/core/geometry/Polyline';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, LiveVesselDTO, PendencyDTO } from '@jnpa/data';
import { tokens } from '../theme/tokens.js';
import { stableOid } from './oid.js';
// The 2D map resolves a gate's coordinate through the SAME override-aware
// resolver the 3D scene uses, so data/positions.json is the one source of truth
// for where a gate is. See the note on gatePositions below.
import { pkeyPosition } from './scene3d.js';

export { stableOid } from './oid.js';

function facilityGraphics(facilities: Facility[]): Graphic[] {
  return facilities
    .filter((f) => f.geom.type === 'Point')
    .map(
      (f) =>
        new Graphic({
          geometry: new Point({
            longitude: (f.geom as { coordinates: [number, number] }).coordinates[0],
            latitude: (f.geom as { coordinates: [number, number] }).coordinates[1],
          }),
          attributes: {
            objectId: stableOid(`fac:${f.facilityId}`),
            facilityId: f.facilityId,
            type: f.type,
            name: f.name,
            operator: f.operator,
            pendency: f.currentPendency,
          },
        }),
    );
}

/** Facilities layer — unique-value renderer by type (A.1). */
export function facilitiesLayer(facilities: Facility[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Facilities',
    source: facilityGraphics(facilities) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'facilityId', type: 'string' },
      { name: 'type', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'operator', type: 'string' },
      { name: 'pendency', type: 'integer' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'type',
      uniqueValueInfos: Object.entries(tokens.facility).map(([type, color]) => ({
        value: type,
        symbol: { type: 'simple-marker', size: type === 'TERMINAL' ? 12 : 8, color, outline: { color: tokens.color.bg, width: 1 } },
      })),
    } as never,
    popupTemplate: {
      title: '{name} ({type})',
      content: 'Operator: {operator}<br/>Pendency: {pendency}',
    } as never,
  });
}

/**
 * Where a gate is, for the 2D map — resolved through `pkeyPosition`, exactly as
 * the 3D scene does it, so BOTH views read `data/positions.json` and a gate can
 * never be in two places at once.
 *
 * This replaced a `GATE_OFFSET` table that added a hard-coded degree offset
 * (~[+0.002, −0.001], i.e. ~210 m E / ~110 m S) to the gate's terminal centroid
 * and never consulted the placement store at all. Because the 3D scene DID
 * consult it, every surveyed correction landed in the 3D view only and the 2D
 * markers stayed put — they diverged by 106 m (BMCT-G1) to 2290 m (JNPCT-G1),
 * and the centroid-plus-offset put several markers inside the container stacks.
 * That is the bug this function exists to make impossible.
 */
function gatePositions(terminals: Terminal[]): Map<string, [number, number]> {
  const gatePos = new Map<string, [number, number]>();
  for (const t of terminals) {
    for (const g of t.gates) {
      const p = pkeyPosition(`gate3d:${g}`, terminals);
      if (p) gatePos.set(g, p);
    }
  }
  return gatePos;
}

function gateGraphics(gateOps: GateOpsDTO[], terminals: Terminal[]): Graphic[] {
  const gatePos = gatePositions(terminals);
  return gateOps
    .filter((g) => gatePos.has(g.gateId))
    .map((g) => {
      const [lng, lat] = gatePos.get(g.gateId)!;
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat }),
        attributes: {
          objectId: stableOid(`gate:${g.gateId}`),
          gateId: g.gateId,
          terminalId: g.terminalId,
          queueLength: g.queueLength,
          avgTxnTimeMin: g.avgTxnTimeMin,
        },
      });
    });
}

/** Gates layer — graduated symbols by live queue length + heatmap behaviour (A.1). */
export function gatesLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Gates',
    source: gateGraphics(gateOps, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'gateId', type: 'string' },
      { name: 'terminalId', type: 'string' },
      { name: 'queueLength', type: 'integer' },
      { name: 'avgTxnTimeMin', type: 'double' },
    ],
    renderer: {
      type: 'simple',
      symbol: { type: 'simple-marker', color: tokens.color.accent, outline: { color: tokens.color.bg, width: 1 } },
      visualVariables: [
        { type: 'size', field: 'queueLength', minDataValue: 0, maxDataValue: 20, minSize: 8, maxSize: 36 },
        {
          type: 'color',
          field: 'queueLength',
          stops: [
            { value: 0, color: tokens.congestion.GREEN },
            { value: 8, color: tokens.congestion.AMBER },
            { value: 16, color: tokens.congestion.RED },
          ],
        },
      ],
    } as never,
    popupTemplate: {
      title: 'Gate {gateId}',
      content: 'Terminal: {terminalId}<br/>Queue: {queueLength}<br/>Avg txn: {avgTxnTimeMin} min',
    } as never,
  });
}

function pendencyGraphics(pend: PendencyDTO[]): Graphic[] {
  return pend
    .filter((p) => p.geom.type === 'Point')
    .map(
      (p) =>
        new Graphic({
          geometry: new Point({
            longitude: (p.geom as { coordinates: [number, number] }).coordinates[0],
            latitude: (p.geom as { coordinates: [number, number] }).coordinates[1],
          }),
          attributes: { objectId: stableOid(`pend:${p.facilityId}`), facilityId: p.facilityId, name: p.facilityName, pendency: p.pendency },
        }),
    );
}

/** Pendency choropleth — graduated colour on facility points by pendency (A.1). */
export function pendencyLayer(pend: PendencyDTO[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Pendency',
    visible: false,
    source: pendencyGraphics(pend) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'facilityId', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'pendency', type: 'integer' },
    ],
    renderer: {
      type: 'simple',
      symbol: { type: 'simple-marker', outline: { color: tokens.color.bg, width: 1 } },
      visualVariables: [
        { type: 'size', field: 'pendency', minDataValue: 0, maxDataValue: 200, minSize: 10, maxSize: 44 },
        {
          type: 'color',
          field: 'pendency',
          stops: [
            { value: 0, color: tokens.congestion.GREEN },
            { value: 50, color: tokens.congestion.AMBER },
            { value: 150, color: tokens.congestion.RED },
          ],
        },
      ],
    } as never,
    popupTemplate: { title: '{name}', content: 'Pendency: {pendency}' } as never,
  });
}

/**
 * Highlighted-assets layer — a pulsing halo around the assets the Simulator is
 * actively driving, so operators can see *what* the live data is changing. The
 * positions are resolved from facilities + gate offsets (same geometry rules as
 * the operational layers) so highlights sit exactly over the real markers.
 */
export function highlightGraphics(
  assetIds: string[],
  facilities: Facility[],
  terminals: Terminal[],
  /** Optional live-value resolver so the map label reads "GATE · 22" pin-point. */
  valueOf?: (id: string) => string | undefined,
): Graphic[] {
  // Build a lookup of id -> [lng, lat] for facilities and gates.
  const pos = new Map<string, [number, number]>();
  for (const f of facilities) {
    if (f.geom.type === 'Point') pos.set(f.facilityId, (f.geom as { coordinates: [number, number] }).coordinates);
  }
  for (const t of terminals) {
    const c = (t.geom as { coordinates: [number, number] }).coordinates;
    pos.set(t.terminalId, c);
  }
  // Same resolver as gateGraphics, so a scenario spotlight rings the gate marker
  // where it actually is rather than at a second, independently-derived point.
  for (const [gateId, p] of gatePositions(terminals)) pos.set(gateId, p);

  return assetIds
    .filter((id) => pos.has(id))
    .map((id) => {
      const [lng, lat] = pos.get(id)!;
      const v = valueOf?.(id);
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat }),
        // `label` carries the id + live value so the map labels the exact number.
        attributes: { objectId: stableOid(`hl:${id}`), assetId: id, label: v ? `${id} · ${v}` : id },
      });
    });
}

export function highlightedAssetsLayer(
  assetIds: string[],
  facilities: Facility[],
  terminals: Terminal[],
): FeatureLayer {
  return new FeatureLayer({
    title: 'Live (simulated)',
    source: highlightGraphics(assetIds, facilities, terminals) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'assetId', type: 'string' },
      { name: 'label', type: 'string' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'simple-marker',
        style: 'circle',
        size: 30,
        // Soft translucent fill + a thick brand ring so the spotlighted asset is
        // unmistakable on the map (the previous transparent thin ring was easy to
        // miss). The asset id + live value is also drawn as a label below.
        color: [26, 115, 194, 0.18],
        outline: { color: tokens.color.brand, width: 4 },
      },
    } as never,
    // Label each spotlighted asset with its id AND live value so a viewer sees
    // *which* gate/facility the scenario is changing and the exact number.
    labelingInfo: [
      {
        labelExpressionInfo: { expression: '$feature.label' },
        symbol: {
          type: 'text',
          color: tokens.color.brand,
          haloColor: tokens.color.bgPanel,
          haloSize: 1.5,
          font: { size: 11, weight: 'bold' },
          yoffset: -22,
        },
        labelPlacement: 'center-center',
      },
    ] as never,
    popupTemplate: { title: 'Live: {assetId}', content: 'Driven by the simulator.' } as never,
  });
}

type Flow = { from: string; to: string; stream: keyof typeof tokens.flow; count: number };

function flowGraphics(terminals: Terminal[], flows: Flow[]): Graphic[] {
  const pos = new Map<string, [number, number]>(
    terminals.map((t) => [t.terminalId, (t.geom as { coordinates: [number, number] }).coordinates]),
  );
  return flows
    .filter((f) => pos.has(f.from) && pos.has(f.to))
    .map((f) => {
      const a = pos.get(f.from)!;
      const b = pos.get(f.to)!;
      return new Graphic({
        geometry: new Polyline({ paths: [[a, b]], spatialReference: { wkid: 4326 } }),
        attributes: { objectId: stableOid(`flow:${f.from}->${f.to}:${f.stream}`), stream: f.stream, count: f.count, from: f.from, to: f.to },
      });
    });
}

/** Cargo flows — animated-style OD polylines by stream incl. ITRHO (A.1). */
export function cargoFlowsLayer(terminals: Terminal[], flows: Flow[]): FeatureLayer {
  return new FeatureLayer({
    title: 'Cargo Flows',
    source: flowGraphics(terminals, flows) as unknown as Graphic[],
    objectIdField: 'objectId',
    geometryType: 'polyline',
    spatialReference: { wkid: 4326 },
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'stream', type: 'string' },
      { name: 'count', type: 'integer' },
      { name: 'from', type: 'string' },
      { name: 'to', type: 'string' },
    ],
    renderer: {
      type: 'unique-value',
      field: 'stream',
      uniqueValueInfos: Object.entries(tokens.flow).map(([stream, color]) => ({
        value: stream,
        symbol: { type: 'simple-line', color, width: 2 },
      })),
    } as never,
    popupTemplate: { title: '{stream} flow', content: '{from} → {to}: {count} containers' } as never,
  });
}

// ---- smooth in-place updates ----------------------------------------------

/** Builds the current graphics array for an operational layer kind. */
export const graphicsFor = {
  facilities: facilityGraphics,
  pendency: pendencyGraphics,
  gates: gateGraphics,
  flows: flowGraphics,
};

/**
 * Smoothly reconcile a layer's features to `next` via a single applyEdits:
 * features present in both are UPDATED (attributes/geometry), new ones ADDED,
 * gone ones DELETED. Because objectIds are stable per asset (stableOid), the
 * FeatureLayerView transitions the changed markers in place instead of
 * delete-all + add-all — no whole-layer blink. Returns a promise.
 *
 * `attrsEqual` skips no-op updates so unchanged features aren't re-edited (the
 * sim only changes a handful of assets per tick), keeping transitions targeted.
 */
export async function applyGraphics(layer: FeatureLayer, next: Graphic[]): Promise<void> {
  const existing = await layer.queryFeatures();
  const oidField = layer.objectIdField;
  const prevByOid = new Map<number, Graphic>();
  for (const g of existing.features) prevByOid.set(g.attributes[oidField] as number, g);

  const addFeatures: Graphic[] = [];
  const updateFeatures: Graphic[] = [];
  const seen = new Set<number>();

  for (const g of next) {
    const id = g.attributes[oidField] as number;
    seen.add(id);
    const prev = prevByOid.get(id);
    if (!prev) {
      addFeatures.push(g);
    } else if (!attrsEqual(prev.attributes, g.attributes)) {
      updateFeatures.push(g);
    }
  }
  const deleteFeatures = existing.features.filter((g) => !seen.has(g.attributes[oidField] as number));

  if (!addFeatures.length && !updateFeatures.length && !deleteFeatures.length) return;
  await layer.applyEdits({ addFeatures, updateFeatures, deleteFeatures });
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Live AIS vessel layer (MarineTraffic proxy — 2D map)
// ---------------------------------------------------------------------------

function liveVesselGraphics(vessels: LiveVesselDTO[]): Graphic[] {
  return vessels.map(
    (v) =>
      new Graphic({
        geometry: new Point({ longitude: v.lon, latitude: v.lat }),
        attributes: {
          objectId: stableOid(`live-vessel:${v.mmsi}`),
          mmsi: v.mmsi,
          vesselName: v.vessel_name,
          speedKnots: v.speed_knots,
          course: v.course,
          heading: v.heading ?? v.course,
          shipTypeLabel: v.ship_type_label,
          destination: v.destination ?? '',
          flag: v.flag ?? '',
        },
      }),
  );
}

/**
 * Live vessel layer for the 2D PortMap — directional arrow markers rotated
 * by the vessel's AIS course. Built empty initially and filled via
 * applyGraphics when live data arrives.
 */
export function liveVesselsLayer(): FeatureLayer {
  return new FeatureLayer({
    title: 'Live Vessels (AIS)',
    source: [],
    objectIdField: 'objectId',
    geometryType: 'point',
    spatialReference: { wkid: 4326 },
    visible: false, // off by default; toggle enables it
    fields: [
      { name: 'objectId', type: 'oid' },
      { name: 'mmsi', type: 'string' },
      { name: 'vesselName', type: 'string' },
      { name: 'speedKnots', type: 'double' },
      { name: 'course', type: 'integer' },
      { name: 'heading', type: 'integer' },
      { name: 'shipTypeLabel', type: 'string' },
      { name: 'destination', type: 'string' },
      { name: 'flag', type: 'string' },
    ],
    renderer: {
      type: 'simple',
      symbol: {
        type: 'simple-marker',
        style: 'triangle',
        size: 10,
        color: '#00d4ff',
        outline: { color: '#003366', width: 1 },
      },
      visualVariables: [{ type: 'rotation', field: 'heading', rotationType: 'geographic' }],
    } as never,
    popupTemplate: {
      title: '{vesselName}',
      content: 'MMSI: {mmsi}<br/>Speed: {speedKnots} kn<br/>Course: {course}°<br/>Type: {shipTypeLabel}<br/>Destination: {destination}<br/>Flag: {flag}',
    } as never,
    labelsVisible: false,
  });
}

/** Graphics builder for live vessel layer (used by applyGraphics in PortMap). */
export const graphicsForLiveVessels = liveVesselGraphics;
