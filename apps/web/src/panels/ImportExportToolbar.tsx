/**
 * Shared Import / Export toolbar for the operational data panels
 * (Movements → Empty Pool). One implementation reused by every panel so the
 * style, spacing, icons and alignment stay identical.
 *
 * - Export downloads the panel's ALREADY-LOADED, role-scoped data as CSV,
 *   client-side only (Blob download, no backend/API). Columns follow the data's
 *   OWN field order (identical fields/order to the previous JSON output); values
 *   are RFC-4180 escaped (commas, quotes, newlines); nested objects/arrays are
 *   JSON-encoded in-cell so no data is lost.
 * - Import is a UI-only placeholder: no backend ingest API exists, so it opens
 *   the native file picker (now filtered to CSV) without mutating app state.
 */
import { CalciteButton } from '@esri/calcite-components-react';

/** RFC-4180 cell escaping; objects/arrays are JSON-encoded so no data is lost. */
function csvCell(v: unknown): string {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise already-loaded panel rows to CSV. Header row + one row per record.
 * Column order = the first record's own key order, so the fields and their order
 * match exactly what the previous JSON export produced.
 */
function toCsv(data: unknown): string {
  const rows = (Array.isArray(data) ? data : [data]).filter((r) => r != null) as Array<Record<string, unknown>>;
  const first = rows[0];
  if (!first) return '';
  const cols = Object.keys(first);
  const line = (cells: unknown[]) => cells.map(csvCell).join(',');
  return [line(cols), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\r\n');
}

/** Client-side CSV download of already-loaded panel data. No backend/API. */
function exportCsv(data: unknown, filename: string): void {
  // Force a .csv extension regardless of the name the panel passed in.
  const name = /\.csv$/i.test(filename) ? filename : `${filename.replace(/\.[^./\\]+$/, '')}.csv`;
  const blob = new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * UI-only placeholder — opens the native file picker (CSV, matching Export)
 * using the same transient-input pattern as before, but intentionally does not
 * mutate app state, because no backend ingest API exists for these panels.
 */
function importPlaceholder(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'text/csv,.csv';
  input.onchange = () => {
    /* Placeholder — no ingest API; intentionally does not mutate app state. */
  };
  input.click();
}

export function ImportExportToolbar({ data, filename }: { data: unknown; filename: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 8 }}>
      <CalciteButton scale="s" appearance="outline" iconStart="upload" onClick={importPlaceholder}>
        Import
      </CalciteButton>
      <CalciteButton scale="s" appearance="outline" iconStart="download" onClick={() => exportCsv(data, filename)}>
        Export
      </CalciteButton>
    </div>
  );
}
