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
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteButton, CalciteIcon, CalciteNotice,
  CalciteInput, CalciteLabel, CalciteLoader, CalciteList, CalciteListItem,
} from '@esri/calcite-components-react';
import type { OriginStream } from '@jnpa/schemas';
import { computeCheckDigit, isValidContainerNo } from '@jnpa/schemas';
//
// ORIGIN_STREAMS was also dropped: the Stream filter now builds its options from
// the loaded rows, because that enum is the simulator's taxonomy and does not
// match the values core.cargo actually stores. See the note on the select.
import type { CargoCreateInput, CargoCustomsStatus, CargoLifecycleEvent, ContainerMovementDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { customsFlagStore } from '../state/customsFlagStore.js';
import { CargoWorkflowDialog } from './CargoWorkflowDialog.js';
import { NldsTrackDialog } from './NldsTrackDialog.js';
import { Uc3HandoverDialog } from './Uc3HandoverDialog.js';
import { isHandedOver } from './uc3Handover.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { SOURCE_LABELS } from '../console/faultStore.js';
import {
  nextGate, gateUi, customsLifecycleConflict, customsActionsFor, CUSTOMS_ACTION_UI,
  EXPORT_STATES, type CargoGate, type VerifyKind,
} from './cargoGates.js';
import { scanSelectionFor } from './scanSelection.js';
import { useRmsSelection } from '../state/useRmsSelection.js';

/**
 * Is this container's verify gate a SCAN, or just the pre-release check?
 *
 * Only a filed RMS selection or an operator's flag orders a scan; everything else
 * passes VERIFIED as a custody gate with no examination behind it. Labelling the
 * latter "Record scan" claimed an examination that never happened.
 */
const verifyKindFor = (customsStatus: string | null | undefined,
  rmsSelected: ReadonlySet<string>, containerNo: string): VerifyKind => {
  const result = customsStatus === 'CLEARED' ? 'CLEAR'
    : customsStatus === 'HELD' ? 'HOLD'
      : customsStatus === 'UNDER_INSPECTION' ? 'EXAM' : undefined;
  return scanSelectionFor(result, rmsSelected.has(containerNo.trim().toUpperCase())).reason
    ? 'SCAN' : 'RELEASE_CHECK';
};

import { CargoGateDialog } from './CargoGateDialog.js';
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
  /**
   * RECORDED EVENTS ONLY — no "pending" steps.
   *
   * This previously appended every `CONTAINER_STATUSES` value after the trail's
   * furthest stage and labelled them "Pending". That enum is a flat union of every
   * path a box can take (`… RAIL_IN, RAIL_OUT, UNDER_SCAN, HELD_CUSTOMS, STUFFING,
   * DESTUFFING, ITRHO_IN_TRANSIT …`), not a sequence any single container follows,
   * so a road import box was shown as still-to-come RAIL_IN / STUFFING /
   * ITRHO_IN_TRANSIT — moves it will never make — and HELD_CUSTOMS, an exception
   * state rendered as a scheduled step.
   *
   * That is a forecast, and this drawer's contract (see the docstring above) is
   * that it fabricates nothing. The canonical per-leg step order now lives in
   * panels/LifecycleSteps.tsx, where each step carries its real provenance or its
   * documented reason for being absent.
   */
  const rows = trail.map((e, i) => ({
    key: `${e.eventType}-${e.ts}-${i}`,
    label: prettyEvent(e.eventType),
    status:
      FLAG_STATUS[e.eventType] ??
      (i === lastIdx
        ? { label: 'Current', color: tokens.color.brand }
        : { label: 'Done', color: tokens.congestion.GREEN }),
    ts: e.ts, facilityId: e.facilityId, sourceSystem: e.sourceSystem,
  }));
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
                        background: row.status.color,
                        border: `2px solid ${row.status.color}`,
                      }}
                      aria-hidden
                    />
                    {i < rows.length - 1 && <span style={{ width: 2, flex: 1, minHeight: 24, background: tokens.color.border }} aria-hidden />}
                  </div>
                  {/* Content: event name, status, timestamp, facility, source. */}
                  <div style={{ paddingBottom: 16, flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: tokens.color.text }}>{row.label}</strong>
                      <CalciteChip scale="s" value={row.status.label} style={{ ['--calcite-chip-text-color' as never]: row.status.color }}>
                        {row.status.label}
                      </CalciteChip>
                    </div>
                    <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 2 }}>
                      {new Date(row.ts).toLocaleString()}
                      {row.facilityId ? ` · ${row.facilityId}` : ''}
                      {row.sourceSystem ? ` · ${row.sourceSystem}` : ''}
                    </div>
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
 * The gate confirmation for one movement row, wrapping the shared
 * {@link CargoGateDialog}.
 *
 * It keeps the discharge report's context — vessel, ETA, yard, release state —
 * which is genuinely useful at the discharge gate, and passes it as `facts`. The
 * COARRI caveat rides along as the gate note: the source discharge document is
 * unavailable for JNPA calls, but the lifecycle transition itself is real, and
 * conflating those two is what made this dialog read as a no-op.
 */
function DischargeReportModal({ move, onClose }: { move: ContainerMovementDTO; onClose: () => void }) {
  const rec = move.cargo;
  const gate = gateOf(move) ?? 'discharge';
  const rms = useRmsSelection();
  const facts: Array<[string, string]> = [
    ['Container', move.container.containerNo],
    ['Vessel', rec?.vessel_name || '—'],
    ['ETA', rec?.eta ? new Date(rec.eta).toLocaleString() : '—'],
    ['Customs status', rec?.customs_status ?? '—'],
    ['Yard block', rec?.yard_block || 'Not yet assigned'],
    ['Release state', rec?.is_released ? 'Released' : 'In port'],
  ];
  return (
    <CargoGateDialog
      gate={gate}
      containerNo={move.container.containerNo}
      lifecycle={lifecycleOf(move)}
      yardBlock={rec?.yard_block}
      customsStatus={rec?.customs_status}
      verifyKind={verifyKindFor(rec?.customs_status, rms.selected, move.container.containerNo)}
      vesselName={rec?.vessel_name}
      facts={facts}
      note={gate === 'discharge' ? (
        <CalciteNotice open kind="warning" icon="information" scale="s">
          <div slot="title">COARRI discharge confirmation not available</div>
          <div slot="message">
            No COARRI discharge report exists for JNPA calls in this dataset, so the
            crane, bay and per-move detail cannot be shown. Confirming still records
            the real lifecycle transition — it does not invent the missing document.
          </div>
        </CalciteNotice>
      ) : undefined}
      onClose={onClose}
    />
  );
}

const PAGE_SIZE = 50;

const CUSTOMS_STATUSES: CargoCustomsStatus[] = ['PENDING', 'CLEARED', 'HELD', 'UNDER_INSPECTION'];


/** A row with no recorded status has not started the lifecycle — treat as CREATED. */
const lifecycleOf = (m: ContainerMovementDTO): string =>
  m.cargo?.lifecycle_status || 'CREATED';

/**
 * The next lifecycle gate for a row — discharge → yard → verify → release.
 *
 * Shared with the Scan tab (panels/cargoGates.ts) so the two panels cannot
 * disagree. They previously each had their own idea of what came next, which is
 * how a container verified in Scan ended up with no way to release it here.
 *
 * `inYard` is taken from the record's own yard block: a row whose block was
 * written directly still reads `CREATED` to the state machine, and its real next
 * step is to catch that up rather than to be discharged again. `direction` is read
 * because the export leg shares none of these gates.
 */
const gateOf = (m: ContainerMovementDTO): CargoGate | null =>
  nextGate(lifecycleOf(m), {
    inYard: Boolean(m.cargo?.yard_block),
    direction: m.cargo?.direction,
  });

/** Colour a lifecycle chip by how far along it is: start → mid → complete. */
function lifecycleColor(status: string): string {
  if (status === 'RELEASED' || status === 'VESSEL_LOADED') return tokens.congestion.GREEN;
  if (status === 'CREATED') return tokens.color.textMuted;
  return tokens.color.brand;
}

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
  /**
   * ISO-6346 check-digit gate (restored — it was bypassed for UC2↔UC3 manual
   * testing, which let phantom numbers like ABCD1234567 into the shared store).
   *
   * The 11th digit is a checksum over the first ten characters, so a single
   * mistyped character almost always fails it. Catching that HERE keeps bad
   * identities out of a store three PoCs read from — a phantom container number
   * is not a display bug, it is a row that can never be reconciled with any
   * manifest, gate document or customs record.
   */
  const cnValid = isValidContainerNo(cn);
  /**
   * The digit the number SHOULD have ended with, when the structure is right and
   * only the checksum is wrong. Telling the operator "check digit should be 8"
   * turns a rejection into a correction; "invalid container number" does not.
   * Null when the shape itself is wrong — there is no meaningful digit to suggest.
   */
  const expectedCheckDigit = (() => {
    if (cnValid || !/^[A-Z]{3}[UJZ][0-9]{7}$/.test(cn)) return null;
    try {
      return computeCheckDigit(cn.slice(0, 10));
    } catch {
      return null;
    }
  })();

  const submit = async () => {
    if (!adapter.createCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    if (!cnValid) {
      setError(cn.length === 0
        ? 'Enter a container number.'
        : expectedCheckDigit != null
          ? `${cn} fails the ISO-6346 check digit — it should end in ${expectedCheckDigit}.`
          : `${cn} is not a valid ISO-6346 container number (4 letters, the 4th being U, J or Z, then 7 digits).`);
      return;
    }
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
              {/* Inline, as you type — naming the digit turns a rejection into a
                  correction. Silent until something has actually been typed. */}
              {form.container_number.trim() !== '' && !cnValid && (
                <p style={{ fontSize: 11.5, color: tokens.severity.CRIT, margin: '-6px 0 6px' }}>
                  {expectedCheckDigit != null
                    ? <>ISO-6346 check digit fails — <code>{cn}</code> should end in <strong>{expectedCheckDigit}</strong>.</>
                    : <>Not an ISO-6346 number: 3 letters, then U / J / Z, then 7 digits (e.g. <code>MAEU6123458</code>).</>}
                </p>
              )}
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
  // Shared with the Scan tab: whether a scan was ever ordered for each container.
  const rms = useRmsSelection();
  const { adapter, role, lang } = useApp();
  const [stream, setStream] = useState<OriginStream | 'ALL'>('ALL');
  // Container whose lifecycle timeline is open in the slide-over (null = closed).
  const [selected, setSelected] = useState<ContainerMovementDTO | null>(null);
  // Container whose Discharge Report dialog is open (null = closed). Discharge is
  // a per-container milestone, so it is driven from that container's row rather
  // than from a single panel-level button.
  const [dischargeTarget, setDischargeTarget] = useState<ContainerMovementDTO | null>(null);
  // Create Cargo modal open state.
  const [createOpen, setCreateOpen] = useState(false);
  // Container pending a delete confirmation (null = no dialog).
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Container whose POC-3 workflow (trigger/approve/reject + history) is open.
  const [workflowTarget, setWorkflowTarget] = useState<string | null>(null);
  // Container whose NLDS/LDB inland-transit track dialog is open.
  const [trackTarget, setTrackTarget] = useState<string | null>(null);
  /** Released row whose UC-III handover is open (null = none). */
  const [handoverTarget, setHandoverTarget] = useState<ContainerMovementDTO | null>(null);
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
  // Server-side pagination. The register is ~11,900 rows, so the page must be
  // fetched rather than sliced: the old code asked for 100 and rendered the first
  // 50, which meant rows 51+ were fetched and thrown away and rows 101+ were
  // simply unreachable.
  const [pageIndex, setPageIndex] = useState(0);
  // Any filter change invalidates the current page — otherwise a narrower filter
  // leaves you stranded on a page that no longer exists, showing nothing.
  //
  // The `n === 0 ? n : 0` returns the SAME value when already on page 1, so React
  // bails out of the re-render and the fetch below is not fired twice. Only a real
  // reset (from page 2+) costs a refetch, which it has to.
  useEffect(() => {
    setPageIndex((n) => (n === 0 ? n : 0));
  }, [stream, customsStatus, released, searchApplied]);

  const page = useAsync<{ items: ContainerMovementDTO[]; total: number | null }>(
    () => {
      const filter = {
        role,
        limit: PAGE_SIZE,
        offset: pageIndex * PAGE_SIZE,
        ...(searchApplied ? { containerNo: searchApplied } : {}),
        ...(stream !== 'ALL' ? { originStream: stream } : {}),
        ...(customsStatus !== 'ALL' ? { customsStatus } : {}),
        ...(released !== 'ALL' ? { isReleased: released === 'RELEASED' } : {}),
      };
      return adapter.getContainerMovementsPage
        ? adapter.getContainerMovementsPage(filter)
        : adapter.getContainerMovements(filter).then((items) => ({ items, total: null }));
    },
    [adapter, role, stream, customsStatus, released, searchApplied, pageIndex, cargoRev],
  );
  // Adapt the paged result back to the shape <Panel> renders, so the loading and
  // error handling below are unchanged.
  const state = {
    ...page,
    data: page.data?.items,
  } as ReturnType<typeof useAsync<ContainerMovementDTO[]>>;
  const total = page.data?.total ?? null;
  // Paging maths. Without a total the API gave us no count, so we cannot know how
  // many pages there are — pageCount collapses to 1 and the controls hide rather
  // than guessing.
  const pageCount = total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const rangeFrom = pageIndex * PAGE_SIZE + 1;
  const rangeTo = pageIndex * PAGE_SIZE + (page.data?.items.length ?? 0);
  /**
   * Stream options taken from the DATA, not the enum — see the note on the select.
   *
   * Derived from the currently-loaded page, so it cannot offer a value that would
   * filter to nothing. Held across filter changes would be better still, but the
   * page is the only set we can see without a distinct-values endpoint.
   */
  const streamOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const m of page.data?.items ?? []) {
      const s = m.cargo?.origin_stream;
      if (s) seen.add(s);
    }
    return [...seen].sort();
  }, [page.data]);
  // Reflect the manual customs flag (customsFlagStore) so the Flag action visibly
  // transitions the container's Customs cell to a "Flagged" state. Raw snapshot
  // (not audience-scoped) so the operator who flagged always sees the transition.
  const flags = useSyncExternalStore(customsFlagStore.subscribe, customsFlagStore.getSnapshot, customsFlagStore.getSnapshot);
  const flaggedNos = useMemo(() => new Set(flags.map((f) => f.containerNo)), [flags]);

  /** Container whose customs write is in flight (null = none), so the row can spin. */
  const [customsBusy, setCustomsBusy] = useState<string | null>(null);
  const [customsError, setCustomsError] = useState<string | null>(null);

  /**
   * Record a customs disposition on the shared cargo record — for real.
   *
   * Writes `customs_status` via `PUT /api/cargo/{cn}`, so the decision survives a
   * reload and is visible to every other panel and to UC-III. Flagging also raises
   * the in-memory notification (that is what the Notifications centre reads), but
   * it is no longer the only effect: Flag used to push a client-side notification
   * that vanished on refresh.
   *
   * ⚠ This is the CUSTOMS track, and it is the ONLY place the UI writes it.
   * `POST /verify` deliberately leaves `customs_status` alone, so recording a scan
   * result never clears an examination — and the release gate refuses a container
   * customs is still examining. Before this took both directions, an operator
   * could flag a box, scan it, verify it, and then have no way to release it.
   *
   * ⚠ It is an OPERATOR act, not a filed document. These cargo rows share no
   * containers with `core.ooc_item`, so a CLEARED written here is backed by no
   * ICEGATE out-of-charge — which is why the customs badges label it SIMULATED
   * (customsEvidence.ts). The button copy must not claim otherwise.
   *
   * ⚠ Flagging does NOT by itself put the box in the Scan queue. That queue is
   * membership-by-yard ("not released AND yard-assigned AND not yet verified") —
   * customs_status is not part of its rule. A flagged container appears there once
   * it has a yard assignment.
   */
  const recordCustoms = async (m: ContainerMovementDTO, status: CargoCustomsStatus) => {
    const cn = m.container.containerNo;
    if (!adapter.updateCargo) { setCustomsError('Cargo write is unavailable in this data mode.'); return; }
    setCustomsBusy(cn);
    setCustomsError(null);
    try {
      await adapter.updateCargo(cn, { customs_status: status });
      // Only a NEW examination is notification-worthy; an out-of-charge is not a
      // flag, and pushing it into the flag store would relabel the row "Flagged".
      if (status === 'UNDER_INSPECTION') customsFlagStore.flagForCustoms(cn, m.facilityId);
      cargoRefreshStore.bump();
    } catch (e) {
      setCustomsError(`${cn}: ${cargoErrorMessage(e)}`);
    } finally {
      setCustomsBusy(null);
    }
  };

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
            {/* Discharge is now a per-container action on each row (Discharge
                column) rather than one panel-level button, since it is a
                milestone of an individual container, not of the whole list. */}
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
                  'Vessel Name': m.cargo?.vessel_name ?? '',
                  'ETA': m.cargo?.eta ?? '',
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
          {/* ⚠ The badge names POC-3 Cargo, NOT ICEGATE.
              These rows are `core.cargo` records. That set shares ZERO containers
              with `core.ooc_item` — the filed customs documents on the Customs and
              Scan tabs (00_Session_Context.md) — and the CLEARED customs_status
              values are seeded rather than derived from a filed out-of-charge. The
              old badge read "TOS · ICEGATE · FOIS · e-Seal", claiming ICEGATE as a
              source for rows no ICEGATE document backs. Per-event source systems
              are still shown in the Source column and the timeline. */}
          <div><SourceBadge source="POC-3 Cargo" live /></div>
          {customsError && (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ margin: '6px 0' }}>
              <div slot="title">Could not record the customs disposition</div>
              <div slot="message">{customsError}</div>
            </CalciteNotice>
          )}
          <CalciteNotice open kind="info" icon="information" scale="s" style={{ margin: '6px 0 4px' }}>
            <div slot="title">These are POC-3 cargo records, not filed customs documents</div>
            <div slot="message">
              This grid tracks the shared Cargo API. Its containers do not overlap the
              filed manifests, bills of entry or gate documents shown on the Customs,
              Scan and Gate tabs, so a customs status here is the cargo record&apos;s own
              field — not evidence of a granted out-of-charge. Use the Import tab to
              follow a container through its actual filed documents.
            </div>
          </CalciteNotice>
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
          {/* ⚠ The options come from the LOADED ROWS, not from the ORIGIN_STREAMS
              enum. That enum is the UC-2 simulator's taxonomy (IMPORT_CFS,
              EXPORT_DPE, …); `core.cargo.origin_stream` does not use it — it is
              NULL on 11,939 of 11,944 records and 'UC-II' on the rest. Offering the
              enum meant every option filtered to zero rows once the parameter was
              actually sent. Driving the list off the data keeps the control honest,
              and it grows on its own as the column gets populated. */}
          <CalciteSelect
            label="Stream filter"
            onCalciteSelectChange={(e) => setStream((e.target as unknown as { value: OriginStream | 'ALL' }).value)}
          >
            <CalciteOption value="ALL" selected={stream === 'ALL'}>All streams</CalciteOption>
            {streamOptions.map((s) => (
              <CalciteOption key={s} value={s} selected={stream === s}>{s}</CalciteOption>
            ))}
          </CalciteSelect>
          {streamOptions.length === 0 && (
            <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 0' }}>
              No container in this result set declares an origin stream —
              <code> origin_stream</code> is unset on the cargo records, so there is
              nothing to filter by. Use Customs status or Release state instead.
            </p>
          )}
          {/* The count is the FILTERED total from X-Total-Count, not the page
              length. `moves.length` alone read "100 containers" on every filter,
              because 100 is the default page size — which is exactly what made
              the filters look like they were doing nothing. */}
          {/* The count is the FILTERED total from X-Total-Count, not the page
              length. `moves.length` alone read "100 containers" on every filter,
              because 100 is the default page size — which is exactly what made
              the filters look like they were doing nothing. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '6px 0' }}>
            <p style={{ fontSize: 12, color: 'var(--calcite-color-text-3)', margin: 0 }}>
              {total !== null
                ? total === 0
                  ? 'No containers match the current filters'
                  : <>Showing <strong>{rangeFrom.toLocaleString()}–{rangeTo.toLocaleString()}</strong> of{' '}
                      <strong>{total.toLocaleString()}</strong> containers</>
                : <>{moves.length.toLocaleString()} container{moves.length === 1 ? '' : 's'}</>}
            </p>

            {/* Server-side paging: each click refetches with a new offset. Only
                rendered when there is more than one page. */}
            {pageCount > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                <CalciteButton
                  scale="s" appearance="outline" kind="neutral" iconStart="chevron-left"
                  disabled={pageIndex === 0 || page.loading}
                  onClick={() => setPageIndex((n) => Math.max(0, n - 1))}
                >
                  Previous
                </CalciteButton>
                <span style={{ fontSize: 12, color: tokens.color.textMuted, minWidth: 96, textAlign: 'center' }}>
                  Page {pageIndex + 1} of {pageCount.toLocaleString()}
                </span>
                <CalciteButton
                  scale="s" appearance="outline" kind="neutral" iconEnd="chevron-right"
                  disabled={pageIndex >= pageCount - 1 || page.loading}
                  onClick={() => setPageIndex((n) => n + 1)}
                >
                  Next
                </CalciteButton>
              </div>
            )}
          </div>
          <CalciteTable caption="container movements">
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Container" />
              <CalciteTableHeader heading="Stream" />
              <CalciteTableHeader heading="Line" />
              {/* Vessel + ETA come straight off the POC-3 cargo record. */}
              <CalciteTableHeader heading="Vessel" />
              <CalciteTableHeader heading="ETA" />
              <CalciteTableHeader heading="Last event" />
              <CalciteTableHeader heading="At" />
              <CalciteTableHeader heading="Source" />
              <CalciteTableHeader heading="Events" />
              <CalciteTableHeader heading="Customs" />
              {/* Action where discharge is legal, current state everywhere else. */}
              <CalciteTableHeader heading="Lifecycle" />
              <CalciteTableHeader heading="Manage" />
            </CalciteTableRow>
            {/* No client-side slice: the server already returned exactly this
                page (limit = PAGE_SIZE, offset = pageIndex * PAGE_SIZE). Slicing
                here again would silently hide rows the user paged to. */}
            {moves.map((m) => (
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
                <CalciteTableCell>{m.cargo?.vessel_name || '—'}</CalciteTableCell>
                <CalciteTableCell>
                  {m.cargo?.eta ? new Date(m.cargo.eta).toLocaleString() : '—'}
                </CalciteTableCell>
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
                  {/* Conditional on the customs disposition, not on a session flag.
                      This used to show a Flag button on EVERY row — including
                      released ones, which have left the port and cannot be scanned —
                      and clicking it only raised an in-memory notification that
                      vanished on reload. It now writes customs_status for real. */}
                  {(() => {
                    const cs = m.cargo?.customs_status ?? 'PENDING';
                    const released = m.cargo?.is_released || lifecycleOf(m) === 'RELEASED';
                    const sessionFlagged = flaggedNos.has(m.container.containerNo);

                    // Gone from the port — the customs outcome is history, not an
                    // action. UNLESS the two tracks contradict each other, in which
                    // case greying it out would present an impossible record as a
                    // settled one.
                    if (released) {
                      const clash = customsLifecycleConflict(cs, lifecycleOf(m));
                      return (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <CalciteChip scale="s" value={cs}
                            title={clash ? clash.message
                              : 'Container has left the port — its customs disposition is final.'}
                            style={{ ['--calcite-chip-text-color' as never]:
                              clash ? tokens.severity.CRIT : tokens.color.textMuted }}>
                            {cs}
                          </CalciteChip>
                          {clash && (
                            <CalciteIcon icon="exclamation-mark-triangle" scale="s"
                              title={clash.message}
                              style={{ color: tokens.severity.CRIT }} />
                          )}
                        </span>
                      );
                    }
                    // Nothing recorded yet — the bare Flag button, as before.
                    if (cs === 'PENDING' && !sessionFlagged) {
                      return (
                        <CalciteButton
                          scale="s"
                          appearance="outline"
                          kind="danger"
                          iconStart="flag"
                          loading={customsBusy === m.container.containerNo}
                          disabled={customsBusy !== null}
                          title="Flag for a customs scan — sets customs_status to UNDER_INSPECTION on the shared record"
                          onClick={() => void recordCustoms(m, 'UNDER_INSPECTION')}
                        >
                          Flag
                        </CalciteButton>
                      );
                    }
                    // Carrying a disposition. Still a CONTROL, not a label: an
                    // examination or a hold BLOCKS release on the server, so the
                    // cell that put the container there must be able to record the
                    // outcome that takes it back out. This used to degrade to an
                    // inert chip whose tooltip sent the operator to the Scan step —
                    // which calls POST /verify and cannot write customs_status at
                    // all, so the box stayed flagged and unreleasable forever.
                    const label = cs === 'UNDER_INSPECTION' ? 'Flagged' : cs;
                    const color = cs === 'CLEARED' ? tokens.kpi.better
                      : cs === 'HELD' ? tokens.severity.CRIT : tokens.congestion.AMBER;
                    const blocking = cs === 'UNDER_INSPECTION' || cs === 'HELD';
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                        <CalciteChip scale="s" icon={cs === 'CLEARED' ? 'check' : 'flag'} value={label}
                          title={blocking
                            ? `Customs ${cs === 'HELD' ? 'is holding' : 'is examining'} these goods — the port `
                              + 'will refuse to release this container until an out-of-charge is recorded.'
                            : cs === 'CLEARED'
                              ? 'Customs cleared (an out-of-charge sets this).'
                              : `Customs status: ${cs}`}
                          style={{ ['--calcite-chip-text-color' as never]: color }}>
                          {label}
                        </CalciteChip>
                        {customsActionsFor(cs, { released }).map((action) => {
                          const a = CUSTOMS_ACTION_UI[action];
                          return (
                            <CalciteButton key={action} scale="s" appearance="outline" kind={a.kind}
                              iconStart={a.icon} title={a.title}
                              loading={customsBusy === m.container.containerNo}
                              disabled={customsBusy !== null}
                              onClick={() => void recordCustoms(m, a.status)}>
                              {a.label}
                            </CalciteButton>
                          );
                        })}
                      </span>
                    );
                  })()}
                </CalciteTableCell>
                <CalciteTableCell>
                  {/* The NEXT GATE, not a fixed action. The lifecycle is
                      forward-only with mandatory gates, so offering a move the
                      container is not eligible for produced a 409 the operator
                      read as a failure. Shared with the Scan tab via cargoGates.
                      A released or export row has no gate and shows its state. */}
                  {(() => {
                    const gate = gateOf(m);
                    if (gate && gate !== 'done') {
                      // The button must say which check it is: on a facilitated box
                      // the verify gate is a pre-release check, not a scan.
                      const ui = gateUi(gate, verifyKindFor(
                        m.cargo?.customs_status, rms.selected, m.container.containerNo));
                      return (
                        <CalciteButton
                          scale="s"
                          appearance="outline"
                          kind="brand"
                          iconStart={ui.icon}
                          title={`${ui.title} — currently ${lifecycleOf(m)}`}
                          onClick={() => setDischargeTarget(m)}
                        >
                          {ui.label}
                        </CalciteButton>
                      );
                    }
                    const st = lifecycleOf(m);
                    const dir = (m.cargo?.direction ?? '').toUpperCase();
                    // Released is the END of this lifecycle, not a missing gate. The
                    // chip used to say so only in a tooltip, so the container's story
                    // stopped dead at the last step of the demo: no trace that
                    // cargo.released fired or what it carried. Make it openable.
                    if (isHandedOver(m.cargo) && !EXPORT_STATES.includes(st) && dir !== 'EXPORT') {
                      return (
                        <CalciteButton
                          scale="s"
                          appearance="outline"
                          kind="neutral"
                          iconStart="hand-point-right"
                          title="Released — see what UC-2 handed to UC-III, and who owns the truck leg"
                          onClick={() => setHandoverTarget(m)}
                        >
                          Handed to UC-III
                        </CalciteButton>
                      );
                    }
                    // No gate applies: either the export leg (different machine) or
                    // already released. Say which, so an absent button reads as a
                    // reason rather than a gap.
                    const why = dir === 'EXPORT' || EXPORT_STATES.includes(st)
                      ? 'Export container — it runs the export states (EXPORT_BOOKED → … → VESSEL_LOADED), not the import gates.'
                      : 'Released — the import lifecycle is complete and handed over to UC-III.';
                    return (
                      <CalciteChip
                        scale="s"
                        value={st}
                        title={`${st}\n\n${why}`}
                        style={{ ['--calcite-chip-text-color' as never]: lifecycleColor(st) }}
                      >
                        {st.replace(/_/g, ' ')}
                      </CalciteChip>
                    );
                  })()}
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
                    {/* NLDS Logistics Data Bank inland-transit track (public LDB API). */}
                    <CalciteButton
                      scale="s"
                      appearance="outline"
                      kind="brand"
                      iconStart="pin-tear"
                      title="Track this container on NLDS / LDB (inland transit timeline)"
                      onClick={() => setTrackTarget(m.container.containerNo)}
                    >
                      Track
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
    {dischargeTarget && <DischargeReportModal move={dischargeTarget} onClose={() => setDischargeTarget(null)} />}
    {createOpen && <CreateCargoModal onClose={() => setCreateOpen(false)} />}
    {deleteTarget && <DeleteCargoDialog containerNo={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    {selected && <TimelineDrawer move={selected} onClose={() => setSelected(null)} />}
    {workflowTarget && <CargoWorkflowDialog containerNo={workflowTarget} onClose={() => setWorkflowTarget(null)} />}
    {trackTarget && <NldsTrackDialog containerNo={trackTarget} onClose={() => setTrackTarget(null)} />}
    {handoverTarget && (
      <Uc3HandoverDialog
        containerNo={handoverTarget.container.containerNo}
        cargo={handoverTarget.cargo}
        onClose={() => setHandoverTarget(null)}
      />
    )}
    </>
  );
}
