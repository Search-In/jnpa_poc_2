/**
 * JNPA Simulated Port-Data API — the one genuinely EXTERNAL live source in UC-II
 * (ticket UC2-006; WS3 "Min. 1 API + 1 fallback per use case. State data
 * volumes."; scored criteria 04 Integration and 09 Failover & Exceptions).
 *
 * Everything else on the Integration tab is a locally simulated adapter. This
 * panel is the exception: it reports the state of the backend poller that calls
 * `dt.jnpa.in/poc-api-data-access` and routes each downloaded file into the same
 * `core.*` tables the corpus dump fills. That is what makes the LIVE badge
 * meaningful — and what makes it falsifiable.
 *
 * ⚠ HONESTY RULES. This panel exists to be believed, so it must never flatter
 * the feed:
 * 1. `configured: false` means NO client key is set on the gateway — the sync is
 *    off. Say DISABLED. Never render that as a healthy idle state.
 * 2. A watermark is the last instant CONSUMED, not the current time. A stale
 *    watermark is shown as stale, in whole hours/days, not hidden behind "OK".
 * 3. An empty defect register is reported as "none observed" with the reason —
 *    it is a measurement, not a blank.
 * 4. `requestId` is NOT shown, because the API returns none (register item D3).
 *    The ingest-run id is quoted instead; that is what JNPA support can trace.
 */
import { CalciteChip, CalciteNotice, CalciteButton, CalciteIcon } from '@esri/calcite-components-react';
import type { JnpaApiDefect, JnpaApiHealth, JnpaApiRun } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';

/** Whole-unit age of an ISO instant, or null when it is absent/unparseable. */
function ageOf(iso: string | null | undefined): { text: string; hours: number } | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 1) return { text: `${Math.max(0, Math.round(hours * 60))} min ago`, hours };
  if (hours < 48) return { text: `${Math.round(hours)} h ago`, hours };
  return { text: `${Math.round(hours / 24)} days ago`, hours };
}

/**
 * GREEN only when the group advanced recently AND its last poll succeeded.
 * A group that last polled OK three days ago is AMBER, not GREEN — "it worked
 * once" is not the same claim as "it is live".
 */
function groupColor(status: string, hours: number | null): string {
  if (status === 'SKIPPED_STATIC') return tokens.color.textMuted;
  if (status === 'ERROR') return tokens.degradation.RED;
  if (hours == null || hours > 24) return tokens.degradation.AMBER;
  return tokens.degradation.GREEN;
}

function fmtBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <span style={{ color: tokens.color.textMuted }}>{label}</span>
      <span style={{ color: tokens.color.text }}>{value}</span>
    </>
  );
}

/**
 * OFF unless explicitly switched on — `VITE_SHOW_JNPA_FEED=true|1|yes`.
 *
 * Default-off rather than default-on because the card's honest answer today is
 * "DISABLED, watermarks days old", and an unattended demo should not open on a
 * red integration card that needs a paragraph of context to read correctly.
 * Absent, empty or unrecognised ⇒ hidden; only an affirmative value shows it.
 */
const FLAG = ((import.meta.env?.VITE_SHOW_JNPA_FEED as string | undefined) ?? '').trim().toLowerCase();
export const JNPA_FEED_ENABLED = FLAG === 'true' || FLAG === '1' || FLAG === 'yes';

export function JnpaApiFeed() {
  const { adapter } = useApp();
  const canRead = typeof adapter.getJnpaApiHealth === 'function';

  const health = useAsync<JnpaApiHealth | null>(
    () => (adapter.getJnpaApiHealth ? adapter.getJnpaApiHealth() : Promise.resolve(null)),
    [adapter],
  );
  const runs = useAsync<JnpaApiRun[]>(
    () => (adapter.getJnpaApiRuns ? adapter.getJnpaApiRuns(50) : Promise.resolve([])),
    [adapter],
  );
  const defects = useAsync<JnpaApiDefect[]>(
    () => (adapter.getJnpaApiDefects ? adapter.getJnpaApiDefects(50) : Promise.resolve([])),
    [adapter],
  );

  // No POC-3 adapter in the chain means there is no poller to report on. Say
  // that plainly rather than render a panel of zeroes that reads like a feed
  // which is merely quiet — and name the RIGHT switch: this is the build's cargo
  // source, NOT the LIVE/DEMO toggle in the header, which only chooses which
  // rows an already-connected backend returns.
  if (!canRead) {
    return (
      <CalciteNotice open kind="info" icon="information" width="full" scale="s">
        <div slot="title">JNPA Port-Data API — no backend connected in this build</div>
        <div slot="message">
          The feed is polled by the shared POC-3 backend, and this dashboard is running entirely
          against local adapters, so there is no poller to report on. Start it with{' '}
          <code>VITE_CARGO_SOURCE=poc3</code> and <code>POC3_URL</code> pointing at the gateway.
          The header’s LIVE / DEMO toggle does not affect this — it filters rows within a connected
          backend.
        </div>
      </CalciteNotice>
    );
  }

  if (health.error) {
    return (
      <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" width="full" scale="s">
        <div slot="title">JNPA Port-Data API — feed state unavailable</div>
        <div slot="message">
          The backend health endpoint could not be read ({health.error}). Treat the LIVE badge as
          unverified until this resolves.
        </div>
      </CalciteNotice>
    );
  }

  const h = health.data;
  const disabled = h != null && !h.configured;
  const groups = h?.groups ?? [];
  const indexed = groups.filter((g) => g.kind !== 'static');
  const errored = indexed.filter((g) => g.last_status === 'ERROR');
  const newest = indexed
    .map((g) => ageOf(g.watermark_ts))
    .filter((a): a is { text: string; hours: number } => a != null)
    .sort((a, b) => a.hours - b.hours)[0] ?? null;

  // Volumes, summed over the runs the audit trail returned — labelled as such.
  // The alternative (quoting an all-time total we did not fetch) would be a
  // number nobody can reproduce from this screen.
  const ok = runs.data?.filter((r) => r.status !== 'ERROR') ?? [];
  const vol = ok.reduce(
    (a, r) => ({
      records: a.records + (r.records_new ?? 0),
      files: a.files + (r.files_downloaded ?? 0),
      bytes: a.bytes + (r.bytes_downloaded ?? 0),
      skipped: a.skipped + (r.files_skipped_checksum ?? 0),
    }),
    { records: 0, files: 0, bytes: 0, skipped: 0 },
  );

  const last = h?.last_run ?? null;

  return (
    <section
      aria-label="JNPA Simulated Port-Data API feed"
      style={{
        border: `1px solid ${tokens.color.border}`, borderRadius: 8,
        background: tokens.color.bgPanel, padding: '12px 14px', marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <CalciteIcon icon="transmit" scale="s" />
        <strong style={{ fontSize: 14 }}>JNPA Simulated Port-Data API</strong>
        {/* Calcite chips carry no danger kind, so the failing state is coloured
            through the text token — the same device HealthCards uses. */}
        <CalciteChip
          scale="s"
          kind={disabled || errored.length ? 'neutral' : 'brand'}
          style={errored.length
            ? ({ ['--calcite-chip-text-color' as never]: tokens.degradation.RED })
            : undefined}
          value={h?.mode ?? 'UNKNOWN'}
        >
          {disabled ? 'DISABLED — no client key' : h?.mode ?? 'UNKNOWN'}
        </CalciteChip>
        <span style={{ fontSize: 11.5, color: tokens.color.textMuted, marginLeft: 'auto' }}>
          The only external source in UC-II — everything below this card is simulated.
        </span>
      </div>

      <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '6px 0 10px' }}>
        <code>{h?.api_url ?? '—'}</code> · 13 data groups polled on a schedule; each downloaded file
        is routed into the same <code>core.*</code> tables the corpus dump fills, deduplicated by
        SHA-256. <strong>Fallback:</strong> if the API is unreachable the dashboard keeps serving the
        pre-loaded corpus — the same tables, badged DEMO.
      </p>

      {disabled && (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s" style={{ marginBottom: 10 }}>
          <div slot="title">The poller is off — no client key is configured on the gateway</div>
          <div slot="message">
            Watermarks below are historical: they record where each group had reached when the sync
            last ran, not a feed that is currently advancing. Set{' '}
            <code>JNPA_PORTDATA_CLIENT_KEY</code> on the backend to resume.
          </div>
        </CalciteNotice>
      )}

      {!disabled && errored.length > 0 && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginBottom: 10 }}>
          <div slot="title">{errored.length} of {indexed.length} groups failed their last poll</div>
          <div slot="message">
            {last?.error ? <>Last error: <code>{last.error}</code>. </> : null}
            Quote ingest run <code>#{last?.id ?? '—'}</code> when reporting this — the API returns no{' '}
            <code>requestId</code> to quote (defect register D3).
          </div>
        </CalciteNotice>
      )}

      {/* Volumes — WS3 asks bidders to state them, so they are on the screen. */}
      <div
        style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: '4px 12px',
          fontSize: 12, background: tokens.color.bgElevated,
          border: `1px solid ${tokens.color.border}`, borderRadius: 6,
          padding: '8px 10px', marginBottom: 10,
        }}
      >
        <Row label="Newest watermark" value={newest ? newest.text : 'never polled'} />
        <Row label="Groups healthy" value={`${indexed.length - errored.length} of ${indexed.length}`} />
        <Row label="Records ingested" value={`${vol.records.toLocaleString()} (last ${ok.length} polls)`} />
        <Row label="Files downloaded" value={`${vol.files.toLocaleString()} · ${fmtBytes(vol.bytes)}`} />
        <Row
          label="Deduplicated"
          value={`${vol.skipped.toLocaleString()} already held from the dump`}
        />
        <Row
          label="Last poll"
          value={last
            ? `${last.group_slug ?? 'all'} — ${last.status}${ageOf(last.started_at) ? ` · ${ageOf(last.started_at)!.text}` : ''}`
            : '—'}
        />
      </div>

      {/* Per-group state. A watermark is the last instant consumed, so an old one
          is shown as old — this table is the audience's check on the LIVE claim. */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: tokens.color.textMuted }}>
              <th style={{ padding: '4px 8px 4px 0' }}>Group</th>
              <th style={{ padding: '4px 8px' }}>Kind</th>
              <th style={{ padding: '4px 8px' }}>Watermark (last consumed)</th>
              <th style={{ padding: '4px 8px' }}>Last poll</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const age = ageOf(g.watermark_ts);
              return (
                <tr key={g.group} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                  <td style={{ padding: '4px 8px 4px 0' }}>
                    <span
                      aria-hidden
                      style={{
                        display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                        marginRight: 6, background: groupColor(g.last_status, age?.hours ?? null),
                      }}
                    />
                    <code>{g.group}</code>
                  </td>
                  <td style={{ padding: '4px 8px', color: tokens.color.textMuted }}>{g.kind}</td>
                  <td style={{ padding: '4px 8px' }}>
                    {g.kind === 'static'
                      ? <span style={{ color: tokens.color.textMuted }}>not served by the API</span>
                      : age ? age.text : <span style={{ color: tokens.color.textMuted }}>never</span>}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{g.last_status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The defect register JNPA asked bidders to keep. Empty is a result. */}
      <div style={{ marginTop: 10 }}>
        <strong style={{ fontSize: 12.5 }}>Observed API defects</strong>
        {defects.data && defects.data.length > 0 ? (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {defects.data.map((d) => (
              <li key={d.id}>
                <code>{d.defect_code}</code> [{d.severity}] {d.endpoint ? <>@ <code>{d.endpoint}</code> </> : null}
                — {d.description ?? 'no detail recorded'}{' '}
                <span style={{ color: tokens.color.textMuted }}>(run #{d.ingest_run_id ?? '—'})</span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '4px 0 0' }}>
            None observed at runtime. The client checks every response for the catalogued deviations
            and records any it sees here; 45 further defects found by inspecting the published
            specification are filed separately in the written register.
          </p>
        )}
      </div>

      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="refresh"
        style={{ marginTop: 10 }}
        onClick={() => window.location.reload()}
      >
        Refresh feed state
      </CalciteButton>
    </section>
  );
}
