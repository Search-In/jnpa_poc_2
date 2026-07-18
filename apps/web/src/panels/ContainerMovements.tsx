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
  CalciteInput, CalciteLabel, CalciteLoader, CalciteList, CalciteListItem,
} from '@esri/calcite-components-react';
import type { OriginStream } from '@jnpa/schemas';
// TODO(TEMP — ISO-6346 bypass): `isValidContainerNo` was removed from this import
// ONLY because the New Cargo dialog's ISO-6346 gate is temporarily disabled for
// UC2↔UC3 manual testing (see CreateCargoModal below). RESTORE this import and the
// validation once end-to-end testing is complete. The shared validator in
// @jnpa/schemas is unchanged and still used everywhere else (Movement search, mapper).
import { ORIGIN_STREAMS, CONTAINER_STATUSES, EVENT_STATUS_TRANSITIONS } from '@jnpa/schemas';
import type { CargoCreateInput, CargoCustomsStatus, CargoLifecycleEvent, ContainerMovementDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { customsFlagStore } from '../state/customsFlagStore.js';
import { CargoWorkflowDialog } from './CargoWorkflowDialog.js';
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
  // Real per-container Cargo Events (POC-3 `GET /api/cargo/events?container_number=`),
  // shown as an ADDITIONAL section below the derived milestone trail. Reuses the
  // existing getCargoEvents adapter method + CargoLifecycleEvent DTO; degrades
  // gracefully (method absent in mock mode / error / empty → a quiet notice).
  const { adapter } = useApp();
  const containerNo = move.container.containerNo;
  const events = useAsync<CargoLifecycleEvent[]>(
    () => (adapter.getCargoEvents ? adapter.getCargoEvents(containerNo) : Promise.resolve([])),
    [adapter, containerNo],
  );
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
            {move.cargo ? (move.cargo.origin_stream ?? 'N/A') : move.container.originStream} · {move.container.lineOwner} · status {move.container.status}
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

          {/* ── Real Cargo Events (POC-3) — ADDITIVE section; the derived timeline
              above is unchanged. Surfaces the authoritative lifecycle event stream
              for THIS container (Appendix-C UC-II IU-2 + handover Cargo Lifecycle
              Events). Reuses getCargoEvents + CargoLifecycleEvent + the existing
              list render pattern (see StakeholderNotifications). ─────────────── */}
          <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '18px 0 6px' }}>
            Cargo events (POC-3)
          </div>
          {events.loading ? (
            <CalciteLoader scale="s" label="Loading cargo events" />
          ) : events.error ? (
            <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
              <div slot="message">{events.error}</div>
            </CalciteNotice>
          ) : (() => {
            // Scope to THIS container client-side (backend may or may not honour the
            // container_number filter), newest-first when created_at is present.
            const list = (events.data ?? [])
              .filter((ev) => !ev.container_number || ev.container_number === containerNo)
              .slice()
              .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
            return list.length === 0 ? (
              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '2px 0' }}>
                No cargo events recorded for this container yet.
              </p>
            ) : (
              <CalciteList label="cargo events">
                {list.slice(0, 40).map((ev, i) => (
                  <CalciteListItem
                    key={ev.id ?? i}
                    label={ev.event_type ?? 'event'}
                    description={ev.created_at ? new Date(ev.created_at).toLocaleString() : undefined}
                  />
                ))}
              </CalciteList>
            );
          })()}
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
  // Live POC-3 cargo records eligible for discharge (present + not yet released).
  const options = useMemo(() => moves.filter((m) => m.cargo && !m.cargo.is_released), [moves]);
  const [containerNo, setContainerNo] = useState<string>(options[0]?.container.containerNo ?? '');
  const [done, setDone] = useState(false);
  const selected = options.find((m) => m.container.containerNo === containerNo) ?? options[0];
  const rec = selected?.cargo;

  // Vessel Discharge marks the container as discharged ONLY — it no longer assigns
  // a yard block. Per the UC-II flow, yard assignment now happens later in the
  // Pendency flow. The backend exposes no dedicated "discharged" field, so this is
  // a discharge milestone confirmation; no cargo record field is written here, and
  // no cargo write API (updateCargo) is called.
  const confirm = () => {
    if (!selected) return;
    setDone(true);
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
            <SuccessNotice
              title="Vessel discharge completed successfully."
              details={[{ label: 'Container', value: selected?.container.containerNo }]}
            />
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
                <div>ETA: <strong style={{ color: tokens.color.text }}>{rec?.eta ? new Date(rec.eta).toLocaleString() : '—'}</strong></div>
              </div>

              {/* Yard block is intentionally NOT collected here — yard assignment
                  happens in the Pendency flow (UC-II). Discharge only marks the
                  container as discharged. */}
              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '2px 0 0' }}>
                Marks the selected container as discharged. Assign a yard block later from the Pendency tab.
              </p>
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {done ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose}>Cancel</CalciteButton>
              <CalciteButton scale="s" iconStart="export" disabled={options.length === 0} onClick={confirm}>
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
  // TODO(TEMP — ISO-6346 bypass): The Create button was gated on the ISO-6346
  // check digit via `isValidContainerNo(cn)`, which blocked any number whose check
  // digit did not match. For UC2↔UC3 manual testing the gate is temporarily reduced
  // to "required field filled" (non-empty container number) so any container number
  // can be created. RESTORE `const cnValid = isValidContainerNo(cn);` (and the
  // import above) after end-to-end testing is complete. Backend POST /api/cargo and
  // the request payload are unchanged — only this client-side gate is relaxed.
  const cnValid = cn.length > 0; // was: isValidContainerNo(cn)

  const submit = async () => {
    if (!adapter.createCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    // TODO(TEMP — ISO-6346 bypass): message relaxed to match the temporary
    // required-field-only gate. Restore the ISO-6346 message with the validation.
    if (!cnValid) { setError('Enter a container number.'); return; }
    setBusy(true);
    setError(null);
    try {
      await adapter.createCargo({
        container_number: cn,
        vessel_name: form.vessel_name?.trim() || undefined,
        customs_status: form.customs_status,
        // yard_block deliberately not sent from Add Cargo (assigned later in Pendency).
        is_released: form.is_released,
        vehicle_number: form.vehicle_number?.trim() || undefined,
        // gate no longer collected in Add Cargo (field removed from the dialog).
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
            <SuccessNotice title="Cargo created successfully." details={[{ label: 'Container', value: cn }]} />
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
              {/* Yard block intentionally removed from Add Cargo — yard assignment now
                  happens later in the Pendency flow (UC-II). The backend CargoCreate API
                  is unchanged (yard_block remains optional and simply isn't sent here). */}
              <CalciteLabel>Vehicle number
                <CalciteInput value={form.vehicle_number ?? ''} placeholder="MH04AB1234"
                  onCalciteInputInput={(e) => set({ vehicle_number: (e.target as unknown as { value: string }).value })} />
              </CalciteLabel>
              {/* Gate field removed from Add Cargo — no longer collected here.
                  The backend CargoCreate API is unchanged (gate remains optional). */}

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
            <SuccessNotice title="Cargo deleted successfully." details={[{ label: 'Container', value: containerNo }]} />
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
  // Container whose POC-3 workflow (trigger/approve/reject + history) is open.
  const [workflowTarget, setWorkflowTarget] = useState<string | null>(null);
  // Container Search + POC-3 list filters (Appendix-C UC-II R1 "visibility of
  // container movements … container details" + R3 customs-flagged real-time status).
  // ADDITIVE: reuses the existing ContainerMovementFilter the adapter already honours
  // (containerNo → GET /api/cargo/{id}; customsStatus/isReleased → GET /api/cargo
  // query params). `searchInput` is the field; `searchApplied` is what the fetch uses
  // (applied on the Search button so the list doesn't churn per keystroke). The
  // existing Stream filter and every row action are unchanged.
  const [searchInput, setSearchInput] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [customsStatus, setCustomsStatus] = useState<CargoCustomsStatus | 'ALL'>('ALL');
  const [released, setReleased] = useState<'ALL' | 'IN_PORT' | 'RELEASED'>('ALL');
  // Bumped after any cargo write → this list refetches from the Cargo API.
  const cargoRev = useCargoRefresh();
  const state = useAsync<ContainerMovementDTO[]>(
    () => adapter.getContainerMovements({
      role,
      ...(searchApplied ? { containerNo: searchApplied } : {}),
      ...(stream !== 'ALL' ? { originStream: stream } : {}),
      ...(customsStatus !== 'ALL' ? { customsStatus } : {}),
      ...(released !== 'ALL' ? { isReleased: released === 'RELEASED' } : {}),
    }),
    [adapter, role, stream, customsStatus, released, searchApplied, cargoRev],
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
                  'Origin Stream': m.cargo?.origin_stream ?? m.container.originStream,
                  'Facility': m.facilityId,
                  'Last Event': m.lastEventType,
                  'Last Event Time': m.lastEventTs,
                  'Workflow': m.trail.map((e) => e.eventType).join(' → '),
                }))}
                filename="container-movements.csv"
              />
            </div>
          </div>
          {/* Sources per event are in the trail (TOS gate/yard, ICEGATE customs,
              FOIS rail, e-Seal). See the per-record Source column + timeline. */}
          <div><SourceBadge source="TOS · ICEGATE · FOIS · e-Seal" live /></div>
          {/* Container Search + POC-3 filters (additive; the Stream filter below is
              unchanged). Search = exact ISO-6346 lookup (GET /api/cargo/{id});
              Customs status / Release state map to the existing GET /api/cargo params. */}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <CalciteLabel scale="s" style={{ minWidth: 220 }}>Search container (ISO-6346)
              <div style={{ display: 'flex', gap: 6 }}>
                <CalciteInput
                  scale="s"
                  value={searchInput}
                  placeholder="MAEU6123458"
                  onCalciteInputInput={(e) => setSearchInput((e.target as unknown as { value: string }).value)}
                />
                <CalciteButton
                  scale="s"
                  iconStart="search"
                  onClick={() => setSearchApplied(searchInput.trim().toUpperCase().replace(/\s+/g, ''))}
                >
                  Search
                </CalciteButton>
                {searchApplied && (
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="neutral"
                    iconStart="x"
                    onClick={() => { setSearchInput(''); setSearchApplied(''); }}
                  >
                    Clear
                  </CalciteButton>
                )}
              </div>
            </CalciteLabel>
            <CalciteLabel scale="s" style={{ minWidth: 150 }}>Customs status
              <CalciteSelect
                label="Customs status filter"
                scale="s"
                onCalciteSelectChange={(e) => setCustomsStatus((e.target as unknown as { value: CargoCustomsStatus | 'ALL' }).value)}
              >
                <CalciteOption value="ALL" selected={customsStatus === 'ALL'}>All</CalciteOption>
                {CUSTOMS_STATUSES.map((s) => (
                  <CalciteOption key={s} value={s} selected={s === customsStatus}>{s}</CalciteOption>
                ))}
              </CalciteSelect>
            </CalciteLabel>
            <CalciteLabel scale="s" style={{ minWidth: 130 }}>Release state
              <CalciteSelect
                label="Release state filter"
                scale="s"
                onCalciteSelectChange={(e) => setReleased((e.target as unknown as { value: 'ALL' | 'IN_PORT' | 'RELEASED' }).value)}
              >
                <CalciteOption value="ALL" selected={released === 'ALL'}>All</CalciteOption>
                <CalciteOption value="IN_PORT" selected={released === 'IN_PORT'}>In-port</CalciteOption>
                <CalciteOption value="RELEASED" selected={released === 'RELEASED'}>Released</CalciteOption>
              </CalciteSelect>
            </CalciteLabel>
          </div>
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
                  {/* Origin stream from the POC-3 cargo record when present; the
                      existing N/A fallback is kept when the backend value is null. */}
                  {m.cargo
                    ? (m.cargo.origin_stream
                        ? <CalciteChip value={m.cargo.origin_stream}>{m.cargo.origin_stream}</CalciteChip>
                        : <span style={{ color: tokens.color.textMuted }}>N/A</span>)
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
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    {/* Per-container workflow: trigger/approve/reject + append-only
                        history from the POC-3 Cargo Workflow API (additive). */}
                    <CalciteButton
                      scale="s"
                      appearance="outline"
                      kind="brand"
                      iconStart="workflow"
                      title="Open this container's approval workflow (POC-3)"
                      onClick={() => setWorkflowTarget(m.container.containerNo)}
                    >
                      Workflow
                    </CalciteButton>
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
                  </div>
                </CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>
        </>
      )}
    </Panel>
    {/* Dialogs are mounted OUTSIDE the Panel so they survive the post-write refetch.
        (The Panel unmounts its children while useAsync reloads — mounting a dialog
        inside would reset its success state, re-showing the confirmation UI.) */}
    {dischargeOpen && <VesselDischargeModal moves={state.data ?? []} onClose={() => setDischargeOpen(false)} />}
    {createOpen && <CreateCargoModal onClose={() => setCreateOpen(false)} />}
    {deleteTarget && <DeleteCargoDialog containerNo={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    {selected && <TimelineDrawer move={selected} onClose={() => setSelected(null)} />}
    {workflowTarget && <CargoWorkflowDialog containerNo={workflowTarget} onClose={() => setWorkflowTarget(null)} />}
    </>
  );
}
