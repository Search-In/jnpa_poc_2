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
import { useMemo, useState, useSyncExternalStore } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteButton, CalciteIcon, CalciteNotice,
  CalciteInput, CalciteLabel,
} from '@esri/calcite-components-react';
import type { OriginStream } from '@jnpa/schemas';
import { ORIGIN_STREAMS, CONTAINER_STATUSES, EVENT_STATUS_TRANSITIONS, isValidContainerNo } from '@jnpa/schemas';
import type { CargoCreateInput, CargoCustomsStatus, ContainerMovementDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { customsFlagStore } from '../state/customsFlagStore.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
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
            {move.cargo ? 'N/A' : move.container.originStream} · {move.container.lineOwner} · status {move.container.status}
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

/**
 * Vessel Discharge modal — assigns a yard block to a live POC-3 cargo record via
 * the existing Poc3CargoAdapter write (`PUT /api/cargo/{id} { yard_block }`).
 * Reuses the app's role="dialog" overlay pattern (see TimelineDrawer) + CalciteNotice
 * feedback. Yard options are the distinct yard blocks already in the live cargo —
 * no hardcoded yard names. On success it bumps cargoRefreshStore so Movement +
 * Yard/Pendency refetch through the existing adapter flow.
 */
function VesselDischargeModal({ moves, onClose }: { moves: ContainerMovementDTO[]; onClose: () => void }) {
  const { adapter } = useApp();
  // Live POC-3 cargo records eligible for discharge (present + not yet released).
  const options = useMemo(() => moves.filter((m) => m.cargo && !m.cargo.is_released), [moves]);
  // Yard blocks already in use across the live cargo = the existing yard data.
  const yards = useMemo(
    () => Array.from(new Set(moves.map((m) => m.cargo?.yard_block).filter((y): y is string => !!y))).sort(),
    [moves],
  );
  const [containerNo, setContainerNo] = useState<string>(options[0]?.container.containerNo ?? '');
  const [yard, setYard] = useState<string>(yards[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const selected = options.find((m) => m.container.containerNo === containerNo) ?? options[0];
  const rec = selected?.cargo;

  const confirm = async () => {
    if (!adapter.updateCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    if (!selected || !yard) return;
    setBusy(true);
    setError(null);
    try {
      // Existing Poc3CargoAdapter → PUT /api/cargo/{id} { yard_block } → POC-3.
      await adapter.updateCargo(selected.container.containerNo, { yard_block: yard });
      cargoRefreshStore.bump(); // refetch Movement + Yard/Pendency via the existing flow
      setDone(true);
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label="Vessel discharge"
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(440px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="export" scale="s" />
          <strong style={{ fontSize: 14 }}>Vessel Discharge</strong>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {options.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No cargo awaiting discharge</div>
              <div slot="message">Every live cargo record is already released.</div>
            </CalciteNotice>
          ) : done ? (
            <CalciteNotice open kind="success" icon="check-circle" scale="s">
              <div slot="title">Discharge recorded</div>
              <div slot="message">{selected?.container.containerNo} assigned to yard {yard}.</div>
            </CalciteNotice>
          ) : (
            <>
              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Container</label>
              <CalciteSelect label="Container" onCalciteSelectChange={(e) => setContainerNo((e.target as unknown as { value: string }).value)}>
                {options.map((m) => (
                  <CalciteOption key={m.container.containerNo} value={m.container.containerNo} selected={m.container.containerNo === selected?.container.containerNo}>
                    {m.container.containerNo}
                  </CalciteOption>
                ))}
              </CalciteSelect>

              {/* Read-only context from the selected POC-3 cargo record. */}
              <div style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 10px', lineHeight: 1.7 }}>
                <div>Vessel: <strong style={{ color: tokens.color.text }}>{rec?.vessel_name ?? '—'}</strong></div>
                <div>Customs: <strong style={{ color: tokens.color.text }}>{rec?.customs_status ?? '—'}</strong></div>
                <div>Current yard: <strong style={{ color: tokens.color.text }}>{rec?.yard_block ?? '—'}</strong></div>
                <div>ETA: <strong style={{ color: tokens.color.text }}>{rec?.eta ? new Date(rec.eta).toLocaleString() : '—'}</strong></div>
              </div>

              <label style={{ fontSize: 12, color: tokens.color.textMuted }}>Assign yard block</label>
              {yards.length === 0 ? (
                <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
                  <div slot="message">No yard blocks available from the current cargo data.</div>
                </CalciteNotice>
              ) : (
                <CalciteSelect label="Yard block" onCalciteSelectChange={(e) => setYard((e.target as unknown as { value: string }).value)}>
                  {yards.map((y) => (
                    <CalciteOption key={y} value={y} selected={y === yard}>{y}</CalciteOption>
                  ))}
                </CalciteSelect>
              )}

              {error && (
                <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
                  <div slot="title">Discharge failed</div>
                  <div slot="message">{error}</div>
                </CalciteNotice>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {done ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose} disabled={busy}>Cancel</CalciteButton>
              <CalciteButton scale="s" iconStart="export" loading={busy} disabled={options.length === 0 || !yard || busy} onClick={confirm}>
                Confirm discharge
              </CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const CUSTOMS_STATUSES: CargoCustomsStatus[] = ['PENDING', 'CLEARED', 'HELD', 'UNDER_INSPECTION'];

/**
 * Create Cargo modal — books a NEW cargo record into the POC-3 shared backend via
 * `POST /api/cargo` (201). Only the container number (ISO-6346) is mandatory; the
 * rest map 1:1 to the CargoCreate DTO and default on the backend. A duplicate
 * surfaces as the 409 message; on success it bumps cargoRefreshStore so the grid
 * refetches from the Cargo API.
 */
function CreateCargoModal({ onClose }: { onClose: () => void }) {
  const { adapter } = useApp();
  const [form, setForm] = useState<CargoCreateInput>({ container_number: '', customs_status: 'PENDING', is_released: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (patch: Partial<CargoCreateInput>) => setForm((f) => ({ ...f, ...patch }));
  const cn = form.container_number.trim().toUpperCase().replace(/\s+/g, '');
  const cnValid = isValidContainerNo(cn);

  const submit = async () => {
    if (!adapter.createCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    if (!cnValid) { setError('Enter a valid ISO-6346 container number (e.g. MAEU6123458).'); return; }
    setBusy(true);
    setError(null);
    try {
      await adapter.createCargo({
        container_number: cn,
        vessel_name: form.vessel_name?.trim() || undefined,
        customs_status: form.customs_status,
        yard_block: form.yard_block?.trim() || undefined,
        is_released: form.is_released,
        vehicle_number: form.vehicle_number?.trim() || undefined,
        gate: form.gate?.trim() || undefined,
        eta: form.eta || undefined,
      });
      cargoRefreshStore.bump(); // refetch the grid from POC-3
      setDone(true);
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label="Create cargo record"
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(460px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="plus" scale="s" />
          <strong style={{ fontSize: 14 }}>New Cargo Record</strong>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {done ? (
            <CalciteNotice open kind="success" icon="check-circle" scale="s">
              <div slot="title">Cargo created</div>
              <div slot="message">{cn} was added to the shared Cargo backend.</div>
            </CalciteNotice>
          ) : (
            <>
              <CalciteLabel>Container number (ISO-6346)
                <CalciteInput value={form.container_number} placeholder="MAEU6123458"
                  status={form.container_number && !cnValid ? 'invalid' : 'idle'}
                  onCalciteInputInput={(e) => set({ container_number: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>
              <CalciteLabel>Vessel name
                <CalciteInput value={form.vessel_name ?? ''} placeholder="MAERSK SEMBAWANG"
                  onCalciteInputInput={(e) => set({ vessel_name: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>
              <CalciteLabel>Customs status
                <CalciteSelect label="Customs status" onCalciteSelectChange={(e) => set({ customs_status: (e.target as unknown as { value: CargoCustomsStatus }).value })}>
                  {CUSTOMS_STATUSES.map((s) => (
                    <CalciteOption key={s} value={s} selected={s === form.customs_status}>{s}</CalciteOption>
                  ))}
                </CalciteSelect>
              </CalciteLabel>
              <CalciteLabel>Yard block
                <CalciteInput value={form.yard_block ?? ''} placeholder="A-12"
                  onCalciteInputInput={(e) => set({ yard_block: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>
              <CalciteLabel>Vehicle number
                <CalciteInput value={form.vehicle_number ?? ''} placeholder="MH04AB1234"
                  onCalciteInputInput={(e) => set({ vehicle_number: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>
              <CalciteLabel>Gate
                <CalciteInput value={form.gate ?? ''} placeholder="GATE-3"
                  onCalciteInputInput={(e) => set({ gate: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>

              {error && (
                <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
                  <div slot="title">Create failed</div>
                  <div slot="message">{error}</div>
                </CalciteNotice>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {done ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose} disabled={busy}>Cancel</CalciteButton>
              <CalciteButton scale="s" iconStart="plus" loading={busy} disabled={!cnValid || busy} onClick={submit}>Create</CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Delete confirmation — removes a cargo record from the POC-3 shared backend via
 * `DELETE /api/cargo/{id}` (200). Reuses the role="dialog" overlay + CalciteNotice
 * feedback. On success it bumps cargoRefreshStore so the grid refetches.
 */
function DeleteCargoDialog({ containerNo, onClose }: { containerNo: string; onClose: () => void }) {
  const { adapter } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const confirm = async () => {
    if (!adapter.deleteCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    setBusy(true);
    setError(null);
    try {
      await adapter.deleteCargo(containerNo);
      cargoRefreshStore.bump(); // refetch the grid from POC-3
      setDone(true);
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`Delete ${containerNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(400px, 96vw)', background: tokens.color.bgPanel, border: `1px solid ${tokens.color.border}`,
          borderRadius: 12, boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.severity.CRIT, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="trash" scale="s" />
          <strong style={{ fontSize: 14 }}>Delete cargo record</strong>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>
        <div style={{ padding: 14 }}>
          {done ? (
            <CalciteNotice open kind="success" icon="check-circle" scale="s">
              <div slot="title">Deleted</div>
              <div slot="message">{containerNo} was removed from the shared Cargo backend.</div>
            </CalciteNotice>
          ) : (
            <p style={{ fontSize: 13, margin: 0 }}>
              Permanently delete <strong>{containerNo}</strong> from the shared Cargo backend? This cannot be undone.
            </p>
          )}
          {error && (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
              <div slot="title">Delete failed</div>
              <div slot="message">{error}</div>
            </CalciteNotice>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {done ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose} disabled={busy}>Cancel</CalciteButton>
              <CalciteButton scale="s" kind="danger" iconStart="trash" loading={busy} disabled={busy} onClick={confirm}>Confirm delete</CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function ContainerMovements() {
  const { adapter, role, lang } = useApp();
  const [stream, setStream] = useState<OriginStream | 'ALL'>('ALL');
  // Container whose lifecycle timeline is open in the slide-over (null = closed).
  const [selected, setSelected] = useState<ContainerMovementDTO | null>(null);
  // Vessel Discharge modal open state.
  const [dischargeOpen, setDischargeOpen] = useState(false);
  // Create Cargo modal open state.
  const [createOpen, setCreateOpen] = useState(false);
  // Container pending a delete confirmation (null = no dialog).
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Bumped after any cargo write → this list refetches from the Cargo API.
  const cargoRev = useCargoRefresh();
  const state = useAsync<ContainerMovementDTO[]>(
    () => adapter.getContainerMovements({ role, ...(stream !== 'ALL' ? { originStream: stream } : {}) }),
    [adapter, role, stream, cargoRev],
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            {/* Create a new cargo record in the POC-3 shared backend (POST). */}
            <CalciteButton scale="s" iconStart="plus" onClick={() => setCreateOpen(true)}>
              New Cargo
            </CalciteButton>
            {/* Vessel Discharge — beside the existing Import / Export buttons. */}
            <CalciteButton scale="s" appearance="outline" iconStart="export" onClick={() => setDischargeOpen(true)}>
              Vessel Discharge
            </CalciteButton>
            <div style={{ marginLeft: 'auto' }}>
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
            </div>
          </div>
          {dischargeOpen && <VesselDischargeModal moves={moves} onClose={() => setDischargeOpen(false)} />}
          {createOpen && <CreateCargoModal onClose={() => setCreateOpen(false)} />}
          {deleteTarget && <DeleteCargoDialog containerNo={deleteTarget} onClose={() => setDeleteTarget(null)} />}
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
              <CalciteTableHeader heading="Manage" />
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
                <CalciteTableCell>
                  {/* Delete this cargo record from the shared backend (DELETE). */}
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="danger"
                    iconStart="trash"
                    title="Delete this cargo record from the shared Cargo backend"
                    onClick={() => setDeleteTarget(m.container.containerNo)}
                  >
                    Delete
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
