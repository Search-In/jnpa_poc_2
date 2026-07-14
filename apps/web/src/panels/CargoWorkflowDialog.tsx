/**
 * CargoWorkflowDialog — per-container automated-workflow control backed by the
 * POC-3 Cargo Workflow APIs (Jayesh handover):
 *   POST /api/cargo/{container_number}/workflow          → Trigger / Approve / Reject
 *   GET  /api/cargo/{container_number}/workflow/history  → append-only audit trail
 *
 * UC-II asks for "automated workflows & notifications" on the shared cargo
 * platform; this is the human-in-the-loop side of that for a single box. POC-3
 * owns all workflow business logic — this dialog is a thin, faithful consumer:
 * it renders the backend's append-only history and posts the three transitions.
 * Reuses the app's role="dialog" overlay + CalciteNotice pattern (see the Vessel
 * Discharge / Release dialogs) and bumps cargoRefreshStore on success so the
 * Movements grid refetches through the existing adapter flow. Purely additive —
 * no existing CRUD/timeline/CRUD behaviour changes.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteInput, CalciteNotice, CalciteLoader,
} from '@esri/calcite-components-react';
import type { CargoWorkflowAction, CargoWorkflowHistoryEntry } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { cargoRefreshStore } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { tokens } from '../theme/tokens.js';

const ACTION_LABEL: Record<CargoWorkflowAction, string> = {
  TRIGGER: 'Trigger',
  APPROVE: 'Approve',
  REJECT: 'Reject',
};

/** Colour a workflow status/action chip from tokens only. */
function statusColor(status?: string | null): string {
  const s = (status ?? '').toUpperCase();
  if (s.includes('REJECT') || s.includes('FAIL') || s.includes('HOLD')) return tokens.severity.CRIT;
  if (s.includes('PEND') || s.includes('AWAIT') || s.includes('TRIGGER')) return tokens.degradation.AMBER;
  if (s.includes('APPROV') || s.includes('DONE') || s.includes('COMPLETE')) return tokens.kpi.better;
  return tokens.color.textMuted;
}

export function CargoWorkflowDialog({ containerNo, onClose }: { containerNo: string; onClose: () => void }) {
  const { adapter } = useApp();
  const [history, setHistory] = useState<CargoWorkflowHistoryEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CargoWorkflowAction | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Success confirmation shown after a workflow transition actually succeeds (UX only).
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!adapter.getCargoWorkflowHistory) {
      setLoadError('The workflow API is unavailable in this data mode.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await adapter.getCargoWorkflowHistory(containerNo);
      setHistory(rows);
      // Latest entry's status is the current workflow state (append-only history).
      setStatus(rows.length ? (rows[rows.length - 1]!.status ?? null) : null);
    } catch (e) {
      setLoadError(cargoErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [adapter, containerNo]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: CargoWorkflowAction) => {
    if (!adapter.triggerCargoWorkflow) {
      setError('The workflow API is unavailable in this data mode.');
      return;
    }
    setBusy(action);
    setError(null);
    setSuccess(null);
    try {
      const state = await adapter.triggerCargoWorkflow(containerNo, {
        action,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (state?.status != null) setStatus(state.status);
      setNote('');
      await load(); // refresh the append-only history from POC-3
      cargoRefreshStore.bump(); // dependent panels refetch through the existing flow
      // Success confirmation (shown only after the API actually succeeds).
      setSuccess(
        action === 'TRIGGER' ? 'Workflow started successfully.'
        : action === 'APPROVE' ? 'Workflow approved successfully.'
        : 'Workflow rejected successfully.',
      );
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Workflow for ${containerNo}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="workflow" scale="s" />
          <strong style={{ fontSize: 14 }}>Workflow · {containerNo}</strong>
          {status && (
            <CalciteChip scale="s" value={status} style={{ marginLeft: 'auto', ['--calcite-chip-text-color' as never]: statusColor(status) }}>
              {status}
            </CalciteChip>
          )}
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: status ? 0 : 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto', flex: 1 }}>
          {loadError ? (
            <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Workflow unavailable</div>
              <div slot="message">{loadError}</div>
            </CalciteNotice>
          ) : (
            <>
              {/* Transition controls — Trigger / Approve / Reject → POST workflow. */}
              <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 6px' }}>
                Actions
              </div>
              <CalciteInput
                scale="s"
                placeholder="Optional note recorded on the transition"
                value={note}
                onCalciteInputInput={(e) => setNote((e.target as unknown as { value: string }).value)}
                style={{ marginBottom: 8 }}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <CalciteButton scale="s" iconStart="play" loading={busy === 'TRIGGER'} disabled={busy != null} onClick={() => act('TRIGGER')}>
                  {ACTION_LABEL.TRIGGER}
                </CalciteButton>
                <CalciteButton scale="s" kind="brand" iconStart="check" loading={busy === 'APPROVE'} disabled={busy != null} onClick={() => act('APPROVE')}>
                  {ACTION_LABEL.APPROVE}
                </CalciteButton>
                <CalciteButton scale="s" kind="danger" appearance="outline" iconStart="x" loading={busy === 'REJECT'} disabled={busy != null} onClick={() => act('REJECT')}>
                  {ACTION_LABEL.REJECT}
                </CalciteButton>
              </div>
              {error && (
                <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
                  <div slot="title">Action failed</div>
                  <div slot="message">{error}</div>
                </CalciteNotice>
              )}
              {success && !error && (
                <SuccessNotice
                  title={success}
                  details={[{ label: 'Container', value: containerNo }]}
                  closable
                  onClose={() => setSuccess(null)}
                  style={{ marginTop: 10 }}
                />
              )}

              {/* Append-only history — GET workflow/history. */}
              <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '16px 0 6px' }}>
                History
              </div>
              {loading ? (
                <CalciteLoader label="Loading history" scale="s" />
              ) : history.length === 0 ? (
                <CalciteNotice open kind="info" icon="information" scale="s">
                  <div slot="title">No workflow history</div>
                  <div slot="message">No workflow transitions have been recorded for this container yet. Trigger one above.</div>
                </CalciteNotice>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {history.map((h, i) => (
                    <div
                      key={h.id ?? i}
                      style={{ padding: '8px 10px', border: `1px solid ${tokens.color.border}`, borderRadius: 8, background: tokens.color.bgElevated }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {h.action && (
                          <CalciteChip scale="s" value={h.action} style={{ ['--calcite-chip-text-color' as never]: statusColor(h.action) }}>
                            {h.action}
                          </CalciteChip>
                        )}
                        {h.status && (
                          <span style={{ fontSize: 12, fontWeight: 600, color: statusColor(h.status) }}>{h.status}</span>
                        )}
                        {h.created_at && (
                          <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.color.textMuted }}>
                            {new Date(h.created_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {(h.actor || h.note) && (
                        <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 4 }}>
                          {h.actor ? <strong style={{ color: tokens.color.text }}>{h.actor}</strong> : null}
                          {h.actor && h.note ? ' · ' : ''}
                          {h.note ?? ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
