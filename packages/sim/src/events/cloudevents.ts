/**
 * CloudEvents 1.0 envelope (prompt §1: "CloudEvents 1.0 envelopes and AsyncAPI
 * 2.6 contracts"). Both the demo console and the live connectors publish onto
 * the SAME Kafka topics using this envelope, so the dashboard cannot tell sim
 * from live except via the Health Card mode badge (Addendum B.2 "Faithful").
 */
import type { CargoEvent } from '@jnpa/schemas';

/** CloudEvents 1.0 structured-mode JSON envelope. */
export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  /** Reverse-DNS-ish event type, e.g. "jnpa.uc2.cargo.GATE_IN". */
  type: string;
  /** Producer identity, e.g. "urn:jnpa:uc2:connector:ulip" or ":sim". */
  source: string;
  /** Unique event id. */
  id: string;
  /** RFC3339 timestamp. */
  time: string;
  /** Subject — the container/rake the event concerns. */
  subject?: string;
  datacontenttype: 'application/json';
  /** Schema reference for `data`. */
  dataschema?: string;
  data: T;
  /** Extension: which integration tier produced this (LIVE/CACHED/SYNTHETIC). */
  jnpamode?: 'LIVE' | 'CACHED' | 'SYNTHETIC';
}

/** Canonical Kafka topic names (also referenced by the AsyncAPI contract). */
export const TOPICS = {
  cargoEvents: 'jnpa.uc2.cargo-events',
  gateTxns: 'jnpa.uc2.gate-transactions',
  rail: 'jnpa.uc2.rail',
  itrho: 'jnpa.uc2.itrho',
  scans: 'jnpa.uc2.scans',
  notifications: 'jnpa.uc2.notifications',
  integrationHealth: 'jnpa.uc2.integration-health',
  gateDecisions: 'jnpa.uc2.gate-decisions', // outbound to terminal TOS (§13)
  crossTwin: 'jnpa.crosstwin.deferred-arrival', // UC2 → UC3 (§12 CGO-2)
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

const SOURCE_BASE = 'urn:jnpa:uc2';

/** Wrap a CargoEvent in a CloudEvents envelope. */
export function cargoEventEnvelope(
  ev: CargoEvent,
  mode: 'LIVE' | 'CACHED' | 'SYNTHETIC',
): CloudEvent<CargoEvent> {
  const producer = mode === 'SYNTHETIC' ? `${SOURCE_BASE}:sim` : `${SOURCE_BASE}:connector:${ev.sourceSystem.toLowerCase()}`;
  return {
    specversion: '1.0',
    type: `jnpa.uc2.cargo.${ev.eventType}`,
    source: producer,
    id: ev.eventId,
    time: ev.ts,
    subject: ev.containerNo,
    datacontenttype: 'application/json',
    dataschema: 'jnpa:uc2:CargoEvent',
    data: ev,
    jnpamode: mode,
  };
}

/** Generic envelope builder for non-cargo events (notifications, health, etc.). */
export function envelope<T>(opts: {
  type: string;
  id: string;
  time: string;
  subject?: string;
  data: T;
  dataschema?: string;
  mode?: 'LIVE' | 'CACHED' | 'SYNTHETIC';
  sourceSuffix?: string;
}): CloudEvent<T> {
  return {
    specversion: '1.0',
    type: opts.type,
    source: `${SOURCE_BASE}:${opts.sourceSuffix ?? 'platform'}`,
    id: opts.id,
    time: opts.time,
    subject: opts.subject,
    datacontenttype: 'application/json',
    dataschema: opts.dataschema,
    data: opts.data,
    jnpamode: opts.mode,
  };
}
