/**
 * Who belongs in the scan queue?
 *
 * Scanning is a BRANCH of the import lifecycle, not a step every box takes.
 * `markdowns/02_Import_Container_Lifecycle.md` puts it at step 5 as
 * "[RMS scan if selected]", between yard and customs out-of-charge — most
 * consignments are facilitated by RMS and are never scanned at all.
 *
 * The backend queue cannot express that. Its rule is "yard-assigned, not
 * released, not yet verified", because the state machine makes VERIFIED a
 * mandatory gate before RELEASED for *every* container. So it returns
 * facilitated boxes too — including ones customs has already granted
 * out-of-charge — and the tab then offered them a Record-scan button for a scan
 * nobody ever ordered.
 *
 * Two things can put a container under the scanner, and only these two:
 *
 *   RMS      the box is named on a filed RMS scan list — the customs document
 *            that selects boxes for scanning. Authoritative and evidenced.
 *   FLAGGED  an operator flagged it EXAM or HOLD on Movements, which writes
 *            `customs_status`. Action-driven rather than document-driven, but a
 *            real instruction to examine the box.
 *
 * Anything else is facilitated. It still needs release verification, but that is
 * a custody gate on Movements — not a customs scan, and not this tab's business.
 *
 * React-free so the rule can be tested without rendering.
 */
import type { CustomsResult } from './customsEvidence.js';

export type ScanSelectionReason = 'RMS' | 'FLAGGED';

export interface ScanSelection {
  /** Null when nothing selected this container for scanning. */
  reason: ScanSelectionReason | null;
  /** Why it is (or is not) in the queue — shown to the operator. */
  explain: string;
}

export function scanSelectionFor(result: CustomsResult, inRmsList: boolean): ScanSelection {
  // The filed scan list outranks the flag: it is the document that ordered the
  // scan, so it is the better answer even when both are true.
  if (inRmsList) {
    return {
      reason: 'RMS',
      explain: 'Selected for scanning by a filed RMS scan list.',
    };
  }
  if (result === 'EXAM' || result === 'HOLD') {
    return {
      reason: 'FLAGGED',
      explain: result === 'HOLD'
        ? 'Flagged HOLD by an operator — examine before release.'
        : 'Flagged for examination by an operator.',
    };
  }
  return {
    reason: null,
    explain: result === 'CLEAR'
      ? 'Customs granted out-of-charge and RMS did not select it for scanning, so no scan is due.'
      : 'RMS did not select this container for scanning and nobody has flagged it.',
  };
}

/**
 * Partition a queue into the boxes a scan is actually due on, and the rest.
 *
 * `alwaysKeep` holds containers the operator has acted on in this session; they
 * stay visible whatever the rule says, because hiding a row the moment someone
 * touches it is the behaviour this panel already had to fix once.
 */
export function partitionScanQueue<T>(
  rows: T[],
  opts: {
    containerNoOf: (row: T) => string;
    resultOf: (row: T) => CustomsResult;
    rmsSelected: ReadonlySet<string>;
    alwaysKeep?: ReadonlySet<string>;
  },
): { due: T[]; notDue: T[] } {
  const due: T[] = [];
  const notDue: T[] = [];
  for (const row of rows) {
    const cn = opts.containerNoOf(row).trim().toUpperCase();
    const keep = opts.alwaysKeep?.has(cn)
      || scanSelectionFor(opts.resultOf(row), opts.rmsSelected.has(cn)).reason !== null;
    (keep ? due : notDue).push(row);
  }
  return { due, notDue };
}
