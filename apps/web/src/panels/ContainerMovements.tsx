/**
 * Container movement visibility (prompt §10) across Import (CFS/DPD), Export
 * (CFS/DPE), Trans-shipment and rail — unified, filterable, role-scoped. The
 * filter scopes the unified container list; the trail drill-down shows the full
 * event chain per container.
 *
 * Data source: the POC-3 shared Cargo API (`GET /api/cargo`) — the single source
 * of truth. The adapter maps each cargo record into this panel's existing DTO,
 * so the layout, columns, timeline drawer and pagination are UNCHANGED. Fields
 * POC-3 does not model (e.g. originStream) render as "N/A" rather than redesign
 * the table.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteButton, CalciteIcon, CalciteNotice,
} from '@esri/calcite-components-react';
import type { OriginStream } from '@jnpa/schemas';
import { ORIGIN_STREAMS } from '@jnpa/schemas';
import type { ContainerMovementDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { customsFlagStore } from '../state/customsFlagStore.js';
import { SOURCE_LABELS } from '../console/faultStore.js';
import { tokens } from '../theme/tokens.js';
import { t } from '../i18n/strings.js';

/** Humanise an existing eventType for display (presentation only). */
const prettyEvent = (type: string) => type.replace(/_/g, ' ');

/**
 * Lifecycle timeline slide-over for one container — an Amazon-style vertical
 * tracker built ONLY from the container's existing event `trail` (already
 * chronologically ordered by the adapter). Reuses the project's fixed slide-over
 * pattern (see console/IntegrationConsole.tsx). No fabricated/future events.
 */
function TimelineDrawer({ move, onClose }: { move: ContainerMovementDTO; onClose: () => void }) {
  const trail = move.trail; // already ordered by ts in the adapter
  const lastIdx = trail.length - 1;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Lifecycle timeline for ${move.container.containerNo}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="clock" scale="s" />
          <strong style={{ fontSize: 14 }}>{move.container.containerNo}</strong>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}
          >
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
          <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 12px' }}>
            {move.cargo ? 'N/A' : move.container.originStream} · {move.container.lineOwner} · status {move.container.status}
          </p>

          {trail.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No event history</div>
              <div slot="message">No lifecycle events recorded for this container.</div>
            </CalciteNotice>
          ) : (
            <div>
              {trail.map((e, i) => {
                const current = i === lastIdx;
                return (
                  <div key={`${e.eventType}-${e.ts}-${i}`} style={{ display: 'flex', gap: 10 }}>
                    {/* Rail: milestone dot + connector line to the next event. */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span
                        style={{
                          width: 12, height: 12, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                          background: current ? tokens.color.brand : tokens.color.bgPanel,
                          border: `2px solid ${tokens.color.brand}`,
                        }}
                        aria-hidden
                      />
                      {i < lastIdx && <span style={{ width: 2, flex: 1, minHeight: 24, background: tokens.color.border }} aria-hidden />}
                    </div>
                    {/* Content: event name, status, timestamp, facility, source. */}
                    <div style={{ paddingBottom: 16, flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <strong style={{ fontSize: 13, color: tokens.color.text }}>{prettyEvent(e.eventType)}</strong>
                        <CalciteChip scale="s" kind={current ? 'brand' : 'neutral'} value={current ? 'Current' : 'Done'}>
                          {current ? 'Current' : 'Done'}
                        </CalciteChip>
                      </div>
                      <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 2 }}>
                        {new Date(e.ts).toLocaleString()}
                        {e.facilityId ? ` · ${e.facilityId}` : ''}
                        {e.sourceSystem ? ` · ${e.sourceSystem}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

export function ContainerMovements() {
  const { adapter, role, lang } = useApp();
  const [stream, setStream] = useState<OriginStream | 'ALL'>('ALL');
  // Container whose lifecycle timeline is open in the slide-over (null = closed).
  const [selected, setSelected] = useState<ContainerMovementDTO | null>(null);
  const state = useAsync<ContainerMovementDTO[]>(
    () => adapter.getContainerMovements({ role, ...(stream !== 'ALL' ? { originStream: stream } : {}) }),
    [adapter, role, stream],
  );

  return (
    <>
    <Panel heading={t('panel_movements', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(moves) => (
        <>
          <ImportExportToolbar data={moves} filename="container-movements.json" />
          {/* Sources per event are in the trail (TOS gate/yard, ICEGATE customs,
              FOIS rail, e-Seal). See the per-record Source column + timeline. */}
          <div><SourceBadge source="TOS · ICEGATE · FOIS · e-Seal" live /></div>
          <CalciteSelect
            label="Stream filter"
            onCalciteSelectChange={(e) => setStream((e.target as unknown as { value: OriginStream | 'ALL' }).value)}
          >
            <CalciteOption value="ALL" selected={stream === 'ALL'}>All streams</CalciteOption>
            {ORIGIN_STREAMS.map((s) => (
              <CalciteOption key={s} value={s} selected={stream === s}>{s}</CalciteOption>
            ))}
          </CalciteSelect>
          <p style={{ fontSize: 12, color: 'var(--calcite-color-text-3)' }}>{moves.length} containers</p>
          <CalciteTable caption="container movements">
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Container" />
              <CalciteTableHeader heading="Stream" />
              <CalciteTableHeader heading="Line" />
              <CalciteTableHeader heading="Last event" />
              <CalciteTableHeader heading="At" />
              <CalciteTableHeader heading="Source" />
              <CalciteTableHeader heading="Events" />
              <CalciteTableHeader heading="Customs" />
            </CalciteTableRow>
            {moves.slice(0, 50).map((m) => (
              <CalciteTableRow key={m.container.containerNo}>
                <CalciteTableCell>{m.container.containerNo}</CalciteTableCell>
                <CalciteTableCell>
                  {/* POC-3 does not model an origin stream → N/A (no redesign). */}
                  {m.cargo
                    ? <span style={{ color: tokens.color.textMuted }}>N/A</span>
                    : <CalciteChip value={m.container.originStream}>{m.container.originStream}</CalciteChip>}
                </CalciteTableCell>
                <CalciteTableCell>{m.container.lineOwner}</CalciteTableCell>
                <CalciteTableCell>{m.lastEventType}</CalciteTableCell>
                <CalciteTableCell>{m.facilityId}</CalciteTableCell>
                <CalciteTableCell>
                  {(() => {
                    // Source system of the latest event (existing trail metadata).
                    // In mock mode the header chip already flags data as SIMULATED.
                    const src = m.trail[m.trail.length - 1]?.sourceSystem;
                    return src
                      ? <CalciteChip scale="s" value={src} title={SOURCE_LABELS[src] ?? src}>{src}</CalciteChip>
                      : '—';
                  })()}
                </CalciteTableCell>
                <CalciteTableCell>
                  <CalciteButton
                    scale="s"
                    appearance="transparent"
                    kind="brand"
                    iconStart="information"
                    title="View lifecycle timeline"
                    onClick={() => setSelected(m)}
                  >
                    {m.trail.length}
                  </CalciteButton>
                </CalciteTableCell>
                <CalciteTableCell>
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="danger"
                    iconStart="flag"
                    title="Flag this container for a customs scan (raises a notification)"
                    onClick={() => customsFlagStore.flagForCustoms(m.container.containerNo, m.facilityId)}
                  >
                    Flag
                  </CalciteButton>
                </CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>
        </>
      )}
    </Panel>
    {selected && <TimelineDrawer move={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
