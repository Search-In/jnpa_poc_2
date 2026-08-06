/**
 * Data upload — pick a file, VALIDATE it, review the preview, then import.
 *
 * Mirrors the POC-1 upload panels (`ShippingLinesUploadPanel`, `MarineUploadPanel`,
 * `BerthingUploadPanel`), which drive the same POC-3 endpoints:
 *
 *   POST /api/{module}/validate  -> dry run: parses and previews, writes NOTHING
 *   POST /api/{module}/upload    -> persists valid rows, idempotent by row hash
 *
 * The two-step shape is the point. Validate is free and repeatable, so the
 * operator sees the row counts and the rejected rows BEFORE anything is written,
 * and Import stays disabled until a validation has actually passed. A byte-identical
 * re-import returns `SKIPPED_DUPLICATE` rather than duplicating rows.
 *
 * ⚠ Uploads are RBAC-gated server-side (CONTROL_ROOM / CUSTOMS / ADMIN). A role
 * without the claim gets 403 `upload_forbidden`; that is surfaced verbatim rather
 * than hidden, so the operator knows it is a permission and not a bad file.
 */
import { useRef, useState } from 'react';
import {
  CalciteButton, CalciteIcon, CalciteLoader, CalciteNotice,
} from '@esri/calcite-components-react';
import type { UploadResult, UploadTarget } from '@jnpa/data';
import { useApp, CARGO_API_BASE } from '../state/AppContext.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { tokens } from '../theme/tokens.js';

/** Outcome → tone. SKIPPED_DUPLICATE is a WARNING, never a failure: the data is
 *  already in, which is the idempotency guarantee working as designed. */
function statusTone(status?: string | null): string {
  const s = (status ?? '').toUpperCase();
  if (s === 'SUCCESS' || s === 'VALIDATED') return tokens.congestion.GREEN;
  if (s === 'PARTIAL' || s === 'SKIPPED_DUPLICATE') return tokens.severity.WARN;
  return tokens.severity.CRIT; // REJECTED | FAILED
}

const num = (v: unknown): string =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString();

/**
 * Row counts as the backend reported them — never recomputed on the client.
 *
 * Counts live under `summary` on both steps; the import step additionally reports
 * `imported` / `skipped` at the top level. Field names were read off a live
 * response, not assumed.
 */
function ResultSummary({ result }: { result: UploadResult }) {
  const errs = result.errors ?? [];
  const s = result.summary ?? {};
  const cells: Array<[string, string]> = [
    ['Status', String(result.status ?? '—')],
    ['Rows read', num(s.rows)],
    ['Valid', num(s.valid)],
    ['Invalid', num(s.invalid)],
    ['Duplicates', num(s.duplicates)],
    // Only meaningful after the import step; absent on a dry run.
    ...(result.imported !== undefined && result.imported !== null
      ? [['Imported', num(result.imported)] as [string, string]] : []),
    ...(result.skipped !== undefined && result.skipped !== null
      ? [['Skipped', num(result.skipped)] as [string, string]] : []),
  ];
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: '6px 14px', background: tokens.color.bgElevated,
          border: `1px solid ${tokens.color.border}`, borderRadius: 6, padding: '10px 12px',
        }}
      >
        {cells.map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>
              {label}
            </div>
            <strong style={{
              fontSize: 12.5,
              color: label === 'Status' ? statusTone(result.status) : tokens.color.text,
            }}>
              {value}
            </strong>
          </div>
        ))}
      </div>

      {errs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, marginBottom: 4 }}>
            Rejected rows ({errs.length}{errs.length > 20 ? ' — first 20 shown' : ''})
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: tokens.color.text, maxHeight: 180, overflowY: 'auto' }}>
            {errs.slice(0, 20).map((e, i) => (
              <li key={i}>
                {e.row_number != null ? `Row ${e.row_number} — ` : ''}
                {e.column_name ? <strong>{e.column_name}: </strong> : null}
                {e.error_detail ?? e.error_code ?? 'rejected'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DataUploadDialog({ target, onClose, onImported }: {
  target: UploadTarget;
  onClose: () => void;
  /** Fired after a successful import so the parent panel refetches. */
  onImported?: (result: UploadResult) => void;
}) {
  const { adapter } = useApp();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'validate' | 'import' | null>(null);
  const [validated, setValidated] = useState<UploadResult | null>(null);
  const [imported, setImported] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = () => inputRef.current?.click();

  // `GET /api/{module}/templates/{value}` — the same discriminator that keys the
  // upload also keys its template, so one path serves all three modules.
  const templateUrl = `${CARGO_API_BASE.replace(/\/$/, '')}/api/${target.module}/templates/${encodeURIComponent(target.value)}`;

  const onPicked = (f: File | null) => {
    // A new file invalidates any previous validation — Import must not stay
    // enabled against a result that describes a different file.
    setFile(f);
    setValidated(null);
    setImported(null);
    setError(null);
  };

  const run = async (step: 'validate' | 'import') => {
    if (!file) return;
    const fn = step === 'validate' ? adapter.validateUpload : adapter.importUpload;
    if (!fn) { setError('Upload is unavailable in this data mode.'); return; }
    setBusy(step);
    setError(null);
    try {
      const res = await fn.call(adapter, target, file);
      if (step === 'validate') setValidated(res);
      else { setImported(res); onImported?.(res); }
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Import is gated on a validation that did not come back REJECTED/FAILED, so a
  // known-bad file cannot be pushed through.
  const okToImport = Boolean(
    validated && !['REJECTED', 'FAILED'].includes(String(validated.status ?? '').toUpperCase()),
  );

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`Import data — ${target.label ?? target.value}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(640px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="upload" scale="s" />
          <strong style={{ fontSize: 14 }}>Import data</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{target.label ?? target.value}</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {imported ? (
            <>
              <CalciteNotice open kind={statusTone(imported.status) === tokens.congestion.GREEN ? 'success' : 'warning'} icon="check" scale="s">
                <div slot="title">
                  {String(imported.status).toUpperCase() === 'SKIPPED_DUPLICATE'
                    ? 'Already imported — nothing duplicated'
                    : 'Import complete'}
                </div>
                <div slot="message">
                  {String(imported.status).toUpperCase() === 'SKIPPED_DUPLICATE'
                    ? 'This file is byte-identical to one already imported, so the backend skipped it. Rows are hashed, so re-importing can never duplicate data.'
                    : `${num(imported.imported ?? imported.summary?.importable)} row(s) persisted.`}
                </div>
              </CalciteNotice>
              <ResultSummary result={imported} />
            </>
          ) : (
            <>
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 10px' }}>
                Validation is a dry run — it parses the file and reports what would be
                imported without writing anything. Import stays disabled until it passes.
              </p>

              <input
                ref={inputRef}
                type="file"
                accept={target.accept ?? '.csv,.xlsx,.xls,.xml,text/csv'}
                style={{ display: 'none' }}
                onChange={(e) => onPicked(e.target.files?.[0] ?? null)}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <CalciteButton scale="s" appearance="outline" iconStart="folder-open" onClick={pick}>
                  Choose file
                </CalciteButton>
                {/* Every ingest module serves a column template, and the parser's
                    own rejection message tells the user to fetch it ("… column not
                    found. Please download the latest template."). Offering it here
                    closes that loop instead of leaving them to find it. */}
                <CalciteButton
                  scale="s"
                  appearance="transparent"
                  iconStart="download"
                  onClick={() => { window.open(templateUrl, '_blank', 'noopener'); }}
                  title="Download the column template this parser expects"
                >
                  Template
                </CalciteButton>
                <span style={{ fontSize: 12, color: file ? tokens.color.text : tokens.color.textMuted }}>
                  {file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : 'No file selected'}
                </span>
              </div>

              {busy && <CalciteLoader scale="s" label={busy === 'validate' ? 'Validating' : 'Importing'} />}
              {validated && <ResultSummary result={validated} />}

              {error && (
                <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
                  <div slot="title">Upload failed</div>
                  <div slot="message">{error}</div>
                </CalciteNotice>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {imported ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose} disabled={busy !== null}>
                Cancel
              </CalciteButton>
              <CalciteButton
                scale="s"
                appearance="outline"
                iconStart="check-circle"
                disabled={!file || busy !== null}
                loading={busy === 'validate'}
                onClick={() => run('validate')}
              >
                Validate
              </CalciteButton>
              <CalciteButton
                scale="s"
                iconStart="upload"
                disabled={!okToImport || busy !== null}
                loading={busy === 'import'}
                title={okToImport ? 'Persist the valid rows' : 'Validate the file first'}
                onClick={() => run('import')}
              >
                Import
              </CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}
