/**
 * UC2-012 — the anomaly ledger: per-class tiles, drill-down and export.
 *
 * Every corpus importer records what it could not make sense of instead of
 * quietly coercing it, and this panel is where those findings surface. The
 * ticket's phrasing is "per-class tiles and export"; the classes are the
 * backend's own `severity`, `source_table` and `issue_type` rollups.
 *
 * Data source (POC-3):
 *   GET /api/dq/summary   -> counts by severity, source table and issue type
 *   GET /api/dq/issues    -> the findings themselves, same filters
 *
 * ⚠ WHY A TILE AND ITS LIST CANNOT DISAGREE. Both calls take the SAME filter
 * object and it is built in one place (`Poc3CargoAdapter.dqQuery`). A quality
 * dashboard whose headline count and drill-down are computed differently is
 * worse than no dashboard — it teaches people the numbers are approximate. So
 * clicking a tile narrows BOTH, and the header re-reads the filtered total from
 * the server rather than subtracting locally.
 *
 * ⚠ THESE ARE NOT FAILURES TO FIX HERE. A finding is evidence about the corpus,
 * e.g. "non-numeric IMO 'RJPIV00379' in BERMAN (agency PAN stuffed into IMO
 * field)" — a defect in JNPA's own source data. The panel reports it with its
 * file path so it can be raised, and never offers to correct it.
 */
import { useMemo, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteNotice, CalciteLoader, CalciteButton, CalciteChip, CalciteInput,
} from '@esri/calcite-components-react';
import type { DqSummary, DqIssue, DqFilter } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { tokens } from '../theme/tokens.js';
import { toCsv, csvFilename } from './dqExport.js';

const fmtInt = (v?: number | null) => (v === null || v === undefined ? '—' : v.toLocaleString());
const fmtTs = (v?: string | null) =>
  (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** Severity → the repo's existing traffic-light palette. */
const SEVERITY_TONE: Record<string, string> = {
  error: tokens.degradation.RED,
  warn: tokens.degradation.AMBER,
  warning: tokens.degradation.AMBER,
  info: tokens.color.textMuted,
};

/** The API spells it `warn`; the summary counts it `warnings`. Both appear. */
const SEVERITIES: Array<{ key: string; label: string; of: keyof DqSummary }> = [
  { key: 'error', label: 'Errors', of: 'errors' },
  { key: 'warn', label: 'Warnings', of: 'warnings' },
  { key: 'info', label: 'Info', of: 'info' },
];

function Tile({ label, value, hint, tone, active, onClick }: {
  label: string; value: string; hint?: string; tone?: string;
  active?: boolean; onClick?: () => void;
}) {
  const interactive = Boolean(onClick);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      style={{
        flex: '1 1 150px', minWidth: 140, textAlign: 'left', font: 'inherit',
        background: active ? tokens.color.bgPanel : tokens.color.bgElevated,
        border: `1px solid ${active ? (tone ?? tokens.color.brand) : tokens.color.border}`,
        borderRadius: tokens.radius.md, padding: '10px 12px',
        cursor: interactive ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>
        {label}
      </div>
      <strong style={{ display: 'block', fontSize: 20, lineHeight: 1.3, color: tone ?? tokens.color.text }}>
        {value}
      </strong>
      {hint && <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{hint}</div>}
    </button>
  );
}

/** One rollup row that narrows the filter when clicked. */
function ClassRow({ label, count, detail, active, onClick }: {
  label: string; count: number; detail?: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', width: '100%', gap: 10, alignItems: 'baseline', textAlign: 'left',
        padding: '6px 4px', border: 'none', borderBottom: `1px solid ${tokens.color.border}`,
        background: active ? tokens.color.bgElevated : 'transparent',
        cursor: 'pointer', fontSize: 12, color: tokens.color.textMuted, font: 'inherit',
      }}
    >
      <strong style={{ color: tokens.color.text, minWidth: 46, textAlign: 'right', fontSize: 12 }}>
        {count.toLocaleString()}
      </strong>
      <code style={{ flex: 1, fontSize: 11.5, color: tokens.color.text }}>{label}</code>
      {detail && <span style={{ fontSize: 11 }}>{detail}</span>}
    </button>
  );
}

/** Hand the CSV to the browser. Kept here, not in dqExport, because it touches
 *  the DOM and the export's actual content is what is worth testing. */
function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataQuality() {
  const { adapter } = useApp();
  const [severity, setSeverity] = useState<string | undefined>(undefined);
  const [sourceTable, setSourceTable] = useState<string | undefined>(undefined);
  const [issueType, setIssueType] = useState<string | undefined>(undefined);
  const [q, setQ] = useState('');

  const unavailable = () =>
    Promise.reject(new Error('The data-quality API is unavailable in this data mode.'));

  // One filter object, used for BOTH calls — see the header note.
  const filter: DqFilter = useMemo(
    () => ({ severity, sourceTable, issueType, q: q.trim() || undefined }),
    [severity, sourceTable, issueType, q],
  );

  // Unfiltered, so the tiles always show the ledger's true shape and a filter
  // can never make a class look like it vanished.
  const all = useAsync<DqSummary>(
    () => (adapter.getDqSummary ? adapter.getDqSummary() : unavailable()),
    [adapter],
  );
  const scoped = useAsync<DqSummary>(
    () => (adapter.getDqSummary ? adapter.getDqSummary(filter) : unavailable()),
    [adapter, filter],
  );
  const issues = useAsync<{ items: DqIssue[]; total: number | null }>(
    () => (adapter.getDqIssues ? adapter.getDqIssues({ ...filter, limit: 200 }) : unavailable()),
    [adapter, filter],
  );

  const rows = issues.data?.items ?? [];
  const filtered = Boolean(severity || sourceTable || issueType || q.trim());

  const clear = () => {
    setSeverity(undefined);
    setSourceTable(undefined);
    setIssueType(undefined);
    setQ('');
  };

  const toolbar = (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <CalciteInput
        scale="s"
        placeholder="Search description or reference"
        value={q}
        onCalciteInputInput={(e) => setQ((e.target as unknown as { value?: string }).value ?? '')}
        style={{ minWidth: 240 }}
      />
      {filtered && (
        <CalciteButton scale="s" appearance="outline-fill" onClick={clear}>Clear filters</CalciteButton>
      )}
      <CalciteButton
        scale="s"
        appearance="outline-fill"
        iconStart="download"
        disabled={rows.length === 0}
        onClick={() => download(csvFilename(rows.length, filtered), toCsv(rows))}
      >
        Export {rows.length > 0 ? `${fmtInt(rows.length)} rows` : 'CSV'}
      </CalciteButton>
    </div>
  );

  return (
    <Panel
      heading="Data quality — recorded corpus findings"
      description="What the importers could not make sense of. Recorded, never silently corrected."
      toolbar={toolbar}
      state={all}
      isEmpty={(d) => (d?.total ?? 0) === 0}
    >
      {(a) => (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <Tile
              label="Findings"
              value={fmtInt(a.total)}
              hint={filtered ? `${fmtInt(scoped.data?.total)} match the filter` : 'across every importer'}
              active={!severity}
              onClick={severity ? () => setSeverity(undefined) : undefined}
            />
            {SEVERITIES.map((s) => (
              <Tile
                key={s.key}
                label={s.label}
                value={fmtInt(a[s.of] as number)}
                tone={SEVERITY_TONE[s.key]}
                hint={severity === s.key ? 'filtering' : 'click to filter'}
                active={severity === s.key}
                onClick={() => setSeverity((p) => (p === s.key ? undefined : s.key))}
              />
            ))}
          </div>

          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 18, marginBottom: 18,
            }}
          >
            <div>
              <strong style={{ fontSize: 13, color: tokens.color.text }}>
                By source table ({fmtInt(a.by_source_table.length)})
              </strong>
              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 8px' }}>
                Where the questionable value landed.
              </p>
              {a.by_source_table.map((t) => (
                <ClassRow
                  key={t.source_table}
                  label={t.source_table}
                  count={t.issues}
                  detail={t.errors > 0 ? `${t.errors} error${t.errors === 1 ? '' : 's'}` : undefined}
                  active={sourceTable === t.source_table}
                  onClick={() => setSourceTable((p) => (p === t.source_table ? undefined : t.source_table))}
                />
              ))}
            </div>

            <div>
              <strong style={{ fontSize: 13, color: tokens.color.text }}>
                By issue type ({fmtInt(a.by_issue_type.length)})
              </strong>
              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 8px' }}>
                What kind of defect it is.
              </p>
              {a.by_issue_type.map((t) => (
                <ClassRow
                  key={`${t.issue_type}:${t.severity}`}
                  label={t.issue_type}
                  count={t.issues}
                  detail={String(t.severity)}
                  active={issueType === t.issue_type}
                  onClick={() => setIssueType((p) => (p === t.issue_type ? undefined : t.issue_type))}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            <strong style={{ fontSize: 13, color: tokens.color.text }}>Findings</strong>
            {[
              severity && `severity ${severity}`,
              sourceTable && sourceTable,
              issueType && issueType,
              q.trim() && `"${q.trim()}"`,
            ].filter(Boolean).map((label) => (
              <CalciteChip key={String(label)} scale="s">{label}</CalciteChip>
            ))}
            <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
              {/* The page is a slice; the total comes from the server. */}
              showing {fmtInt(rows.length)}
              {issues.data?.total != null ? ` of ${fmtInt(issues.data.total)}` : ''}
            </span>
          </div>

          {issues.loading ? <CalciteLoader scale="s" label="Loading findings" />
            : issues.error ? (
              <CalciteNotice open kind="danger" scale="s">
                <div slot="message">{issues.error}</div>
              </CalciteNotice>
            ) : rows.length === 0 ? (
              <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
                No findings match this filter.
              </p>
            ) : (
              <CalciteTable scale="s" striped>
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Severity" />
                  <CalciteTableHeader heading="Type" />
                  <CalciteTableHeader heading="Source table" />
                  <CalciteTableHeader heading="Reference" />
                  <CalciteTableHeader heading="What was found" />
                  <CalciteTableHeader heading="Detected" />
                </CalciteTableRow>
                {rows.map((r) => (
                  <CalciteTableRow key={r.issue_id}>
                    <CalciteTableCell>
                      <span style={{ color: SEVERITY_TONE[String(r.severity)] ?? tokens.color.text }}>
                        {r.severity}
                      </span>
                    </CalciteTableCell>
                    <CalciteTableCell><code>{r.issue_type}</code></CalciteTableCell>
                    <CalciteTableCell><code>{r.source_table}</code></CalciteTableCell>
                    <CalciteTableCell><code>{r.record_ref ?? '—'}</code></CalciteTableCell>
                    <CalciteTableCell>
                      {/* Backend prose, verbatim — the UI names no defect itself. */}
                      {r.description ?? '—'}
                      {r.source_path && (
                        <div style={{ fontSize: 10.5, color: tokens.color.textMuted, marginTop: 2 }}>
                          {r.source_path}
                        </div>
                      )}
                    </CalciteTableCell>
                    <CalciteTableCell>{fmtTs(r.detected_at)}</CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            )}
        </>
      )}
    </Panel>
  );
}
