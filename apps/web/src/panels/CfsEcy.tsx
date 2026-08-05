/**
 * CFS / ECY — the off-dock leg of the export chain, as port-level statistics.
 *
 * An export container is released from an Empty Container Yard, trucked to a
 * Container Freight Station for stuffing, and later leaves the CFS for the
 * terminal gate. POC-3 parses the CFS-CODECO / ECY-CODECO feeds and derives the
 * ECY→CFS chain, so throughput, road transit and CFS dwell are all real,
 * customer-sourced measurements.
 *
 * Data source (POC-3):
 *   GET /api/cfs-ecy/stats         -> throughput + dwell aggregates
 *   GET /api/cfs-ecy/chains/stats  -> chain completeness, transit/dwell/cycle
 *   GET /api/cfs-ecy/dwell         -> per-container CFS dwell rows
 *
 * ⚠ DELIBERATE SCOPE LIMIT — read before extending.
 * This feed shares ZERO container numbers with the manifests, advance lists and
 * gate documents held in the same corpus. It therefore supports port-wide
 * statistics and nothing else. Do NOT add a link from a container row on another
 * tab into this panel, and do NOT present a row here as "this box's history" —
 * the identifiers cannot be reconciled. The container column in the dwell table
 * exists so a figure can be traced back to its source row, not to be joined.
 * See markdowns/04_Export_Build_Plan.md §1.1.
 */
import { useMemo, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteNotice, CalciteLoader, CalciteSegmentedControl, CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import type {
  CfsEcyChainStats, CfsEcyDwellItem, CfsEcyFacility, CfsEcyStats,
} from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { tokens } from '../theme/tokens.js';

/** Postgres numerics arrive as decimal STRINGS — coerce before any maths. */
function num(v?: number | string | null): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const fmtInt = (v?: number | null) =>
  (v === null || v === undefined ? '—' : v.toLocaleString());

/** Hours are the natural unit here (dwell runs to ~6 days); days added past 48h. */
function fmtHours(v?: number | string | null): string {
  const n = num(v);
  if (n === null) return '—';
  if (n < 48) return `${n.toFixed(1)} h`;
  return `${n.toFixed(1)} h (${(n / 24).toFixed(1)} d)`;
}

const fmtTs = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

/**
 * `daily_throughput.day` is a plain calendar date ("2026-07-01"), not an instant.
 * `new Date()` would read it as UTC midnight and then render it in local time, so
 * west of Greenwich every bar would be labelled a day early. Parse the parts.
 */
function dayParts(iso: string): { d: number; m: number; y: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact axis tick, e.g. "1/7". */
const shortDay = (iso: string) => {
  const p = dayParts(iso);
  return p ? `${p.d}/${p.m}` : iso;
};

/** Unambiguous label for tooltips and the range caption, e.g. "1 Jul 2026". */
const longDay = (iso: string) => {
  const p = dayParts(iso);
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : iso;
};

/** A headline figure. No plot, so no hover layer — the number is the content. */
function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        flex: '1 1 150px', minWidth: 140, background: tokens.color.bgElevated,
        border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md,
        padding: '10px 12px',
      }}
    >
      <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>
        {label}
      </div>
      <strong style={{ display: 'block', fontSize: 20, color: tokens.color.text, lineHeight: 1.3 }}>
        {value}
      </strong>
      {hint && <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{hint}</div>}
    </div>
  );
}

/**
 * Daily gate throughput, IN vs OUT — grouped bars on one shared axis.
 *
 * Two series → a legend is always present, and each bar carries a hover tooltip
 * naming its day, series and count, so identity is never colour-alone. Bars are
 * separated by a 2px surface gap and have 4px rounded tops anchored to the
 * baseline. One y-axis only: both series are the same measure (gate events).
 */
function ThroughputChart({ days }: { days: Array<{ day: string; in_count: number; out_count: number }> }) {
  const [hover, setHover] = useState<{ i: number; series: 'IN' | 'OUT' } | null>(null);
  const hovered = hover ? days[hover.i] : undefined;

  const H = 150;              // plot height in px
  const max = Math.max(1, ...days.flatMap((d) => [d.in_count, d.out_count]));
  // Round the axis top to a friendly number so the gridline labels read cleanly.
  const step = max <= 20 ? 5 : max <= 50 ? 10 : max <= 120 ? 25 : 50;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);

  if (days.length === 0) {
    return (
      <CalciteNotice open kind="info" icon="information" scale="s">
        <div slot="message">No gate movements in the selected facility.</div>
      </CalciteNotice>
    );
  }

  const legend = (
    <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: tokens.color.textMuted }}>
      {([['IN', tokens.series.A], ['OUT', tokens.series.B]] as const).map(([name, colour]) => (
        <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: colour, display: 'inline-block' }} />
          Gate {name}
        </span>
      ))}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>Daily gate throughput</strong>
        {legend}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {/* y-axis labels — recessive, outside the plot */}
        <div style={{ display: 'flex', flexDirection: 'column-reverse', justifyContent: 'space-between', height: H, fontSize: 10, color: tokens.color.textMuted, textAlign: 'right', minWidth: 22 }}>
          {ticks.map((t) => <span key={t} style={{ lineHeight: 1 }}>{t}</span>)}
        </div>

        <div style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
          <div style={{ position: 'relative', height: H, minWidth: days.length * 26 }}>
            {/* recessive gridlines */}
            {ticks.map((t) => (
              <div
                key={t}
                aria-hidden
                style={{
                  position: 'absolute', left: 0, right: 0, bottom: (t / top) * H,
                  borderTop: `1px solid ${tokens.color.border}`, opacity: t === 0 ? 1 : 0.55,
                }}
              />
            ))}

            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 4 }}>
              {days.map((d, i) => (
                <div key={d.day} style={{ flex: 1, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2, height: '100%' }}>
                  {([['IN', d.in_count, tokens.series.A], ['OUT', d.out_count, tokens.series.B]] as const).map(
                    ([series, count, colour]) => (
                      <div
                        key={series}
                        role="img"
                        aria-label={`${shortDay(d.day)} gate ${series}: ${count}`}
                        title={`${longDay(d.day)} · Gate ${series} · ${count}`}
                        onMouseEnter={() => setHover({ i, series })}
                        onMouseLeave={() => setHover(null)}
                        style={{
                          width: 9,
                          height: Math.max(count > 0 ? 2 : 0, (count / top) * H),
                          background: colour,
                          borderRadius: '4px 4px 0 0',
                          opacity: hover && !(hover.i === i && hover.series === series) ? 0.55 : 1,
                          cursor: 'default',
                          transition: 'opacity 120ms',
                        }}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* x-axis: every other day labelled so 26 ticks never collide */}
          <div style={{ display: 'flex', gap: 4, minWidth: days.length * 26, marginTop: 4 }}>
            {days.map((d, i) => (
              <div key={d.day} style={{ flex: 1, textAlign: 'center', fontSize: 9.5, color: tokens.color.textMuted, whiteSpace: 'nowrap' }}>
                {i % 2 === 0 ? shortDay(d.day) : ' '}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Hover read-out. Sits in fixed space so the layout never jumps. */}
      <div style={{ minHeight: 18, marginTop: 4, fontSize: 11.5, color: tokens.color.textMuted }}>
        {hovered ? (
          <>
            <strong style={{ color: tokens.color.text }}>{longDay(hovered.day)}</strong>
            {' · gate '}{hover?.series}{' · '}
            <strong style={{ color: tokens.color.text }}>
              {hover?.series === 'IN' ? hovered.in_count : hovered.out_count}
            </strong>
            {' containers'}
          </>
        ) : `${days.length} days · hover a bar for its exact count`}
      </div>
    </div>
  );
}

/**
 * Chain completeness — parts of one whole, so a single stacked bar rather than a
 * pie. Each segment is directly labelled, separated by a 2px surface gap, and
 * uses a neutral ink ramp rather than the categorical series colours (these are
 * states of one measure, not independent series).
 */
function ChainCompleteness({ stats }: { stats: CfsEcyChainStats }) {
  const total = stats.chains || 0;
  const complete = stats.complete_chains || 0;
  const partial = stats.partial_chains || 0;
  const other = Math.max(0, total - complete - partial);
  if (total === 0) return null;

  const segs = [
    { label: 'Complete', n: complete, colour: tokens.color.brand,
      hint: 'ECY-out → CFS-in → CFS-out all present' },
    { label: 'Partial', n: partial, colour: tokens.color.textMuted,
      hint: 'the sequence stops short' },
    { label: 'Other', n: other, colour: tokens.color.border,
      hint: 'neither complete nor partial' },
  ].filter((s) => s.n > 0);

  return (
    <div>
      <strong style={{ fontSize: 13, color: tokens.color.text }}>Chain completeness</strong>
      <div style={{ display: 'flex', gap: 2, marginTop: 8, height: 22, borderRadius: 4, overflow: 'hidden' }}>
        {segs.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${s.n.toLocaleString()} of ${total.toLocaleString()} — ${s.hint}`}
            style={{
              width: `${(s.n / total) * 100}%`, background: s.colour,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 10.5, color: s.colour === tokens.color.border ? tokens.color.text : '#fff',
              whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            {(s.n / total) > 0.12 ? s.n.toLocaleString() : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, color: tokens.color.textMuted }}>
        {segs.map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: s.colour, display: 'inline-block' }} />
            {s.label} — <strong style={{ color: tokens.color.text }}>{s.n.toLocaleString()}</strong>
            {` (${((s.n / total) * 100).toFixed(0)}%)`}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CfsEcy() {
  const { adapter } = useApp();
  const [facility, setFacility] = useState<CfsEcyFacility | 'ALL'>('ALL');

  const unavailable = () =>
    Promise.reject(new Error('The CFS/ECY API is unavailable in this data mode.'));

  const scope = facility === 'ALL' ? undefined : facility;
  const stats = useAsync<CfsEcyStats>(
    () => (adapter.getCfsEcyStats ? adapter.getCfsEcyStats(scope) : unavailable()),
    [adapter, scope],
  );
  const chains = useAsync<CfsEcyChainStats>(
    () => (adapter.getCfsEcyChainStats ? adapter.getCfsEcyChainStats() : unavailable()),
    [adapter],
  );
  const dwell = useAsync<CfsEcyDwellItem[]>(
    () => (adapter.getCfsEcyDwell ? adapter.getCfsEcyDwell({ limit: 200 }) : unavailable()),
    [adapter],
  );

  const s = stats.data;
  const c = chains.data;
  const days = useMemo(
    () => [...(s?.daily_throughput ?? [])].sort((a, b) => a.day.localeCompare(b.day)),
    [s],
  );
  const dwellRows = useMemo(
    () => [...(dwell.data ?? [])].sort((a, b) => (num(b.dwell_hours) ?? -1) - (num(a.dwell_hours) ?? -1)),
    [dwell.data],
  );

  const anomalies = (c?.by_anomaly ?? []).filter((a) => a.chains > 0);

  const first = days[0];
  const last = days[days.length - 1];
  const range = first && last ? `${longDay(first.day)} – ${longDay(last.day)}` : 'no dated movements';

  return (
    <>
      <SourceBadge source="POC-3 · CFS-CODECO + ECY-CODECO (off-dock gate movements)" live />

      {/* The scope limit is stated on screen, not just in code, so nobody reading
          the panel mistakes a port-wide figure for a container's history. */}
      <CalciteNotice open kind="info" icon="information" scale="s" style={{ margin: '4px 0 10px' }}>
        <div slot="title">Port-level statistics</div>
        <div slot="message">
          Throughput and dwell for the off-dock CFS/ECY leg, measured across all containers
          in this feed. These container numbers do not appear on any manifest, advance list
          or gate document held here, so these figures describe the port — not the journey
          of any container shown on another tab.
        </div>
      </CalciteNotice>

      {stats.loading || chains.loading ? (
        <CalciteLoader scale="s" label="Loading CFS/ECY statistics" />
      ) : stats.error || chains.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load CFS/ECY statistics</div>
          <div slot="message">{stats.error ?? chains.error}</div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '0 0 10px' }}>
            <CalciteSegmentedControl
              scale="s"
              onCalciteSegmentedControlChange={(e) =>
                setFacility((e.target as unknown as { selectedItem?: { value?: string } })
                  .selectedItem?.value as CfsEcyFacility | 'ALL')}
            >
              <CalciteSegmentedControlItem value="ALL" checked={facility === 'ALL'}>Both</CalciteSegmentedControlItem>
              <CalciteSegmentedControlItem value="CFS" checked={facility === 'CFS'}>CFS</CalciteSegmentedControlItem>
              <CalciteSegmentedControlItem value="ECY" checked={facility === 'ECY'}>ECY</CalciteSegmentedControlItem>
            </CalciteSegmentedControl>
            <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}>{range}</span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <StatTile label="Gate events" value={fmtInt(s?.total_events)}
              hint={`${fmtInt(s?.total_in)} in · ${fmtInt(s?.total_out)} out`} />
            <StatTile label="Containers" value={fmtInt(s?.container_count)}
              hint={`${fmtInt(s?.active_containers)} still in`} />
            <StatTile label="Median CFS dwell" value={fmtHours(s?.median_dwell_hours)}
              hint={`mean ${fmtHours(s?.average_dwell_hours)} · n=${fmtInt(s?.dwell_count)}`} />
            <StatTile label="Avg road transit" value={fmtHours(c?.avg_transit_hours)}
              hint="ECY gate-out → CFS gate-in" />
            <StatTile label="Median full cycle" value={fmtHours(c?.median_cycle_hours)}
              hint={`mean ${fmtHours(c?.avg_cycle_hours)}`} />
          </div>

          <div style={{ marginBottom: 18 }}>
            <ThroughputChart days={days} />
          </div>

          {c && (
            <div
              style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 18, marginBottom: 18,
              }}
            >
              <ChainCompleteness stats={c} />

              <div>
                <strong style={{ fontSize: 13, color: tokens.color.text }}>
                  Chain exceptions ({fmtInt(c.anomaly_chains)} of {fmtInt(c.chains)})
                </strong>
                {anomalies.length === 0 ? (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 0' }}>
                    No exceptions recorded.
                  </p>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    {anomalies.map((a) => (
                      <div
                        key={a.code}
                        style={{
                          display: 'flex', gap: 10, alignItems: 'baseline',
                          padding: '5px 0', borderBottom: `1px solid ${tokens.color.border}`,
                          fontSize: 12, color: tokens.color.textMuted,
                        }}
                      >
                        <strong style={{ color: tokens.color.text, minWidth: 46, textAlign: 'right' }}>
                          {a.chains.toLocaleString()}
                        </strong>
                        {/* Wording comes from the backend's own label map — the UI invents none. */}
                        <span>{c.anomaly_labels?.[a.code] ?? a.code}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
            <strong style={{ fontSize: 13, color: tokens.color.text }}>
              Longest CFS dwell{dwellRows.length > 0 ? ` (top ${dwellRows.length})` : ''}
            </strong>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={dwellRows.map((r) => ({
                  'Container': r.container_number,
                  'Facility': r.facility_type,
                  'First in': r.first_in_ts,
                  'Last out': r.last_out_ts,
                  'In events': r.in_events,
                  'Out events': r.out_events,
                  'Dwell hours': r.dwell_hours,
                }))}
                filename="cfs-ecy-dwell.csv"
              />
            </div>
          </div>

          {dwell.loading ? (
            <CalciteLoader scale="s" label="Loading dwell report" />
          ) : dwell.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load the dwell report</div>
              <div slot="message">{dwell.error}</div>
            </CalciteNotice>
          ) : dwellRows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="message">No container has both a gate-in and a gate-out, so no dwell can be computed.</div>
            </CalciteNotice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="CFS dwell by container, longest first">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Container" />
                  <CalciteTableHeader heading="Facility" />
                  <CalciteTableHeader heading="First in" />
                  <CalciteTableHeader heading="Last out" />
                  <CalciteTableHeader heading="Events (in/out)" />
                  <CalciteTableHeader heading="Dwell" />
                </CalciteTableRow>
                {dwellRows.map((r, i) => (
                  <CalciteTableRow key={`${r.container_number ?? 'row'}-${i}`}>
                    <CalciteTableCell>{r.container_number ?? '—'}</CalciteTableCell>
                    <CalciteTableCell>{r.facility_type ?? '—'}</CalciteTableCell>
                    <CalciteTableCell>{fmtTs(r.first_in_ts)}</CalciteTableCell>
                    <CalciteTableCell>{fmtTs(r.last_out_ts)}</CalciteTableCell>
                    <CalciteTableCell>{fmtInt(r.in_events)} / {fmtInt(r.out_events)}</CalciteTableCell>
                    <CalciteTableCell><strong>{fmtHours(r.dwell_hours)}</strong></CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}
        </>
      )}
    </>
  );
}
