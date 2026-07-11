/**
 * Container movement visibility (prompt §10) across Import (CFS/DPD), Export
 * (CFS/DPE), Trans-shipment and rail — unified, filterable, role-scoped. The
 * filter scopes the unified container list; the trail drill-down shows the full
 * event chain per container.
 */
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteButton, CalciteIcon, CalciteNotice,
} from '@esri/calcite-components-react';
import type { OriginStream } from '@jnpa/schemas';
import { ORIGIN_STREAMS, CONTAINER_STATUSES, EVENT_STATUS_TRANSITIONS } from '@jnpa/schemas';
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

/** Humanise an existing eventType/status for display (presentation only). */
const prettyEvent = (type: string) => type.replace(/_/g, ' ');

/**
 * Flag/hold/fail event types carry their own status so a held or tampered box
 * reads correctly instead of a bare "Done" (req: preserve Blocked/Failed/
 * Flagged/Hold). Colours reuse the existing tokens. Presentation only — nothing
 * here fabricates events.
 */
const FLAG_STATUS: Record<string, { label: string; color: string }> = {
  DAMAGE_FLAG: { label: 'Flagged', color: tokens.congestion.AMBER },
  CUSTOMS_FLAG: { label: 'Hold', color: tokens.congestion.AMBER },
  ESEAL_BREAK: { label: 'Failed', color: tokens.congestion.RED },
};

/**
 * Lifecycle timeline slide-over for one container — an Amazon-style vertical
 * tracker built ONLY from the container's existing event `trail` (already
 * chronologically ordered by the adapter). Reuses the project's fixed slide-over
 * pattern (see console/IntegrationConsole.tsx). No fabricated/future events.
 */
function TimelineDrawer({ move, onClose }: { move: ContainerMovementDTO; onClose: () => void }) {
  const trail = move.trail; // already ordered by ts in the adapter
  const lastIdx = trail.length - 1;
  // Remaining workflow = the canonical CONTAINER_STATUSES order (schemas) beyond
  // the FURTHEST stage the recorded trail has actually reached. Anchoring on the
  // trail — not the folded container.status, which can run ahead of the visible
  // events and collapse the rest of the workflow to nothing — means the pending
  // steps are ALWAYS shown, reusing the existing order and never fabricating events.
  const stageIdx = (t: string) =>
    CONTAINER_STATUSES.indexOf(
      ((EVENT_STATUS_TRANSITIONS as Record<string, string | undefined>)[t] ?? '') as (typeof CONTAINER_STATUSES)[number],
    );
  const curStageIdx = Math.max(-1, ...trail.map((e) => stageIdx(e.eventType)));
  const pending = CONTAINER_STATUSES.filter((_s, idx) => idx > curStageIdx);
  // One combined, ordered row list: recorded events first (Done / Current, or a
  // preserved flag/hold/fail status), then the still-pending lifecycle stages.
  const rows: Array<{
    key: string; label: string; status: { label: string; color: string };
    ts: string; facilityId: string; sourceSystem: string; pending: boolean;
  }> = [
    ...trail.map((e, i) => ({
      key: `${e.eventType}-${e.ts}-${i}`,
      label: prettyEvent(e.eventType),
      status:
        FLAG_STATUS[e.eventType] ??
        (i === lastIdx
          ? { label: 'Current', color: tokens.color.brand }
          : { label: 'Done', color: tokens.congestion.GREEN }),
      ts: e.ts, facilityId: e.facilityId, sourceSystem: e.sourceSystem, pending: false,
    })),
    ...pending.map((s) => ({
      key: `pending-${s}`,
      label: prettyEvent(s),
      status: { label: 'Pending', color: tokens.color.textMuted },
      ts: '', facilityId: '', sourceSystem: '', pending: true,
    })),
  ];
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
            {move.container.originStream} · {move.container.lineOwner} · status {move.container.status}
          </p>

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No event history</div>
              <div slot="message">No lifecycle events recorded for this container.</div>
            </CalciteNotice>
          ) : (
            <div>
              {rows.map((row, i) => (
                <div key={row.key} style={{ display: 'flex', gap: 10 }}>
                  {/* Rail: milestone dot + connector line to the next event. */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span
                      style={{
                        width: 12, height: 12, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                        // Filled for reached stages, hollow for pending ones.
                        background: row.pending ? tokens.color.bgPanel : row.status.color,
                        border: `2px solid ${row.status.color}`,
                      }}
                      aria-hidden
                    />
                    {i < rows.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 24, background: tokens.color.border }} aria-hidden />}
                  </div>
                  {/* Content: event name, status, timestamp, facility, source. */}
                  <div style={{ paddingBottom: 16, flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: row.pending ? tokens.color.textMuted : tokens.color.text }}>{row.label}</strong>
                      <CalciteChip scale="s" value={row.status.label} style={{ ['--calcite-chip-text-color' as never]: row.status.color }}>
                        {row.status.label}
                      </CalciteChip>
                    </div>
                    {!row.pending && (
                      <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 2 }}>
                        {new Date(row.ts).toLocaleString()}
                        {row.facilityId ? ` · ${row.facilityId}` : ''}
                        {row.sourceSystem ? ` · ${row.sourceSystem}` : ''}
                      </div>
                    )}
                  </div>
                </div>
              ))}
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
  // Reflect the manual customs flag (customsFlagStore) so the Flag action visibly
  // transitions the container's Customs cell to a "Flagged" state. Raw snapshot
  // (not audience-scoped) so the operator who flagged always sees the transition.
  const flags = useSyncExternalStore(customsFlagStore.subscribe, customsFlagStore.getSnapshot, customsFlagStore.getSnapshot);
  const flaggedNos = useMemo(() => new Set(flags.map((f) => f.containerNo)), [flags]);

  return (
    <>
    <Panel heading={t('panel_movements', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(moves) => (
        <>
          <ImportExportToolbar
            data={moves.map((m) => ({
              'Container No': m.container.containerNo,
              'ISO Type': m.container.isoTypeCode,
              'Size (ft)': m.container.sizeFt,
              'Laden': m.container.laden ? 'Laden' : 'Empty',
              'Gross Weight (kg)': m.container.grossWtKg,
              'Cargo Type': m.container.cargoType,
              'Line Owner': m.container.lineOwner,
              'Seal No': m.container.currentSealNo,
              'Current Status': m.container.status,
              'Origin Stream': m.container.originStream,
              'Facility': m.facilityId,
              'Last Event': m.lastEventType,
              'Last Event Time': m.lastEventTs,
              'Workflow': m.trail.map((e) => e.eventType).join(' → '),
            }))}
            filename="container-movements.csv"
          />
          {/* Sources per event are in the trail (TOS gate/yard, ICEGATE customs,
              FOIS rail, e-Seal). See the per-record Source column + timeline. */}
          <div><SourceBadge source="TOS · ICEGATE · FOIS · e-Seal" /></div>
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
                <CalciteTableCell><CalciteChip value={m.container.originStream}>{m.container.originStream}</CalciteChip></CalciteTableCell>
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
                  {flaggedNos.has(m.container.containerNo) ? (
                    // Flagged state — the Flag action transitioned this container.
                    <CalciteChip
                      scale="s"
                      icon="flag"
                      value="Flagged"
                      title="Flagged for customs scan"
                      style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.AMBER }}
                    >
                      Flagged
                    </CalciteChip>
                  ) : (
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
                  )}
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
