/**
 * Shared Import / Export toolbar for the operational data panels
 * (Movements → Empty Pool). One implementation reused by every panel so the
 * style, spacing, icons and alignment stay identical.
 *
 * - Export downloads the panel's ALREADY-LOADED, role-scoped data as JSON,
 *   client-side only — mirroring the project's existing Blob-download pattern
 *   (map/placementStore.ts → downloadPlacements). No backend/API is involved.
 * - Import is a UI-only placeholder: no backend ingest API exists, so it opens
 *   the native file picker (same transient-input pattern as
 *   placementStore.importPlacements) without mutating app state or data flow.
 */
import { CalciteButton } from '@esri/calcite-components-react';

/** Client-side JSON download of already-loaded panel data. No backend/API. */
function exportJSON(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * UI-only placeholder — opens the native file picker (same transient-input
 * pattern as placementStore.importPlacements) but intentionally does not mutate
 * app state, because no backend ingest API exists for these panels.
 */
function importPlaceholder(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
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
      <CalciteButton scale="s" appearance="outline" iconStart="download" onClick={() => exportJSON(data, filename)}>
        Export
      </CalciteButton>
    </div>
  );
}
