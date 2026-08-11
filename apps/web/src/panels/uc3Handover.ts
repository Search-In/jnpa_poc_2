/**
 * What UC-2 actually handed to UC-III when a container was released.
 *
 * `release_cargo` emits `cargo.released` carrying the yard location and the
 * vehicle details (`services/cargo/service.py`), and RELEASED is the terminal
 * state of this lifecycle — `_LIFECYCLE_RANK` has nothing above it. The truck
 * leg (Form 13 → PIN → EIR → CODECO gate-out) belongs to UC-III.
 *
 * Until this existed the handover was invisible after the fact. The release
 * dialog explains it at the moment you click, and then the row simply becomes
 * RELEASED with a GATE_OUT chip that is itself derived from `is_released`
 * (cargo-mapper `deriveStatus`) rather than from any recorded gate event. Having
 * walked an operator through flag → scan → verify → OOC → release, the last step
 * said nothing about where the box went.
 *
 * ⚠ These are the fields the event CARRIED, read back off the same record. They
 * are not confirmation that UC-III acted on it — UC-2 does not observe the truck
 * leg, and claiming otherwise would invent a gate-out that may never have
 * happened. A field the record never held reports as "not recorded", never as an
 * empty success.
 *
 * React-free so the rules can be unit-tested without rendering.
 */
import type { GateEvent } from '@jnpa/data';

/** The subset of a cargo record the release event drew on. */
export interface ReleasedCargo {
  lifecycle_status?: string | null;
  is_released?: boolean | null;
  yard_block?: string | null;
  vehicle_number?: string | null;
  updated_at?: string | null;
}

export interface HandoverFact {
  label: string;
  /** The recorded value, or null when the record never carried one. */
  value: string | null;
  /** Shown in place of a value when it is null — why it is absent, not "—". */
  absent?: string;
}

export interface Handover {
  /** The event UC-III consumes. */
  event: 'cargo.released';
  facts: HandoverFact[];
  /**
   * True when every field the event is specified to carry was actually present.
   * A partial handover is still a real handover — UC-III can dispatch a truck
   * against a yard location alone — but the gap is worth naming rather than
   * rendering a blank cell that reads as "nothing to see".
   */
  complete: boolean;
}

/** Has this container left UC-2's lifecycle? */
export function isHandedOver(cargo: ReleasedCargo | null | undefined): boolean {
  if (!cargo) return false;
  return Boolean(cargo.is_released) || (cargo.lifecycle_status ?? '').toUpperCase() === 'RELEASED';
}

/**
 * The handover as facts, or null when the container has not been released.
 *
 * Deliberately reads the CARGO RECORD rather than the event log: the event is
 * fire-and-forget onto the bus, so the record is the only thing UC-2 can still
 * show truthfully after the fact.
 */
export function handoverFor(cargo: ReleasedCargo | null | undefined): Handover | null {
  if (!isHandedOver(cargo)) return null;
  const c = cargo as ReleasedCargo;
  const facts: HandoverFact[] = [
    {
      label: 'Yard location',
      value: c.yard_block || null,
      absent: 'no block on the record when it was released',
    },
    {
      label: 'Vehicle',
      value: c.vehicle_number || null,
      absent: 'no haulage plate was allocated in UC-2',
    },
    {
      label: 'Released at',
      value: c.updated_at || null,
      absent: 'timestamp not recorded',
    },
  ];
  return {
    event: 'cargo.released',
    facts,
    complete: facts.every((f) => f.value !== null),
  };
}

/**
 * What happens next, and who owns it.
 *
 * Named steps rather than prose because each one is a real document in the
 * import lifecycle (`02_Import_Container_Lifecycle.md` steps 7-10) that UC-2
 * renders as a register and never writes.
 */
export const UC3_NEXT_STEPS: ReadonlyArray<{ step: string; owner: string }> = [
  { step: 'Truck assignment against the released container', owner: 'UC-III control room' },
  { step: 'Form 13 / PIN pickup ticket', owner: 'Terminal operator' },
  { step: 'EIR at the gate', owner: 'Terminal operator' },
  { step: 'CODECO gate-out on truck', owner: 'Terminal operator' },
];

/**
 * The latest crossing of one type, from `core.gate_event`.
 *
 * Picks by TIMESTAMP rather than trusting the API's order. `GET /api/gate/events`
 * does sort newest-first today, but a caller that merged two queries, or a future
 * change to that ORDER BY, would silently make "the latest gate-out" the oldest
 * one — and this answers "has the box actually left", so being wrong is worse
 * than being slow. Rows with no timestamp sort last: they cannot be shown to be
 * the most recent, so they must not win by default.
 */
export function latestCrossing(
  events: readonly GateEvent[] | null | undefined,
  eventType: 'GATE_IN' | 'GATE_OUT',
): GateEvent | null {
  let best: GateEvent | null = null;
  let bestTs = -Infinity;
  for (const e of events ?? []) {
    if ((e.event_type ?? '').toUpperCase() !== eventType) continue;
    const t = e.ts ? new Date(e.ts).getTime() : NaN;
    const score = Number.isNaN(t) ? -Infinity : t;
    if (best === null || score > bestTs) {
      best = e;
      bestTs = score;
    }
  }
  return best;
}

/**
 * Did a truck actually take this container out?
 *
 * The ONLY honest answer to that question in UC-2. The GATE_OUT status on a
 * cargo row is derived from `is_released` — it means "UC-2 released the box",
 * not "a truck crossed a lane with it". A recorded crossing is the evidence.
 */
export function hasRecordedGateOut(events: readonly GateEvent[] | null | undefined): boolean {
  return latestCrossing(events, 'GATE_OUT') !== null;
}
