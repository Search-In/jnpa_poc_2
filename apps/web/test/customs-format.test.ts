/**
 * The client-side mirror of the customs importer's filename detection.
 *
 * This is a copy of a decision made in `services/customs/service.py ::
 * detect_parser`, which is exactly the kind of duplication that rots silently.
 * Every branch is pinned against filenames that exist in the corpus, so a drift
 * shows up as a failing test rather than as an operator being told a file will
 * import when it will not.
 */
import { describe, expect, it } from 'vitest';
import { CUSTOMS_FILENAME_RULES, describeCustomsFile } from '../src/panels/customsFormat.js';

describe('customs filename detection', () => {
  it('reads a real IGM', () => {
    const g = describeCustomsFile('CHPOI03_1194313_07-06-2026-025128265.xml');
    expect(g.module).toBe('IGM');
  });

  it('reads a real bill of entry', () => {
    // The container CSNU1399404's out-of-charge — the hero of UC2-004.
    const g = describeCustomsFile('CHPOI10_9259230_06-06-2026-105116169.xml');
    expect(g.module).toBe('OOC');
  });

  it('reads a real transhipment permit', () => {
    expect(describeCustomsFile('CHPOI13_2697411_06-06-2026.xml').module).toBe('SMTP');
  });

  it('reads an RMS scan list', () => {
    expect(describeCustomsFile('1.txt').module).toBe('RMS');
  });

  it('defers the spreadsheet decision to the header row', () => {
    // leodetails.xlsx and shippingbill.xlsx are indistinguishable by name; the
    // server opens them. Claiming one here would be a coin flip presented as fact.
    const g = describeCustomsFile('leodetails.xlsx');
    expect(g.needsContent).toBe(true);
    expect(g.module).toContain('LEO');
    expect(g.module).toContain('SHIPPING_BILL');
  });

  it('is case-insensitive, like the server', () => {
    // detect_parser upper-cases the basename before testing.
    expect(describeCustomsFile('chpoi03_1194313.xml').module).toBe('IGM');
    expect(describeCustomsFile('SCAN.TXT').module).toBe('RMS');
  });

  it('matches the prefix before the extension, like the server', () => {
    // The CHPOI checks run first, so a CHPOI03 with a .txt suffix is an IGM —
    // not an RMS list. Reordering these branches would mis-file documents.
    expect(describeCustomsFile('CHPOI03_1194313.txt').module).toBe('IGM');
  });

  it('strips a path, like os.path.basename', () => {
    expect(describeCustomsFile('5- Customs/OOC/CHPOI10_9259230.xml').module).toBe('OOC');
  });

  it('refuses what the server refuses, and says renaming is not the fix', () => {
    for (const name of ['CFS-CODECO.xlsx.bak', 'notes.pdf', 'IGM.doc', 'archive.zip']) {
      const g = describeCustomsFile(name);
      expect(g.module, `${name} should be refused`).toBeNull();
    }
    expect(describeCustomsFile('notes.pdf').detail).toMatch(/not a workaround/i);
  });

  it('handles no file without inventing a verdict', () => {
    expect(describeCustomsFile('').module).toBeNull();
  });

  it('documents every branch it implements', () => {
    // The displayed rules and the code must cover the same ground — a rule shown
    // but not implemented (or the reverse) is worse than showing nothing.
    expect(CUSTOMS_FILENAME_RULES).toHaveLength(5);
    const shown = CUSTOMS_FILENAME_RULES.map((r) => r.pattern).join(' ');
    for (const token of ['CHPOI03', 'CHPOI10', 'CHPOI13', '.txt', '.xlsx']) {
      expect(shown).toContain(token);
    }
  });
});
