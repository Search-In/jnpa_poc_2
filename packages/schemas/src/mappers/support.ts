/**
 * Shared helpers for all mappers (§4). Every mapper converts a native format to
 * one or more canonical CargoEvents / entities and ALWAYS records a rawRef so
 * the original artifact is auditable (IPR/handover clause).
 */
import type { CargoEvent } from '../entities/cargo-event.js';

/** Result of a mapping run. `warnings` surface non-fatal interpretation notes. */
export interface MapResult<T> {
  data: T;
  rawRef: string;
  warnings: string[];
}

/**
 * Deterministic raw-ref builder. In production this is the object-store key
 * after the raw bytes are persisted; here it is a stable, content-addressable
 * path so golden tests are reproducible. Format:
 *   raw/<sourceSystem>/<format>/<externalRef>
 */
export function makeRawRef(sourceSystem: string, format: string, externalRef: string): string {
  const safe = externalRef.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `raw/${sourceSystem.toLowerCase()}/${format.toLowerCase()}/${safe}`;
}

/**
 * Parse an EDIFACT DTM (Date/Time/Period) value into a UTC ISO string plus the
 * preserved source offset (minutes). Supports the common format qualifiers:
 *   102 = CCYYMMDD
 *   203 = CCYYMMDDHHMM
 *   204 = CCYYMMDDHHMMSS
 *   303 = CCYYMMDDHHMMZZZ (with offset, e.g. +0530 encoded as zone offset)
 *
 * EDIFACT carries local wall-clock time; we treat the value as being in the
 * given offset (default IST +330 for JNPT feeds) and convert to UTC, preserving
 * the offset for reversibility (§3).
 */
export function parseEdifactDateTime(
  value: string,
  format: string,
  defaultOffsetMin = 330,
): { iso: string; offsetMin: number } {
  const v = value.padEnd(8, '0');
  const year = Number(v.slice(0, 4));
  const month = Number(v.slice(4, 6));
  const day = Number(v.slice(6, 8));
  let hour = 0;
  let minute = 0;
  let second = 0;
  let offsetMin = defaultOffsetMin;

  if (format === '203' || format === '204' || format === '303') {
    hour = Number(v.slice(8, 10) || '0');
    minute = Number(v.slice(10, 12) || '0');
  }
  if (format === '204') {
    second = Number(v.slice(12, 14) || '0');
  }
  if (format === '303' && v.length >= 15) {
    // trailing zone code, e.g. "+0530" not standard in 303 but tolerated here
    const zone = value.slice(12);
    const m = /([+-])(\d{2})(\d{2})/.exec(zone);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      offsetMin = sign * (Number(m[2]) * 60 + Number(m[3]));
    }
  }

  // Construct the instant: local wall-clock minus offset = UTC.
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMin * 60_000;
  return { iso: new Date(utcMillis).toISOString(), offsetMin };
}

/** Stable event-id derivation so re-mapping the same message is idempotent. */
export function deriveEventId(
  sourceSystem: string,
  format: string,
  externalRef: string,
  containerNo: string,
  eventType: string,
): string {
  return `${sourceSystem}:${format}:${externalRef}:${containerNo}:${eventType}`;
}

/** Narrow a partial CargoEvent build, asserting required fields are present. */
export function finalizeEvent(e: CargoEvent): CargoEvent {
  if (!e.containerNo) throw new Error('mapper: CargoEvent missing containerNo');
  if (!e.facilityId) throw new Error('mapper: CargoEvent missing facilityId');
  if (!e.rawRef) throw new Error('mapper: CargoEvent missing rawRef');
  return e;
}
