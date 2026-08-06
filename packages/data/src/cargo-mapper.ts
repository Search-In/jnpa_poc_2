/**
 * Cargo mapper — projects the POC-3 shared Cargo record (`CargoOut`, served at
 * `GET /api/cargo`) into the canonical {@link ContainerMovementDTO} the existing
 * Cargo panel binds to. POC-3 is the single source of truth for cargo; POC-2
 * keeps no cargo store, so this is a pure, side-effect-free view transform.
 *
 * The projection is FAITHFUL — every field is either taken verbatim from the
 * record or derived from a real field on it (customs status, release flag, yard,
 * gate, ISO-6346 owner prefix). No future/fabricated events are invented; the
 * derived event trail is a summary of the record's known milestones stamped with
 * the record's own `created_at` / `updated_at`. Fields POC-3 does not carry
 * (origin stream, ISO type, weight, seal) get schema-valid placeholders and are
 * NOT surfaced by the migrated panel — the raw record rides along on
 * `dto.cargo` so the UI reads cargo-native fields directly.
 */
import type { Container, ContainerStatus, ScanEvent, ScanResult, SourceSystem } from '@jnpa/schemas';
import { parseContainerNo } from '@jnpa/schemas';
import type { CargoRecord, ContainerMovementDTO } from './interface.js';

/** Shipping-line prefix (owner + category, e.g. "MAEU") from the ISO-6346 number. */
function lineFromContainerNo(containerNo: string): string {
  const parsed = parseContainerNo(containerNo);
  return parsed ? containerNo.slice(0, 4) : containerNo.slice(0, 4);
}

/** Lifecycle states at or past yard assignment (the box is in the yard). */
const YARDED_STATES = [
  'YARD_ASSIGNED', 'YARD_POSITION_ALLOCATED', 'REEFER_PLANNED',
  'RAKE_ASSIGNED', 'SCAN_PENDING', 'VERIFIED',
];

/**
 * Derive the canonical status from the record's real state.
 *
 * ⚠ `lifecycle_status` and `customs_status` are INDEPENDENT tracks on POC-3.
 * `POST /verify` advances the lifecycle to VERIFIED but deliberately does not set
 * a customs disposition — it only inserts a `cargo_scan_verification` row. This
 * function used to read customs_status ALONE, so a container that had just been
 * verified still reported `UNDER_SCAN` (from `customs_status = UNDER_INSPECTION`)
 * and looked as though nothing had happened.
 *
 * The precedence below resolves that:
 *  1. Released wins outright.
 *  2. A customs HOLD wins next — a hold is a hold whatever the lifecycle says.
 *  3. VERIFIED beats UNDER_INSPECTION: the scan has concluded, so the box is no
 *     longer under scan even though the customs disposition was never updated.
 *  4. Otherwise fall back to the customs/yard derivation, which is all a legacy
 *     row without a lifecycle_status has.
 */
function deriveStatus(c: CargoRecord): ContainerStatus {
  const lc = c.lifecycle_status ?? '';
  if (c.is_released || lc === 'RELEASED') return 'GATE_OUT';
  if (c.customs_status === 'HELD') return 'HELD_CUSTOMS';
  if (lc === 'VERIFIED') return 'IN_YARD';
  if (c.customs_status === 'UNDER_INSPECTION') return 'UNDER_SCAN';
  if (c.yard_block || YARDED_STATES.includes(lc)) return 'IN_YARD';
  return 'EXPECTED';
}

/** Human/event label for the customs milestone (free-text eventType). */
function customsEventType(status: CargoRecord['customs_status']): string {
  switch (status) {
    case 'CLEARED':
      return 'CUSTOMS_CLEARED';
    case 'HELD':
      return 'HELD_CUSTOMS';
    case 'UNDER_INSPECTION':
      return 'UNDER_SCAN';
    default:
      return 'CUSTOMS_PENDING';
  }
}

/**
 * Build the ordered milestone trail from the record's known facts only. Each
 * entry is stamped with a real timestamp on the record (`created_at` for the
 * booking milestone, `updated_at` for state that has since changed). ETA is a
 * forward-looking estimate and is deliberately NOT added as a past event.
 */
function deriveTrail(c: CargoRecord): ContainerMovementDTO['trail'] {
  const at = c.yard_block ?? c.gate ?? '';
  const trail: ContainerMovementDTO['trail'] = [
    { eventType: 'EXPECTED', ts: c.created_at, facilityId: c.gate ?? at, sourceSystem: 'SHIPLINE' as SourceSystem },
  ];
  if (c.yard_block) {
    trail.push({ eventType: 'IN_YARD', ts: c.updated_at, facilityId: c.yard_block, sourceSystem: 'TOS' as SourceSystem });
  }
  trail.push({
    eventType: customsEventType(c.customs_status),
    ts: c.updated_at,
    facilityId: at,
    sourceSystem: 'ICEGATE' as SourceSystem,
  });
  // The recorded lifecycle transition, appended AFTER the customs milestone so it
  // becomes `lastEventType`. Without it the panel's "Last event" column reported a
  // customs disposition that verification never updates — a container advanced to
  // VERIFIED still read as UNDER_SCAN, with no sign the scan had concluded.
  //
  // Only states the customs/yard derivation cannot express are added, so the
  // column keeps its existing vocabulary everywhere else.
  const lc = c.lifecycle_status ?? '';
  if (lc === 'VESSEL_DISCHARGED' || lc === 'VERIFIED' || YARDED_STATES.includes(lc)) {
    trail.push({
      eventType: lc,
      ts: c.updated_at,
      facilityId: at,
      sourceSystem: 'TOS' as SourceSystem,
    });
  }
  if (c.is_released || lc === 'RELEASED') {
    trail.push({ eventType: 'GATE_OUT', ts: c.updated_at, facilityId: c.gate ?? at, sourceSystem: 'TOS' as SourceSystem });
  }
  return trail;
}

/** Customs status → scan result: HELD holds, UNDER_INSPECTION means an exam is
 * under way, CLEARED clears; PENDING has no result yet (scan not concluded). */
function scanResultFor(status: CargoRecord['customs_status']): ScanResult | undefined {
  switch (status) {
    case 'HELD':
      return 'HOLD';
    case 'UNDER_INSPECTION':
      return 'EXAM';
    case 'CLEARED':
      return 'CLEAR';
    default:
      return undefined;
  }
}

/**
 * Project a POC-3 cargo record into a canonical {@link ScanEvent} for the customs
 * scan queue. The queue is the set of in-port (not-yet-released) containers; each
 * carries its customs state as the scan result so the panel — and its Release
 * action — operate on REAL cargo records, never simulated ones. e-Seal number and
 * pre-doc status (added by the latest POC-3 deployment) are mapped to the panel's
 * e-Seal / Pre-doc columns; when the backend returns null they are omitted, so the
 * panel keeps rendering "—" (no fabricated values).
 */
export function mapCargoToScanEvent(c: CargoRecord): ScanEvent {
  const result = scanResultFor(c.customs_status);
  const event: ScanEvent & {
    sealNo?: string; esealStatus?: string; preDoc?: string;
    yardBlock?: string; lifecycleStatus?: string;
  } = {
    scanId: `SCAN-${c.container_number}`,
    containerNo: c.container_number,
    scannerId: c.camera_id ?? c.gate ?? 'CUSTOMS-SCANNER',
    flaggedBy: 'CUSTOMS',
    startTs: c.updated_at ?? c.created_at,
    ...(c.customs_status === 'CLEARED' ? { endTs: c.updated_at } : {}),
    ...(result ? { result } : {}),
    ...(c.eseal_number ? { sealNo: c.eseal_number } : {}),
    ...(c.eseal_status ? { esealStatus: c.eseal_status } : {}),
    ...(c.pre_document_status ? { preDoc: c.pre_document_status } : {}),
    // Carry the yard block (already present on this record) so the Scan Queue can
    // derive Yard-Assignment eligibility WITHOUT a second GET /api/cargo request.
    ...(c.yard_block ? { yardBlock: c.yard_block } : {}),
    // The lifecycle position, for the same reason: the Scan tab's actions are
    // GATES (yard-assign → verify → release) and it cannot decide which one is
    // next without knowing where the container actually is.
    ...(c.lifecycle_status ? { lifecycleStatus: c.lifecycle_status } : {}),
  };
  return event;
}

/** Project one POC-3 cargo record into the canonical movement DTO. */
export function mapCargoToMovement(c: CargoRecord): ContainerMovementDTO {
  const containerNo = c.container_number;
  const container: Container = {
    containerNo,
    // Fields POC-3 does not carry — schema-valid placeholders, not surfaced by
    // the migrated panel (which reads cargo-native fields off `dto.cargo`).
    isoTypeCode: '',
    sizeFt: 20,
    laden: !c.is_released,
    grossWtKg: 0,
    cargoType: '',
    lineOwner: lineFromContainerNo(containerNo),
    currentSealNo: '',
    status: deriveStatus(c),
    // Origin stream is not modelled by POC-3; default to a valid enum member.
    originStream: 'IMPORT_CFS',
    lastUpdatedTs: c.updated_at,
  };
  const trail = deriveTrail(c);
  const last = trail[trail.length - 1]!;
  return {
    container,
    lastEventType: last.eventType,
    lastEventTs: last.ts,
    facilityId: c.yard_block ?? c.gate ?? '',
    trail,
    cargo: c,
  };
}
