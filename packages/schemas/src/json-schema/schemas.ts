/**
 * JSON-Schema (draft 2020-12) definitions matching the canonical TS types.
 * Used for runtime validation at every integration boundary (connectors,
 * gateway ingress, event-backbone payloads). Kept hand-written and adjacent to
 * the TS types so a reviewer can diff them 1:1; golden tests assert they accept
 * mapper output (§4).
 */

import {
  CONTAINER_STATUSES,
  FACILITY_TYPES,
  ORIGIN_STREAMS,
  SOURCE_SYSTEMS,
} from '../entities/common.js';
import { EVENT_TYPES } from '../entities/cargo-event.js';
import { NOTIFICATION_TYPES } from '../entities/notification.js';
import { ROLES } from '../entities/rbac.js';

const ISO_UTC = {
  type: 'string',
  format: 'date-time',
  description: 'UTC ISO-8601 instant',
} as const;

const CONTAINER_NO = {
  type: 'string',
  pattern: '^[A-Z]{3}[UJZ]\\d{6}\\d$',
  description: 'ISO 6346 container number',
} as const;

const GEOMETRY = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'coordinates'],
      properties: {
        type: { const: 'Point' },
        coordinates: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
      },
    },
    {
      type: 'object',
      required: ['type', 'coordinates'],
      properties: {
        type: { const: 'Polygon' },
        coordinates: { type: 'array' },
      },
    },
  ],
} as const;

export const containerSchema = {
  $id: 'jnpa:uc2:Container',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'containerNo',
    'isoTypeCode',
    'sizeFt',
    'laden',
    'grossWtKg',
    'cargoType',
    'lineOwner',
    'currentSealNo',
    'status',
    'originStream',
    'lastUpdatedTs',
  ],
  properties: {
    containerNo: CONTAINER_NO,
    isoTypeCode: { type: 'string', pattern: '^[0-9A-Z]{4}$' },
    sizeFt: { enum: [20, 40, 45] },
    laden: { type: 'boolean' },
    grossWtKg: { type: 'number', minimum: 0 },
    cargoType: { type: 'string' },
    hazmatIMDG: {
      type: 'object',
      required: ['imdgClass'],
      properties: {
        imdgClass: { type: 'string' },
        unNo: { type: 'string' },
        packingGroup: { enum: ['I', 'II', 'III'] },
      },
    },
    reefer: {
      type: 'object',
      required: ['setpointC', 'currentC'],
      properties: {
        setpointC: { type: 'number' },
        currentC: { type: 'number' },
      },
    },
    lineOwner: { type: 'string' },
    currentSealNo: { type: 'string' },
    status: { enum: [...CONTAINER_STATUSES] },
    originStream: { enum: [...ORIGIN_STREAMS] },
    lastUpdatedTs: ISO_UTC,
  },
} as const;

export const cargoEventSchema = {
  $id: 'jnpa:uc2:CargoEvent',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'eventId',
    'containerNo',
    'eventType',
    'ts',
    'sourceOffsetMin',
    'facilityId',
    'sourceSystem',
    'rawRef',
    'payload',
  ],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    containerNo: CONTAINER_NO,
    eventType: { enum: [...EVENT_TYPES] },
    ts: ISO_UTC,
    sourceOffsetMin: { type: 'integer', minimum: -720, maximum: 840 },
    facilityId: { type: 'string', minLength: 1 },
    terminalId: { type: 'string' },
    gateId: { type: 'string' },
    vehicleNo: { type: 'string' },
    rakeId: { type: 'string' },
    sourceSystem: { enum: [...SOURCE_SYSTEMS] },
    rawRef: { type: 'string', minLength: 1 },
    payload: { type: 'object' },
  },
} as const;

export const gateTransactionSchema = {
  $id: 'jnpa:uc2:GateTransaction',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['gateTxnId', 'gateId', 'direction', 'vehicleNo', 'arrivalTs', 'startTs', 'docsVerified', 'outcome'],
  properties: {
    gateTxnId: { type: 'string' },
    gateId: { type: 'string' },
    direction: { enum: ['IN', 'OUT'] },
    vehicleNo: { type: 'string' },
    containerNo: CONTAINER_NO,
    appointmentRef: { type: 'string' },
    arrivalTs: ISO_UTC,
    startTs: ISO_UTC,
    endTs: ISO_UTC,
    docsVerified: { type: 'array', items: { type: 'string' } },
    outcome: { enum: ['CLEARED', 'HELD', 'REJECTED'] },
  },
} as const;

export const facilitySchema = {
  $id: 'jnpa:uc2:Facility',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['facilityId', 'type', 'name', 'operator', 'geom', 'currentPendency'],
  properties: {
    facilityId: { type: 'string' },
    type: { enum: [...FACILITY_TYPES] },
    name: { type: 'string' },
    operator: { type: 'string' },
    geom: GEOMETRY,
    capacityTEU: { type: 'number', minimum: 0 },
    currentPendency: { type: 'integer', minimum: 0 },
  },
} as const;

export const rakeSchema = {
  $id: 'jnpa:uc2:Rake',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['rakeId', 'ctoOperator', 'trainNo', 'foisRef', 'sidingId', 'terminalId', 'arrivalTs', 'wagonCount', 'direction', 'mixedFlag'],
  properties: {
    rakeId: { type: 'string' },
    ctoOperator: { type: 'string' },
    trainNo: { type: 'string' },
    foisRef: { type: 'string' },
    sidingId: { enum: ['T1', 'T2'] },
    terminalId: { type: 'string' },
    arrivalTs: ISO_UTC,
    placementTs: ISO_UTC,
    removalTs: ISO_UTC,
    departureTs: ISO_UTC,
    wagonCount: { type: 'integer', minimum: 1 },
    direction: { enum: ['INBOUND', 'OUTBOUND'] },
    mixedFlag: { type: 'boolean' },
  },
} as const;

export const scanEventSchema = {
  $id: 'jnpa:uc2:ScanEvent',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['scanId', 'containerNo', 'scannerId', 'flaggedBy', 'startTs'],
  properties: {
    scanId: { type: 'string' },
    containerNo: CONTAINER_NO,
    scannerId: { type: 'string' },
    flaggedBy: { enum: ['CUSTOMS', 'RANDOM'] },
    startTs: ISO_UTC,
    endTs: ISO_UTC,
    result: { enum: ['CLEAR', 'HOLD', 'EXAM'] },
  },
} as const;

export const notificationSchema = {
  $id: 'jnpa:uc2:Notification',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['notifId', 'type', 'severity', 'audienceRoles', 'body', 'createdTs'],
  properties: {
    notifId: { type: 'string' },
    type: { enum: [...NOTIFICATION_TYPES] },
    severity: { enum: ['INFO', 'WARN', 'CRIT'] },
    audienceRoles: { type: 'array', items: { enum: [...ROLES] } },
    facilityId: { type: 'string' },
    containerNo: CONTAINER_NO,
    body: {
      type: 'object',
      required: ['en', 'hi', 'mr'],
      properties: { en: { type: 'string' }, hi: { type: 'string' }, mr: { type: 'string' } },
    },
    createdTs: ISO_UTC,
    ackBy: { type: 'string' },
    ackTs: ISO_UTC,
  },
} as const;

/** All registered schemas, keyed by $id, for the AJV registry. */
export const ALL_SCHEMAS = [
  containerSchema,
  cargoEventSchema,
  gateTransactionSchema,
  facilitySchema,
  rakeSchema,
  scanEventSchema,
  notificationSchema,
] as const;
