/**
 * Does a customs badge trace to a real customs record? (ticket UC2-004)
 *
 * `core.cargo.customs_status` is a column somebody can set. The customs corpus —
 * ICEGATE bills of entry with their out-of-charge, and the RMS scanning
 * selections — is the thing that can *justify* setting it. The two are joined by
 * nothing: today 14 of the 15 non-PENDING cargo rows carry a customs status that
 * resolves to no document at all, and every container currently in the scan
 * queue is one of them.
 *
 * Briefing dimension 10 asks that every on-screen status be backed by a record.
 * So rather than quietly render `CLEARED`, the UI resolves each badge against
 * `GET /api/customs/containers/{cn}` and says which it is: **traced**, with the
 * document reference, or **simulated**.
 *
 * ⚠ WHAT BACKS WHAT. Deliberately strict — a badge is only "traced" when the
 * corpus contains the document that would actually produce it:
 *
 *   CLEAR ← an out-of-charge line. The OOC *is* customs clearance; nothing else
 *           in the corpus grants it.
 *   EXAM  ← an RMS scanning selection. The RMS file is what selects a box for
 *           scanning, so it is the only record that can put one under exam.
 *   HOLD  ← nothing. The corpus records no customs hold, anywhere. A HOLD badge
 *           is therefore ALWAYS simulated, and saying so is the honest answer —
 *           not a gap to paper over by accepting a weaker document as proof.
 *
 * React-free so the rules can be unit-tested without rendering.
 */
import type { ContainerCustomsView } from '@jnpa/data';

/** The scan result a badge asserts. `undefined` = PENDING, which asserts nothing. */
export type CustomsResult = 'CLEAR' | 'HOLD' | 'EXAM' | undefined;

export interface CustomsEvidence {
  /** True only when a document that would produce this status was found. */
  traced: boolean;
  /** The document reference to show, e.g. "BE 9259230 · OOC 2071217438". */
  reference?: string;
  /** Why it is untraced — shown on the SIMULATED chip's tooltip. */
  reason?: string;
}

/**
 * Resolve one badge against the customs layer.
 *
 * `view` is null when the container appears in no customs document at all (the
 * API 404s), which the caller must pass through rather than treat as an error.
 */
export function customsEvidenceFor(
  result: CustomsResult,
  view: ContainerCustomsView | null,
): CustomsEvidence {
  if (!result) {
    // PENDING makes no claim, so there is nothing to substantiate.
    return { traced: true };
  }

  if (!view) {
    return {
      traced: false,
      reason: 'This container appears in no customs document — no manifest line, '
        + 'no bill of entry, no RMS selection. The status was set on the cargo '
        + 'record directly.',
    };
  }

  if (result === 'CLEAR') {
    const ooc = view.ooc?.[0];
    if (ooc) {
      const be = `BE ${ooc.bill_of_entry_no}`;
      const num = ooc.out_of_charge_no ? ` · OOC ${ooc.out_of_charge_no}` : '';
      const date = ooc.out_of_charge_date ? ` · ${ooc.out_of_charge_date}` : '';
      return { traced: true, reference: `${be}${num}${date}` };
    }
    return {
      traced: false,
      reason: 'The container is in the customs corpus, but no bill of entry grants '
        + 'it out-of-charge — and out-of-charge is what clearance means.',
    };
  }

  if (result === 'EXAM') {
    const rms = view.rms?.[0];
    if (rms) {
      const igm = rms.igm_no ? `IGM ${rms.igm_no}` : 'RMS selection';
      const where = rms.scan_location ? ` · ${rms.scan_location}` : '';
      const machine = rms.scan_machine ? ` · machine ${rms.scan_machine}` : '';
      return { traced: true, reference: `${igm}${where}${machine}` };
    }
    return {
      traced: false,
      reason: 'No RMS scanning selection names this container, so nothing in the '
        + 'data put it under examination.',
    };
  }

  // HOLD.
  return {
    traced: false,
    reason: 'The corpus records no customs holds at all — there is no document '
      + 'type that could substantiate this badge. Shown as simulated by design.',
  };
}
