/**
 * Shared primitives and enums for the JNPA UC2 canonical model (prompt §3).
 *
 * Conventions (locked — do not deviate elsewhere):
 *  - Container numbers follow ISO 6346 (4 letters + 6 digits + 1 check digit).
 *  - All timestamps are UTC ISO-8601 strings. The *source-system local offset*
 *    is preserved separately on events (see {@link IsoUtcWithOffset}) so we never
 *    lose the originating timezone, per §3.
 *  - ISO type codes follow ISO 6346 size/type (e.g. "22G1", "45R1").
 */

/** UTC ISO-8601 instant, e.g. "2026-06-17T08:30:00.000Z". */
export type IsoUtc = string;

/**
 * The original source-system local offset (minutes east of UTC) captured at
 * ingest so the canonical UTC timestamp is reversible to wall-clock time.
 * Example: IST is +330.
 */
export type UtcOffsetMinutes = number;

/** ISO 6346 container number: 4 letters (owner+category) + 6 digits + check digit. */
export type ContainerNo = string;

/** ISO 6346 size/type code, e.g. "22G1" (20ft general), "45R1" (45ft reefer). */
export type IsoTypeCode = string;

/** Opaque key into the object store (MinIO/S3) where the raw payload is kept. */
export type RawRef = string;

/** GeoJSON Point — [longitude, latitude] in EPSG:4326. */
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

/** GeoJSON Polygon — array of linear rings, each [lng, lat] in EPSG:4326. */
export interface GeoPolygon {
  type: 'Polygon';
  coordinates: Array<Array<[number, number]>>;
}

export type Geometry = GeoPoint | GeoPolygon;

/** Cargo stream of origin — drives role scoping and trans-shipment filtering (§3). */
export const ORIGIN_STREAMS = [
  'IMPORT_CFS',
  'IMPORT_ICD',
  'IMPORT_DPD',
  'EXPORT_CFS',
  'EXPORT_ICD',
  'EXPORT_DPE',
  'TRANSSHIP',
] as const;
export type OriginStream = (typeof ORIGIN_STREAMS)[number];

/** Systems that can originate a CargoEvent (§3). SIM is the demo-console source. */
export const SOURCE_SYSTEMS = [
  'ULIP',
  'ICEGATE',
  'TOS',
  'FOIS',
  'ESEAL',
  'SHIPLINE',
  'SIM',
] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

/** Container lifecycle status (§3 Container.status). */
export const CONTAINER_STATUSES = [
  'EXPECTED',
  'GATE_IN',
  'IN_YARD',
  'RAIL_IN',
  'RAIL_OUT',
  'UNDER_SCAN',
  'HELD_CUSTOMS',
  'STUFFING',
  'DESTUFFING',
  'ITRHO_IN_TRANSIT',
  'GATE_OUT',
  'DEPARTED',
] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

/** Facility taxonomy (§3 Facility.type). */
export const FACILITY_TYPES = [
  'TERMINAL',
  'CFS',
  'ICD',
  'DPE',
  'DPD',
  'ECD',
  'CPP',
  'RAIL_SIDING',
] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

/** Rail siding identifiers at JNPT central rail yard. */
export const SIDING_IDS = ['T1', 'T2'] as const;
export type SidingId = (typeof SIDING_IDS)[number];

/** Helper: branded result of validating a string against a known enum. */
export function isOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
