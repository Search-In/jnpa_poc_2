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
import { useState } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import type { UploadTarget } from '@jnpa/data';
import { DataUploadDialog } from './DataUploadDialog.js';

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
 * Import / Export toolbar.
 *
 * **Export** is always available: a client-side CSV of the rows already loaded.
 *
 * **Import** renders ONLY when the panel passes an `importTarget` naming a real
 * POC-3 ingest module. It then opens the shared validate → preview → import
 * dialog, the same two-step flow the POC-1 upload panels use against the same
 * endpoints.
 *
 * Why it is conditional rather than always-on: the ingest endpoints are per
 * module (`shipping-lines`, `gate-docs`, `cfs-ecy`), each keyed by a document
 * discriminator. A panel whose data has no ingest route — the simulator-backed
 * ones, and the derived views — has nothing to upload TO. Previously every panel
 * showed an Import button that opened a file picker and silently discarded the
 * file; a button that isn't there is honest, one that lies is not.
 */
export function ImportExportToolbar({ data, filename, importTarget, onImported }: {
  data: unknown;
  filename: string;
  /** Ingest module for this panel. Omit → no Import button. */
  importTarget?: UploadTarget;
  /** Called after a successful import so the panel can refetch. */
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 8 }}>
      {importTarget && (
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart="upload"
          title={`Import ${importTarget.label ?? importTarget.value} — validate, preview, then persist`}
          onClick={() => setOpen(true)}
        >
          Import
        </CalciteButton>
      )}
      <CalciteButton scale="s" appearance="outline" iconStart="download" onClick={() => exportCsv(data, filename)}>
        Export
      </CalciteButton>
      {open && importTarget && (
        <DataUploadDialog
          target={importTarget}
          onClose={() => setOpen(false)}
          onImported={() => onImported?.()}
        />
      )}
    </div>
  );
}
