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
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { tokens } from '../theme/tokens.js';

let oid = 1;
const nextOid = () => oid++;

/** Facilities layer — unique-value renderer by type (A.1). */
export function facilitiesLayer(facilities: Facility[]): FeatureLayer {
  const graphics = facilities
    .filter((f) => f.geom.type === 'Point')
    .map(
      (f) =>
        new Graphic({
          geometry: new Point({
            longitude: (f.geom as { coordinates: [number, number] }).coordinates[0],
            latitude: (f.geom as { coordinates: [number, number] }).coordinates[1],
          }),
          attributes: {
            objectId: nextOid(),
            facilityId: f.facilityId,
            type: f.type,
            name: f.name,
            operator: f.operator,
            pendency: f.currentPendency,
          },
        }),
    );

  return new FeatureLayer({
    title: 'Facilities',
    source: graphics as unknown as Graphic[],
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

/** Gates layer — graduated symbols by live queue length + heatmap behaviour (A.1). */
export function gatesLayer(gateOps: GateOpsDTO[], terminals: Terminal[]): FeatureLayer {
  const gatePos = new Map<string, [number, number]>();
  for (const t of terminals) {
    const c = (t.geom as { coordinates: [number, number] }).coordinates;
    t.gates.forEach((g, i) => gatePos.set(g, [c[0] + 0.002 * (i + 1), c[1] + 0.001 * (i + 1)]));
  }
  const graphics = gateOps
    .filter((g) => gatePos.has(g.gateId))
    .map((g) => {
      const [lng, lat] = gatePos.get(g.gateId)!;
      return new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat }),
        attributes: {
          objectId: nextOid(),
          gateId: g.gateId,
          terminalId: g.terminalId,
          queueLength: g.queueLength,
          avgTxnTimeMin: g.avgTxnTimeMin,
        },
      });
    });

  return new FeatureLayer({
    title: 'Gates',
    source: graphics as unknown as Graphic[],
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

/** Pendency choropleth — graduated colour on facility points by pendency (A.1). */
export function pendencyLayer(pend: PendencyDTO[]): FeatureLayer {
  const graphics = pend
    .filter((p) => p.geom.type === 'Point')
    .map(
      (p) =>
        new Graphic({
          geometry: new Point({
            longitude: (p.geom as { coordinates: [number, number] }).coordinates[0],
            latitude: (p.geom as { coordinates: [number, number] }).coordinates[1],
          }),
          attributes: { objectId: nextOid(), facilityId: p.facilityId, name: p.facilityName, pendency: p.pendency },
        }),
    );
  return new FeatureLayer({
    title: 'Pendency',
    visible: false,
    source: graphics as unknown as Graphic[],
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

/** Cargo flows — animated-style OD polylines by stream incl. ITRHO (A.1). */
export function cargoFlowsLayer(
  terminals: Terminal[],
  flows: Array<{ from: string; to: string; stream: keyof typeof tokens.flow; count: number }>,
): FeatureLayer {
  const pos = new Map<string, [number, number]>(
    terminals.map((t) => [t.terminalId, (t.geom as { coordinates: [number, number] }).coordinates]),
  );
  const graphics = flows
    .filter((f) => pos.has(f.from) && pos.has(f.to))
    .map((f) => {
      const a = pos.get(f.from)!;
      const b = pos.get(f.to)!;
      return new Graphic({
        geometry: new Polyline({ paths: [[a, b]], spatialReference: { wkid: 4326 } }),
        attributes: { objectId: nextOid(), stream: f.stream, count: f.count, from: f.from, to: f.to },
      });
    });
  return new FeatureLayer({
    title: 'Cargo Flows',
    source: graphics as unknown as Graphic[],
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
