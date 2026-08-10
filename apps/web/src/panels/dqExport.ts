/**
 * CSV export for the data-quality ledger (UC2-012).
 *
 * Split out of the panel so it can be tested without Calcite, and because the
 * export is the part of that ticket most likely to be trusted without being
 * checked — someone opens the file in Excel and treats it as the record.
 *
 * ⚠ The export carries exactly the rows passed to it, which are exactly the rows
 * on screen under the active filter. Widening it to the whole ledger "for
 * convenience" would hand someone a file that does not match what they were
 * looking at when they clicked.
 */
import type { DqIssue } from '@jnpa/data';

/** Column order of the export. Stable, so a saved sheet keeps working. */
export const DQ_CSV_COLUMNS = [
  'issue_id', 'severity', 'source_table', 'issue_type', 'record_ref',
  'description', 'detected_at', 'source_path',
] as const;

/** RFC-4180 quoting: descriptions contain commas and quoted values verbatim. */
function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: DqIssue[]): string {
  const body = rows.map((r) => DQ_CSV_COLUMNS
    .map((k) => esc((r as unknown as Record<string, unknown>)[k]))
    .join(','));
  return [DQ_CSV_COLUMNS.join(','), ...body].join('\n');
}

/** Names the file after what it actually contains, filter included. */
export function csvFilename(rowCount: number, filtered: boolean): string {
  return `dq-findings${filtered ? '-filtered' : ''}-${rowCount}.csv`;
}
