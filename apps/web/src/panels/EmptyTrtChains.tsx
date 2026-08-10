/**
 * UC2-010 — the empty-container ECY→CFS chains, verified and ledgered.
 *
 * The ticket asks for three things: load the CFS/ECY gate logs, **verify the 242
 * chains**, and **ledger the anomalies**. POC-3's UC3-003 supplies all three
 * from real CODECO events, so this panel's job is to show them without softening
 * either number.
 *
 * Data source (POC-3):
 *   GET /api/cfs-ecy/empty-trt                     -> KPI, definition, census, anomalies
 *   GET /api/cfs-ecy/empty-trt/chains              -> the chains, filterable
 *   GET /api/cfs-ecy/empty-trt/anomalies/{code}    -> the containers behind one class
 *   GET /api/cfs-ecy/empty-trt/containers/{cn}     -> one container's legs
 *
 * ⚠ TWO THINGS THIS PANEL MUST NOT DO.
 *
 * 1. **Never present the 242 as "the chains".** 242 is the COMPLETE cohort out of
 *    **1,202**; the other 960 are partial or orphaned. Showing 242 alone would
 *    read as "we loaded 242 chains and they are all good", when the truth is
 *    "1,202 chains exist and 242 of them are complete enough to measure". The
 *    census tile is therefore always rendered beside the KPI, never without it.
 *
 * 2. **Never repair an anomaly.** The backend detects and does not patch, and so
 *    does this. A container with an ECY gate-out that never reached a CFS is
 *    shown as exactly that. The gap IS the finding — it is what the port would
 *    want to know, and inferring the missing leg would destroy the evidence.
 *
 * The KPI is far off target (204 min against 45) and that is reported plainly.
 * The number is the port's, not ours.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteNotice, CalciteLoader, CalciteButton, CalciteChip,
} from '@esri/calcite-components-react';
import type {
  EmptyTrtOverview, EmptyTrtChain, EmptyTrtAnomalyDetail,
} from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';
import { fmtInt, fmtMin, fmtTs } from './emptyTrtFormat.js';

/** COMPLETE is the measurable cohort; the rest are findings, not failures. */
const STATUS_TONE: Record<string, string> = {
  COMPLETE: tokens.degradation.GREEN,
  PARTIAL: tokens.degradation.AMBER,
  ORPHAN: tokens.color.textMuted,
};

function Tile({ label, value, hint, tone }: {
  label: string; value: string; hint?: string; tone?: string;
}) {
  return (
    <div
      style={{
        flex: '1 1 160px', minWidth: 150, background: tokens.color.bgElevated,
        border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>
        {label}
      </div>
      <strong style={{ display: 'block', fontSize: 20, lineHeight: 1.3, color: tone ?? tokens.color.text }}>
        {value}
      </strong>
      {hint && <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{hint}</div>}
    </div>
  );
}

/**
 * The KPI, scored by the backend against its own target and baseline.
 *
 * `onTarget` and `deltaPct` are the server's verdict, not a threshold re-applied
 * here — two places deciding the same thing is how the rake forecaster ended up
 * with two disagreeing sets of maths (UC2-016).
 */
function KpiCard({ o }: { o: EmptyTrtOverview }) {
  const { kpi, definition, distribution } = o;
  const miss = !kpi.onTarget;
  return (
    <div
      style={{
        background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md, padding: '12px 14px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>{kpi.label}</strong>
        <CalciteChip scale="s">{kpi.source === 'live' ? 'measured' : kpi.source}</CalciteChip>
        <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}>n = {fmtInt(kpi.n)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, margin: '6px 0 2px' }}>
        <strong style={{ fontSize: 30, color: miss ? (tokens.degradation.AMBER) : tokens.color.text }}>
          {fmtMin(kpi.value)}
        </strong>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          target {fmtMin(kpi.target)} · baseline {fmtMin(kpi.baseline)}
        </span>
      </div>
      {miss && (
        <div style={{ fontSize: 12, color: tokens.degradation.AMBER }}>
          {fmtMin(distribution.vs_target_min)} over target ({kpi.deltaPct.toFixed(1)}%)
        </div>
      )}
      {/* The definition is shown verbatim: a KPI whose measure is not on screen
          beside it is a number nobody can check. */}
      <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
        <strong>Measures:</strong> {definition.measure}<br />
        <strong>Eligible:</strong> {definition.eligible}
      </p>
    </div>
  );
}

/**
 * The anomaly ledger. Each class opens the containers behind it.
 *
 * Wording is the backend's `label` throughout — the UI names no defect in its
 * own words, so the ledger and the API can never describe the same code
 * differently.
 */
function AnomalyLedger({ o, onOpen, openCode }: {
  o: EmptyTrtOverview;
  onOpen: (code: string) => void;
  openCode: string | null;
}) {
  const total = o.anomalies.reduce((sum, a) => sum + a.containers, 0);
  return (
    <div>
      <strong style={{ fontSize: 13, color: tokens.color.text }}>
        Anomaly ledger — {fmtInt(o.anomalies.length)} classes, {fmtInt(total)} containers
      </strong>
      <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 8px' }}>
        Detected, not patched. A missing leg is left missing — the gap is the finding.
      </p>
      {o.anomalies.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>No anomalies recorded.</p>
      ) : (
        o.anomalies.map((a) => (
          <button
            key={a.code}
            type="button"
            onClick={() => onOpen(a.code)}
            style={{
              display: 'flex', width: '100%', gap: 10, alignItems: 'baseline', textAlign: 'left',
              padding: '6px 4px', border: 'none', borderBottom: `1px solid ${tokens.color.border}`,
              background: openCode === a.code ? tokens.color.bgElevated : 'transparent',
              cursor: 'pointer', fontSize: 12, color: tokens.color.textMuted,
            }}
          >
            <strong style={{ color: tokens.color.text, minWidth: 46, textAlign: 'right' }}>
              {a.containers.toLocaleString()}
            </strong>
            <span style={{ flex: 1 }}>{a.label}</span>
            <code style={{ fontSize: 10.5, opacity: 0.7 }}>{a.code}</code>
          </button>
        ))
      )}
    </div>
  );
}

/** Where the numbers came from — file, row count and load time. */
function Provenance({ o }: { o: EmptyTrtOverview }) {
  const s = o.source;
  return (
    <div>
      <strong style={{ fontSize: 13, color: tokens.color.text }}>Source</strong>
      <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 8px' }}>
        {fmtInt(s.total_events)} CODECO gate events · ECY out {fmtInt(s.ecy_out_events)} /
        in {fmtInt(s.ecy_in_events)} · CFS in {fmtInt(s.cfs_in_events)} / out {fmtInt(s.cfs_out_events)}
      </p>
      {s.files.map((f) => (
        <div key={f.file_id} style={{ fontSize: 11.5, color: tokens.color.textMuted, padding: '3px 0' }}>
          <code style={{ color: tokens.color.text }}>{f.path}</code>
          {' — '}{fmtInt(f.imported_events ?? f.row_count)} events
          {f.loaded_at ? `, loaded ${fmtTs(f.loaded_at)}` : ''}
        </div>
      ))}
    </div>
  );
}

function ChainTable({ rows, total }: { rows: EmptyTrtChain[]; total: number | null }) {
  if (rows.length === 0) {
    return <p style={{ fontSize: 12, color: tokens.color.textMuted }}>No chains match this filter.</p>;
  }
  return (
    <>
      <div style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
        {/* The page is not the population — 1,202 chains, and any page is a slice. */}
        Showing {fmtInt(rows.length)}{total != null ? ` of ${fmtInt(total)}` : ''}
      </div>
      <CalciteTable scale="s" striped>
        <CalciteTableRow slot="table-header">
          <CalciteTableHeader heading="Container" />
          <CalciteTableHeader heading="Status" />
          <CalciteTableHeader heading="ECY out" />
          <CalciteTableHeader heading="CFS in" />
          <CalciteTableHeader heading="CFS out" />
          <CalciteTableHeader heading="TRT" />
          <CalciteTableHeader heading="Findings" />
        </CalciteTableRow>
        {rows.map((r) => (
          <CalciteTableRow key={r.container_no}>
            <CalciteTableCell><code>{r.container_no}</code></CalciteTableCell>
            <CalciteTableCell>
              <span style={{ color: STATUS_TONE[r.chain_status] ?? tokens.color.text }}>
                {r.chain_status}
              </span>
            </CalciteTableCell>
            <CalciteTableCell>{fmtTs(r.ecy_out_ts)}</CalciteTableCell>
            <CalciteTableCell>{fmtTs(r.cfs_in_ts)}</CalciteTableCell>
            <CalciteTableCell>{fmtTs(r.cfs_out_ts)}</CalciteTableCell>
            <CalciteTableCell>{fmtMin(r.trt_min)}</CalciteTableCell>
            <CalciteTableCell>
              {/* Labels come from the backend beside the codes. */}
              {(r.anomaly_labels ?? []).length > 0
                ? (r.anomaly_labels ?? []).join('; ')
                : (r.anomaly_codes ?? []).join(', ') || '—'}
            </CalciteTableCell>
          </CalciteTableRow>
        ))}
      </CalciteTable>
    </>
  );
}

type Cohort = 'COMPLETE' | 'PARTIAL' | 'ORPHAN' | 'ALL';

export function EmptyTrtChains() {
  const { adapter } = useApp();
  const [cohort, setCohort] = useState<Cohort>('COMPLETE');
  const [openCode, setOpenCode] = useState<string | null>(null);

  const unavailable = () =>
    Promise.reject(new Error('The empty-container TRT API is unavailable in this data mode.'));

  const overview = useAsync<EmptyTrtOverview>(
    () => (adapter.getEmptyTrt ? adapter.getEmptyTrt() : unavailable()),
    [adapter],
  );
  const chains = useAsync<{ items: EmptyTrtChain[]; total: number | null }>(
    () => (adapter.getEmptyTrtChains
      ? adapter.getEmptyTrtChains({
        chainStatus: cohort === 'ALL' ? undefined : cohort,
        limit: 200,
      })
      : unavailable()),
    [adapter, cohort],
  );
  const anomaly = useAsync<EmptyTrtAnomalyDetail | null>(
    () => (openCode == null
      ? Promise.resolve(null)
      : adapter.getEmptyTrtAnomaly
        ? adapter.getEmptyTrtAnomaly(openCode, { limit: 200 })
        : unavailable()),
    [adapter, openCode],
  );

  if (overview.loading) return <CalciteLoader label="Loading empty-container chains" />;
  if (overview.error || !overview.data) {
    return (
      <CalciteNotice open kind="danger" scale="s">
        <div slot="title">Could not load the empty-container chains</div>
        <div slot="message">{overview.error ?? 'No data returned.'}</div>
      </CalciteNotice>
    );
  }

  const o = overview.data;
  const c = o.chains;

  return (
    <>
      {/* Census FIRST, so 242 is never read as the whole population. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Tile label="Chains built" value={fmtInt(c.total)}
          hint="one per container seen in the CODECO feed" />
        <Tile label="Complete" value={fmtInt(c.complete)} tone={STATUS_TONE.COMPLETE}
          hint="ECY-out → CFS-in → CFS-out, in order" />
        <Tile label="Partial" value={fmtInt(c.partial)} tone={STATUS_TONE.PARTIAL}
          hint="at least one leg missing" />
        <Tile label="Orphan" value={fmtInt(c.orphan)} tone={STATUS_TONE.ORPHAN}
          hint="no ECY gate-out in the corpus" />
      </div>

      <div
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 18, marginBottom: 18,
        }}
      >
        <KpiCard o={o} />
        <AnomalyLedger o={o} openCode={openCode} onOpen={(code) => setOpenCode((p) => (p === code ? null : code))} />
        <Provenance o={o} />
      </div>

      {openCode && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
            <strong style={{ fontSize: 13, color: tokens.color.text }}>
              {anomaly.data?.label ?? openCode}
            </strong>
            <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
              {fmtInt(anomaly.data?.total)} containers
            </span>
            <CalciteButton scale="s" appearance="transparent" onClick={() => setOpenCode(null)}>
              Close
            </CalciteButton>
          </div>
          {anomaly.loading ? <CalciteLoader scale="s" label="Loading" />
            : anomaly.error ? (
              <CalciteNotice open kind="danger" scale="s">
                <div slot="message">{anomaly.error}</div>
              </CalciteNotice>
            ) : (
              <ChainTable rows={anomaly.data?.items ?? []} total={anomaly.data?.total ?? null} />
            )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>Chains</strong>
        {(['COMPLETE', 'PARTIAL', 'ORPHAN', 'ALL'] as Cohort[]).map((k) => (
          <CalciteButton
            key={k}
            scale="s"
            appearance={cohort === k ? 'solid' : 'outline-fill'}
            onClick={() => setCohort(k)}
          >
            {k === 'ALL' ? 'All' : `${k[0]}${k.slice(1).toLowerCase()}`}
          </CalciteButton>
        ))}
      </div>
      {chains.loading ? <CalciteLoader scale="s" label="Loading chains" />
        : chains.error ? (
          <CalciteNotice open kind="danger" scale="s">
            <div slot="message">{chains.error}</div>
          </CalciteNotice>
        ) : (
          <ChainTable rows={chains.data?.items ?? []} total={chains.data?.total ?? null} />
        )}
    </>
  );
}
