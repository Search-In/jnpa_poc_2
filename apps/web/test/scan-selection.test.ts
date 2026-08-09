/**
 * The scan queue is a BRANCH, and these tests are what keep it one.
 *
 * The backend queue returns every yard-assigned unverified container, because
 * VERIFIED is a mandatory custody gate before RELEASED. Rendering that list as
 * "awaiting a customs scan" put out-of-charged containers under a Record-scan
 * button for a scan nobody ordered. Only a filed RMS selection or an operator's
 * flag puts a box under the scanner.
 */
import { describe, expect, it } from 'vitest';
import { partitionScanQueue, scanSelectionFor } from '../src/panels/scanSelection.js';
import { gateUi, customsLifecycleConflict } from '../src/panels/cargoGates.js';

const row = (containerNo: string, result: 'CLEAR' | 'HOLD' | 'EXAM' | undefined) => ({ containerNo, result });

describe('what puts a container in the scan queue', () => {
  it('a filed RMS scan list does', () => {
    expect(scanSelectionFor(undefined, true).reason).toBe('RMS');
  });

  it('an operator flag of EXAM or HOLD does', () => {
    expect(scanSelectionFor('EXAM', false).reason).toBe('FLAGGED');
    expect(scanSelectionFor('HOLD', false).reason).toBe('FLAGGED');
  });

  it('customs clearance does NOT — an out-of-charged box has no scan due', () => {
    const sel = scanSelectionFor('CLEAR', false);

    expect(sel.reason).toBeNull();
    expect(sel.explain).toMatch(/out-of-charge/i);
  });

  it('nor does merely being in the yard', () => {
    expect(scanSelectionFor(undefined, false).reason).toBeNull();
  });

  it('prefers the RMS list over the flag when both apply', () => {
    // Both are true for the four re-pointed containers. The filed document is the
    // better answer: it is the instruction that actually ordered the scan.
    expect(scanSelectionFor('EXAM', true).reason).toBe('RMS');
  });
});

describe('partitioning the queue', () => {
  const rmsSelected = new Set(['AAIU5051479']);

  it('keeps only the boxes a scan is due on', () => {
    const { due, notDue } = partitionScanQueue(
      [
        row('AAIU5051479', 'EXAM'),   // RMS-selected
        row('TCLU3344559', 'EXAM'),   // flagged
        row('CSNU1399404', 'CLEAR'),  // out-of-charged, facilitated
        row('MAEU6123458', undefined), // nothing said about it
      ],
      { containerNoOf: (r) => r.containerNo, resultOf: (r) => r.result, rmsSelected },
    );

    expect(due.map((r) => r.containerNo)).toEqual(['AAIU5051479', 'TCLU3344559']);
    expect(notDue.map((r) => r.containerNo)).toEqual(['CSNU1399404', 'MAEU6123458']);
  });

  it('never hides a container the operator just acted on', () => {
    // Recording a scan flips the row to VERIFIED; if the rule then evicted it,
    // the row would vanish at the exact moment its result matters.
    const { due, notDue } = partitionScanQueue(
      [row('CSNU1399404', 'CLEAR')],
      {
        containerNoOf: (r) => r.containerNo,
        resultOf: (r) => r.result,
        rmsSelected,
        alwaysKeep: new Set(['CSNU1399404']),
      },
    );

    expect(due.map((r) => r.containerNo)).toEqual(['CSNU1399404']);
    expect(notDue).toEqual([]);
  });

  it('matches container numbers case- and whitespace-insensitively', () => {
    const { due } = partitionScanQueue(
      [row(' aaiu5051479 ', undefined)],
      { containerNoOf: (r) => r.containerNo, resultOf: (r) => r.result, rmsSelected },
    );

    expect(due).toHaveLength(1);
  });
});

describe('the verify gate says which check it is', () => {
  it('calls it a scan only when one was ordered', () => {
    expect(gateUi('verify', 'SCAN').label).toBe('Record scan');
    expect(gateUi('verify', 'SCAN').explain).toMatch(/selected for scanning/i);
  });

  it('calls it a release check on a facilitated box, and says no scan happened', () => {
    const ui = gateUi('verify', 'RELEASE_CHECK');

    expect(ui.label).toBe('Verify for release');
    // The whole point: the copy must not let an operator believe a customs
    // examination took place on a container nobody ever selected.
    expect(ui.explain).toMatch(/does NOT claim a scan/i);
    expect(ui.label).not.toMatch(/scan/i);
  });

  it('stays generic when the caller does not know', () => {
    // Guessing "Record scan" here is exactly the bug; neutral wording is correct.
    expect(gateUi('verify').label).toBe('Verify for release');
  });

  it('leaves the other gates alone', () => {
    expect(gateUi('discharge', 'SCAN').label).toBe('Discharge');
    expect(gateUi('release', 'RELEASE_CHECK').label).toBe('Release');
    expect(gateUi('yard').label).toBe('Assign yard');
  });

  it('gives every gate a fail label, so the dialog never renders undefined', () => {
    for (const g of ['discharge', 'yard', 'verify', 'release', 'done'] as const) {
      expect(gateUi(g).fail).toBeTruthy();
    }
  });
});

describe('impossible combinations of the two tracks', () => {
  it('flags released-while-under-examination as an error', () => {
    // GESU5123996 in the movements grid: UNDER_INSPECTION + RELEASED.
    const clash = customsLifecycleConflict('UNDER_INSPECTION', 'RELEASED');

    expect(clash?.severity).toBe('error');
    expect(clash?.message).toMatch(/cannot both be true/i);
  });

  it('flags released-while-held as an error too', () => {
    expect(customsLifecycleConflict('HELD', 'RELEASED')?.severity).toBe('error');
  });

  it('warns before the release that would create the contradiction', () => {
    // VERIFIED is the last moment the operator can still avoid it.
    expect(customsLifecycleConflict('UNDER_INSPECTION', 'VERIFIED')?.severity).toBe('warning');
    expect(customsLifecycleConflict('HELD', 'VERIFIED')?.severity).toBe('warning');
  });

  it('leaves legitimate pairings alone', () => {
    // Cleared and released is the normal end state; under examination while still
    // in the yard is exactly what the scan queue is for.
    expect(customsLifecycleConflict('CLEARED', 'RELEASED')).toBeNull();
    expect(customsLifecycleConflict('UNDER_INSPECTION', 'YARD_ASSIGNED')).toBeNull();
    expect(customsLifecycleConflict('HELD', 'CREATED')).toBeNull();
    expect(customsLifecycleConflict('PENDING', 'RELEASED')).toBeNull();
  });

  it('tolerates missing values rather than inventing a conflict', () => {
    expect(customsLifecycleConflict(null, 'RELEASED')).toBeNull();
    expect(customsLifecycleConflict('HELD', undefined)).toBeNull();
  });
});
