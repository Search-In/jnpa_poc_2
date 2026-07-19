/**
 * build-reference-dataset — fold the parsed reference sources (shipping-line
 * IAL/EAL rows + EIR gate events) into a single cargo override the
 * {@link SimWorld} seam can splice into the mock dataset.
 *
 * Merge rules (deterministic, no Date.now):
 *   - Containers are keyed by ISO-6346 number. A shipping-line row wins on the
 *     container projection (it carries ISO type, weight, seal, reefer, hazmat,
 *     stream); an EIR contributes its real gate event and fills in containers no
 *     list mentions.
 *   - Every container must own at least one event so Container Movement can fold
 *     a trail. EIR containers already have their real gate event. A shipping-line
 *     container with no EIR gets ONE derived milestone stamped at the dataset
 *     window origin (`asOfIso`): a yard discharge for imports, a gate-in for
 *     exports. This mirrors how the POC-3 cargo-mapper derives a milestone trail
 *     from a record's known facts — a faithful projection, not invented history.
 */
import type { CargoEvent, Container } from '@jnpa/schemas';
import type { ShiplineRecord } from './parse-shipline-csv.js';
import type { EirRecord } from './parse-eir-json.js';

/** The cargo slice the reference path contributes to the mock dataset. */
export interface ReferenceCargoOverride {
  containers: Container[];
  events: CargoEvent[];
}

export interface BuildReferenceInput {
  shipline?: ShiplineRecord[];
  eir?: EirRecord[];
  /** Dataset window origin (ISO-8601 UTC); stamps derived shipping-line events. */
  asOfIso: string;
}

/** Derive the single milestone event for a shipping-line container with no EIR. */
function deriveShiplineEvent(rec: ShiplineRecord, asOfIso: string): CargoEvent {
  const { container } = rec;
  const isImport = container.originStream.startsWith('IMPORT');
  const eventType = isImport ? 'YARD_MOVE' : 'GATE_IN';
  return {
    eventId: `${rec.source}-${container.containerNo}-${eventType}`,
    containerNo: container.containerNo,
    eventType,
    ts: asOfIso,
    sourceOffsetMin: 330,
    facilityId: rec.pod ?? '',
    sourceSystem: 'SHIPLINE',
    rawRef: `raw/reference/${rec.source.toLowerCase()}/${container.containerNo}`,
    payload: {
      source: rec.source,
      movement: isImport ? 'DISCHARGE' : 'ACCEPTED',
      ...(rec.pod ? { pod: rec.pod } : {}),
      ...(rec.pol ? { pol: rec.pol } : {}),
      ...(rec.line ? { line: rec.line } : {}),
      isoTypeCode: container.isoTypeCode,
    },
  };
}

/** Fold parsed reference sources into one deduped cargo override. */
export function buildReferenceDataset(input: BuildReferenceInput): ReferenceCargoOverride {
  const containers = new Map<string, Container>();
  const events: CargoEvent[] = [];
  const haveEvent = new Set<string>();

  for (const e of input.eir ?? []) {
    containers.set(e.container.containerNo, e.container);
    events.push(e.event);
    haveEvent.add(e.container.containerNo);
  }

  for (const s of input.shipline ?? []) {
    // Shipping-line row wins on the container projection (richer fields).
    containers.set(s.container.containerNo, s.container);
    if (!haveEvent.has(s.container.containerNo)) {
      events.push(deriveShiplineEvent(s, input.asOfIso));
      haveEvent.add(s.container.containerNo);
    }
  }

  return { containers: [...containers.values()], events };
}
