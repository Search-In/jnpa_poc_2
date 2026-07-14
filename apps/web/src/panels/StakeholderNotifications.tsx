/**
 * StakeholderNotifications — the POC-3 Stakeholder Notification + Cargo Lifecycle
 * Event integration (Jayesh handover), rendered as an additive section inside the
 * existing Notifications centre. It backs UC-II intended-use #2 ("automated
 * notification on events … to associated stakeholders") with the real backend:
 *
 *   GET  /api/cargo/notifications  → live stakeholder notifications
 *   POST /api/cargo/notifications  → raise a stakeholder notification
 *   GET  /api/cargo/events         → cargo lifecycle event feed (created, gate_in,
 *                                     gate_out, released, customs_status_changed, …)
 *
 * POC-3 owns the notification/event business logic; this is a thin consumer. It is
 * purely additive — the existing simulator-derived + manual-flag notification list
 * above it is untouched. Degrades gracefully (a notice, never a crash) when the
 * Cargo API is not the active data source (mock/sim mode).
 */
import { useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteInput, CalciteLabel, CalciteNotice, CalciteOption,
  CalciteSelect, CalciteList, CalciteListItem, CalciteLoader,
} from '@esri/calcite-components-react';
import { ROLES } from '@jnpa/schemas';
import type { CargoLifecycleEvent, CargoNotification, CargoNotificationSeverity } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { tokens } from '../theme/tokens.js';

const SEVERITIES: CargoNotificationSeverity[] = ['INFO', 'WARN', 'CRIT'];
const sevColor = (s?: string | null) =>
  s === 'CRIT' ? tokens.severity.CRIT : s === 'WARN' ? tokens.severity.WARN : tokens.severity.INFO;

const sectionHead: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: tokens.color.textMuted,
  textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px',
};

/** Compact composer that POSTs a stakeholder notification to POC-3. */
function Composer({ onSent }: { onSent: () => void }) {
  const { adapter } = useApp();
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<CargoNotificationSeverity>('INFO');
  const [containerNo, setContainerNo] = useState('');
  const [stakeholders, setStakeholders] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const toggle = (r: string) =>
    setStakeholders((s) => {
      const next = new Set(s);
      if (next.has(r)) next.delete(r); else next.add(r);
      return next;
    });

  const send = async () => {
    if (!adapter.createCargoNotification) { setError('The notification API is unavailable in this data mode.'); return; }
    if (!message.trim()) { setError('Enter a notification message.'); return; }
    setBusy(true);
    setError(null);
    try {
      await adapter.createCargoNotification({
        message: message.trim(),
        severity,
        ...(stakeholders.size ? { stakeholders: [...stakeholders] } : {}),
        ...(containerNo.trim() ? { container_number: containerNo.trim().toUpperCase().replace(/\s+/g, '') } : {}),
      });
      setDone(true);
      setMessage('');
      setContainerNo('');
      setStakeholders(new Set());
      cargoRefreshStore.bump();
      onSent();
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: '10px 12px', background: tokens.color.bgElevated }}>
      <CalciteLabel scale="s">Message
        <CalciteInput scale="s" value={message} placeholder="e.g. Gate queue building at BMCT — divert trailers"
          onCalciteInputInput={(e) => { setDone(false); setMessage((e.target as unknown as { value: string }).value); }} />
      </CalciteLabel>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 140 }}>Severity
          <CalciteSelect label="Severity" scale="s" onCalciteSelectChange={(e) => setSeverity((e.target as unknown as { value: CargoNotificationSeverity }).value)}>
            {SEVERITIES.map((s) => <CalciteOption key={s} value={s} selected={s === severity}>{s}</CalciteOption>)}
          </CalciteSelect>
        </CalciteLabel>
        <CalciteLabel scale="s" style={{ flex: 1, minWidth: 160 }}>Container (optional)
          <CalciteInput scale="s" value={containerNo} placeholder="MAEU6123458"
            onCalciteInputInput={(e) => setContainerNo((e.target as unknown as { value: string }).value)} />
        </CalciteLabel>
      </div>
      <div style={{ margin: '4px 0 2px', fontSize: 11, color: tokens.color.textMuted }}>Stakeholders</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ROLES.map((r) => (
          <CalciteChip
            key={r}
            scale="s"
            value={r}
            appearance={stakeholders.has(r) ? 'solid' : 'outline'}
            kind={stakeholders.has(r) ? 'brand' : 'neutral'}
            style={{ cursor: 'pointer' }}
            onClick={() => toggle(r)}
          >
            {r}
          </CalciteChip>
        ))}
      </div>
      {error && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 8 }}>
          <div slot="message">{error}</div>
        </CalciteNotice>
      )}
      {done && !error && (
        <CalciteNotice open kind="success" icon="check-circle" scale="s" style={{ marginTop: 8 }}>
          <div slot="message">Stakeholder notification raised.</div>
        </CalciteNotice>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <CalciteButton scale="s" iconStart="send" loading={busy} disabled={busy} onClick={send}>Notify stakeholders</CalciteButton>
      </div>
    </div>
  );
}

export function StakeholderNotifications() {
  const { adapter } = useApp();
  const cargoRev = useCargoRefresh();
  const available = Boolean(adapter.getCargoNotifications || adapter.getCargoEvents || adapter.createCargoNotification);

  const notifs = useAsync<CargoNotification[]>(
    () => (adapter.getCargoNotifications ? adapter.getCargoNotifications({ limit: 50 }) : Promise.resolve([])),
    [adapter, cargoRev],
  );
  const events = useAsync<CargoLifecycleEvent[]>(
    () => (adapter.getCargoEvents ? adapter.getCargoEvents() : Promise.resolve([])),
    [adapter, cargoRev],
  );

  if (!available) return null;

  return (
    <div style={{ marginTop: 16, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>Stakeholder Notifications</strong>
        <CalciteChip scale="s" value="poc3" kind="brand">POC-3 · live</CalciteChip>
      </div>

      <div style={sectionHead}>Raise a notification</div>
      <Composer onSent={() => { void notifs; }} />

      <div style={sectionHead}>Recent stakeholder notifications</div>
      {notifs.loading ? (
        <CalciteLoader scale="s" label="Loading notifications" />
      ) : notifs.error ? (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="message">{cargoErrorMessage(notifs.error)}</div>
        </CalciteNotice>
      ) : (notifs.data?.length ?? 0) === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '2px 0' }}>No stakeholder notifications yet.</p>
      ) : (
        <CalciteList label="stakeholder notifications">
          {notifs.data!.map((n, i) => (
            <CalciteListItem
              key={n.id ?? i}
              label={n.message ?? n.title ?? '(no message)'}
              description={[
                n.type,
                n.container_number,
                n.status,
                Array.isArray(n.stakeholders) ? n.stakeholders.join(', ') : undefined,
                n.created_at ? new Date(n.created_at).toLocaleString() : undefined,
              ].filter(Boolean).join(' · ')}
            >
              {n.severity && (
                <CalciteChip slot="content-end" scale="s" value={n.severity} style={{ ['--calcite-chip-text-color' as never]: sevColor(n.severity) }}>
                  {n.severity}
                </CalciteChip>
              )}
            </CalciteListItem>
          ))}
        </CalciteList>
      )}

      <div style={sectionHead}>Cargo lifecycle events</div>
      {events.loading ? (
        <CalciteLoader scale="s" label="Loading events" />
      ) : events.error ? (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="message">{cargoErrorMessage(events.error)}</div>
        </CalciteNotice>
      ) : (events.data?.length ?? 0) === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '2px 0' }}>No cargo events yet.</p>
      ) : (
        <CalciteList label="cargo events">
          {events.data!.slice(0, 30).map((ev, i) => (
            <CalciteListItem
              key={ev.id ?? i}
              label={ev.event_type ?? 'event'}
              description={[
                ev.container_number,
                ev.created_at ? new Date(ev.created_at).toLocaleString() : undefined,
              ].filter(Boolean).join(' · ')}
            />
          ))}
        </CalciteList>
      )}
    </div>
  );
}
