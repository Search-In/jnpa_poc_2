/**
 * UC2-012 — the CSV export is the part of this ticket most likely to be trusted
 * without being checked: someone opens it in Excel and treats it as the record.
 *
 * So these tests pin the two ways a quality export quietly lies — losing rows to
 * bad quoting, and disagreeing with the screen it was exported from — using a
 * real finding from the deployed ledger, comma and all.
 */
import { describe, expect, it } from 'vitest';
import type { DqIssue } from '@jnpa/data';
import { toCsv, csvFilename, DQ_CSV_COLUMNS } from '../src/panels/dqExport.js';

/** A real row from POC-3, 10-Aug-2026. Its description contains a quoted value. */
const REAL: DqIssue = {
  issue_id: 13,
  file_id: 37,
  source_table: 'core.berth_application',
  record_ref: '2026032312601794',
  issue_type: 'bad_imo',
  severity: 'error',
  description: "non-numeric IMO 'RJPIV00379' in BERMAN (agency PAN stuffed into IMO field)",
  detected_at: '2026-07-23T06:29:48.877809Z',
  source_path: 'Data/1-NLP Marine/BERMAN/BERMAN_2026032312601794.xml',
};

const lines = (csv: string) => csv.split('\n');

describe('the data-quality CSV', () => {
  it('leads with a stable header, so a saved sheet keeps working', () => {
    expect(lines(toCsv([]))[0]).toBe(DQ_CSV_COLUMNS.join(','));
  });

  it('emits a header even with no rows, rather than an empty file', () => {
    // An empty file reads as "the export broke"; a header with no rows reads as
    // "nothing matched", which is the truth.
    expect(lines(toCsv([]))).toHaveLength(1);
  });

  it('keeps one row per finding', () => {
    expect(lines(toCsv([REAL, { ...REAL, issue_id: 15 }]))).toHaveLength(3);
  });

  it('quotes a description containing commas so columns cannot shift', () => {
    const row = lines(toCsv([REAL]))[1]!;
    // Unquoted, the comma-free description here would still be safe — so use one
    // that is not, and prove the whole field survives as ONE cell.
    const withComma = { ...REAL, description: 'count_mismatch: declared 40, imported 38' };
    const cell = lines(toCsv([withComma]))[1]!;
    expect(cell).toContain('"count_mismatch: declared 40, imported 38"');
    expect(row).toContain('RJPIV00379');
  });

  it('doubles embedded quotes rather than truncating the value', () => {
    const q = { ...REAL, description: 'value "RJPIV00379" is not an IMO' };
    expect(lines(toCsv([q]))[1]).toContain('"value ""RJPIV00379"" is not an IMO"');
  });

  it('carries the source path, so a finding can be raised against a real file', () => {
    // Without this the export says something is wrong but not where, which makes
    // it unactionable — and an unactionable ledger gets ignored.
    expect(lines(toCsv([REAL]))[1]).toContain('BERMAN_2026032312601794.xml');
  });

  it('writes an empty cell for an absent field, not "null" or "undefined"', () => {
    const sparse = { ...REAL, record_ref: null, source_path: null };
    const cells = lines(toCsv([sparse]))[1]!;
    expect(cells).not.toContain('null');
    expect(cells).not.toContain('undefined');
  });
});

describe('the filename states what the file contains', () => {
  it('says when the export is filtered, so it is not mistaken for the whole ledger', () => {
    expect(csvFilename(20, true)).toBe('dq-findings-filtered-20.csv');
  });

  it('and when it is not', () => {
    expect(csvFilename(608, false)).toBe('dq-findings-608.csv');
  });

  it('names the row count, which must be the count the screen showed', () => {
    // The panel passes `rows.length` — the filtered page — to both the CSV and
    // this name, so the file cannot claim a different population than it holds.
    const rows = [REAL, { ...REAL, issue_id: 15 }];
    expect(csvFilename(rows.length, true)).toContain(`-${rows.length}.csv`);
    expect(lines(toCsv(rows))).toHaveLength(rows.length + 1);
  });
});
