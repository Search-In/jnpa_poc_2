/**
 * Notifications centre (prompt §10, §11) — role-filtered, multilingual body
 * (en/hi/mr selected by current UI language), severity-coloured, with an ack
 * workflow (ack tracked locally; the live service persists ackBy/ackTs).
 */
import { useState } from 'react';
import { CalciteList, CalciteListItem, CalciteButton, CalciteChip } from '@esri/calcite-components-react';
import type { Notification } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { SourceBadge } from './SourceBadge.js';
import { StakeholderNotifications } from './StakeholderNotifications.js';
import { useCustomsFlags } from '../state/customsFlagStore.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';

export function Notifications() {
  const { adapter, role, lang } = useApp();
  const state = useAsync<Notification[]>(() => adapter.getNotifications(role), [adapter, role]);
  // Manually-raised customs-scan flags (Container Movements tab) shown alongside
  // the simulator-derived notifications; subscribing keeps the list live.
  const manualFlags = useCustomsFlags(role);
  const [acked, setAcked] = useState<Set<string>>(new Set());

  return (
    <>
    <Panel heading={t('panel_notifications', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(notifs) => (
        <>
        <div><SourceBadge source="TOS · ICEGATE · e-Seal" /></div>
        <CalciteList label="notifications">
          {[...manualFlags, ...notifs].map((n) => (
            <CalciteListItem
              key={n.notifId}
              label={n.body[lang]}
              description={`${n.type}${n.containerNo ? ` · ${n.containerNo}` : ''} · ${new Date(n.createdTs).toLocaleString()}`}
            >
              <CalciteChip
                slot="content-end"
                value={n.severity}
                style={{ ['--calcite-chip-text-color' as never]: tokens.severity[n.severity] }}
              >
                {n.severity}
              </CalciteChip>
              {acked.has(n.notifId) ? (
                <CalciteChip slot="actions-end" kind="brand" value="acked" icon="check">
                  acked
                </CalciteChip>
              ) : (
                <CalciteButton
                  slot="actions-end"
                  scale="s"
                  appearance="outline"
                  onClick={() => setAcked((s) => new Set(s).add(n.notifId))}
                >
                  {t('ack', lang)}
                </CalciteButton>
              )}
            </CalciteListItem>
          ))}
        </CalciteList>
        </>
      )}
    </Panel>
    {/* Additive: POC-3 stakeholder notifications + cargo lifecycle events (Jayesh
        handover). Rendered as a sibling so it stays visible regardless of the
        simulator-derived list's empty state; that list above is unchanged. */}
    <div style={{ padding: '0 12px 12px' }}>
      <StakeholderNotifications />
    </div>
    </>
  );
}
