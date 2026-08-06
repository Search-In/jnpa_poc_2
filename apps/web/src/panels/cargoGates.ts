/**
 * The cargo lifecycle gates, in one place.
 *
 * Mirrors the server's state machine (`services/cargo/service.py`
 * `_LIFECYCLE_RANK` / `_MANDATORY_STATES`). It is forward-only, and a transition
 * that skips a mandatory gate is rejected with a 409 `illegal_transition`.
 *
 *   CREATED → VESSEL_DISCHARGED → [PENDENCY] → YARD_ASSIGNED
 *           → [YARD_POSITION_ALLOCATED | REEFER_PLANNED | RAKE_ASSIGNED]
 *           → VERIFIED → RELEASED
 *
 * Shared by the Movements and Scan panels so they cannot disagree about what a
 * container's next step is — they previously each had their own idea, which is how
 * a VERIFIED box ended up with no way to release it from Movements.
 *
 * ⚠ `lifecycle_status` and `customs_status` are INDEPENDENT tracks. Verification
 * advances the lifecycle but deliberately does not set a customs disposition
 * (`POST /verify` only inserts a `cargo_scan_verification` row). Never infer one
 * from the other.
 */

/** The next action a container is eligible for, or `done` when released. */
export type CargoGate = 'discharge' | 'yard' | 'verify' | 'release' | 'done';

/** Lifecycle states at or past yard assignment but before verification. */
const YARDED = [
  'YARD_ASSIGNED', 'YARD_POSITION_ALLOCATED', 'REEFER_PLANNED',
  'RAKE_ASSIGNED', 'SCAN_PENDING',
];

/** The export leg runs its own states and shares none of these gates. */
export const EXPORT_STATES = [
  'EXPORT_BOOKED', 'FORM13_ISSUED', 'EXPORT_GATE_IN', 'VGM_CAPTURED',
  'LEO_GRANTED', 'LOAD_LISTED', 'VESSEL_LOADED',
];

/**
 * The next gate for a container, given where it is.
 *
 * `inYard` matters because the server's yard-assignment is LENIENT — it accepts
 * `CREATED`, `VESSEL_DISCHARGED` and `PENDENCY`. A row whose `yard_block` was
 * written directly (without the transition) is physically in the yard while its
 * lifecycle still reads `CREATED`; its real next step is to catch that up, not to
 * be discharged again.
 *
 * Returns `null` when no gate applies — an export container, or an unknown state.
 */
export function nextGate(
  lifecycle: string | null | undefined,
  opts: { inYard?: boolean; direction?: string | null } = {},
): CargoGate | null {
  const lc = lifecycle || 'CREATED';
  if ((opts.direction ?? '').toUpperCase() === 'EXPORT' || EXPORT_STATES.includes(lc)) return null;

  if (lc === 'RELEASED') return 'done';
  if (lc === 'VERIFIED') return 'release';
  if (YARDED.includes(lc)) return 'verify';
  // Behind yard-assignment. If it is already sitting in a block, catching the
  // record up is the next step; otherwise it still has to come off the vessel.
  if (opts.inYard) return 'yard';
  if (lc === 'CREATED') return 'discharge';
  return 'yard'; // VESSEL_DISCHARGED / PENDENCY with no block yet
}

/** Button label, icon and confirm-dialog copy per gate. */
export const GATE_UI: Record<Exclude<CargoGate, 'done'>, {
  label: string; title: string; icon: string; cta: string; explain: string;
}> = {
  discharge: {
    label: 'Discharge',
    title: 'Discharge from vessel',
    icon: 'export',
    cta: 'Confirm discharge',
    explain: 'Records THIS container coming off the vessel (CREATED → '
      + 'VESSEL_DISCHARGED) and raises cargo.vessel_discharged on the event bus. '
      + 'It is a per-container event — other boxes on the same ship are unaffected.',
  },
  yard: {
    label: 'Assign yard',
    title: 'Confirm yard assignment',
    icon: 'pin-tear',
    cta: 'Confirm yard assignment',
    explain: 'Records the YARD_ASSIGNED transition. A container whose yard block was '
      + 'written directly still reads as CREATED to the state machine; confirming '
      + 'catches the record up so it can then be scanned and released.',
  },
  verify: {
    label: 'Record scan',
    title: 'Record scan result',
    icon: 'check-circle',
    cta: 'Pass — mark verified',
    explain: 'Records the customs/scan verification and advances the container to '
      + 'VERIFIED. This is the gate Release waits on: a container cannot be released '
      + 'until its scan has been concluded.',
  },
  release: {
    label: 'Release',
    title: 'Release container',
    icon: 'unlock',
    cta: 'Confirm release',
    explain: 'Releases the container from the port and hands it over to UC-III — the '
      + 'event carries the yard location and vehicle details.',
  },
};

/** The gate whose copy applies; a released row borrows the release entry. */
export const uiGate = (g: CargoGate): Exclude<CargoGate, 'done'> =>
  (g === 'done' ? 'release' : g);
