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
  // The generic entry. Callers that know whether a scan was actually ordered
  // should use `gateUi(gate, kind)` instead — see VERIFY_UI.
  verify: {
    label: 'Verify for release',
    title: 'Release verification',
    icon: 'check-circle',
    cta: 'Confirm — mark verified',
    explain: 'Records the pre-release verification and advances the container to '
      + 'VERIFIED. This is the gate Release waits on: the state machine will not '
      + 'release a container that has not passed it.',
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

/**
 * TWO DIFFERENT CHECKS wear the `verify` gate, and calling both of them a scan
 * was wrong.
 *
 * The state machine makes VERIFIED mandatory before RELEASED for EVERY import
 * container. But scanning is a branch — `02_Import_Container_Lifecycle.md` step 5
 * reads "[RMS scan if selected]" — so most boxes pass this gate without any scan
 * ever being ordered. Labelling their button "Record scan" invented a customs
 * examination that never happened, on containers customs had already granted
 * out-of-charge.
 *
 *   SCAN           a scan WAS ordered: the box is on a filed RMS scan list, or an
 *                  operator flagged it EXAM/HOLD. Recording the result is the act.
 *   RELEASE_CHECK  no scan was ordered. This is the custody check before release,
 *                  and the copy must not imply a scan took place.
 */
export type VerifyKind = 'SCAN' | 'RELEASE_CHECK';

export const VERIFY_UI: Record<VerifyKind, (typeof GATE_UI)['verify'] & { fail: string }> = {
  SCAN: {
    label: 'Record scan',
    title: 'Record scan result',
    icon: 'check-circle',
    cta: 'Pass — mark verified',
    fail: 'Fail — hold for exam',
    explain: 'This container was selected for scanning — by a filed RMS scan list, or '
      + 'by an operator flagging it. Recording the result advances it to VERIFIED, '
      + 'which is the gate Release waits on.',
  },
  RELEASE_CHECK: {
    label: 'Verify for release',
    title: 'Release verification',
    icon: 'check-circle',
    cta: 'Confirm — mark verified',
    fail: 'Fail — withhold release',
    explain: 'No scan was ordered for this container: RMS did not select it and nobody '
      + 'has flagged it. VERIFIED is still a mandatory gate before RELEASED, so this '
      + 'records the pre-release check — it does NOT claim a scan took place.',
  },
};

/**
 * The copy for a gate. Pass `verify` when the caller knows whether a scan was
 * ordered; without it the wording stays generic rather than guessing.
 */
export function gateUi(gate: CargoGate, verify?: VerifyKind) {
  const key = uiGate(gate);
  if (key === 'verify' && verify) return VERIFY_UI[verify];
  return { ...GATE_UI[key], fail: 'Fail — hold for exam' };
}

/** The gate whose copy applies; a released row borrows the release entry. */
export const uiGate = (g: CargoGate): Exclude<CargoGate, 'done'> =>
  (g === 'done' ? 'release' : g);

/**
 * A combination of the two tracks that cannot be true of a real container.
 *
 * The tracks are INDEPENDENT — one is the port's custody of the box, the other
 * is customs' disposition of the goods — but independent is not the same as
 * "any pairing is legitimate". Out-of-charge is the permission to remove goods
 * from customs control, so a box customs is still examining, or holding, cannot
 * lawfully have been gate-out released.
 *
 * The server permits it: `release_cargo` gates on the lifecycle alone (it
 * requires VERIFIED and never reads `customs_status`). That is a real gap, and
 * until it is closed the UI's job is to make the contradiction visible rather
 * than render it as two unremarkable chips side by side.
 */
export function customsLifecycleConflict(
  customsStatus: string | null | undefined,
  lifecycle: string | null | undefined,
): { severity: 'error' | 'warning'; message: string } | null {
  const cs = (customsStatus ?? '').toUpperCase();
  const lc = (lifecycle ?? '').toUpperCase();
  if (cs !== 'HELD' && cs !== 'UNDER_INSPECTION') return null;

  const what = cs === 'HELD' ? 'is held by customs' : 'is under customs examination';

  if (lc === 'RELEASED') {
    return {
      severity: 'error',
      message: `This container ${what}, yet it has been released from the port. `
        + 'Those cannot both be true: out-of-charge is what permits goods to leave '
        + 'customs control. Either the customs status is stale or the release was '
        + 'recorded in error.',
    };
  }
  if (lc === 'VERIFIED') {
    return {
      severity: 'warning',
      message: `The scan gate has passed but this container ${what}. Releasing it now `
        + 'would put the record in a state no real container can be in — the release '
        + 'gate checks the lifecycle only and will not stop you.',
    };
  }
  return null;
}
