/**
 * Per-source Health Cards + Operator Banner (prompt §6, §10, D.2 sub-criterion 3).
 * Each card shows last good poll, error count, GREEN/AMBER/RED, and the active
 * mode badge (LIVE/CACHED/SYNTHETIC). On any AMBER/RED a prominent Operator
 * Banner appears so the room can see fallback engage (Addendum B.2).
 */
import { CalciteCard, CalciteChip, CalciteNotice, CalciteButton } from '@esri/calcite-components-react';
import type { IntegrationHealth } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { faultStore } from '../console/faultStore.js';
import { useFaultDep } from '../console/useFaultStore.js';

export function OperatorBanner({ health }: { health: IntegrationHealth[] }) {
  const degraded = health.filter((h) => h.degradation !== 'GREEN');
  if (degraded.length === 0) return null;
  const worst = degraded.some((h) => h.degradation === 'RED') ? 'danger' : 'warning';
  return (
    <CalciteNotice open kind={worst} icon="exclamation-mark-triangle" width="full">
      <div slot="title">Integration degradation — serving from fallback</div>
      <div slot="message">
        {degraded
          .map((h) => `${h.sourceSystem}: ${h.degradation} (${h.mode})`)
          .join(' · ')}
      </div>
    </CalciteNotice>
  );
}

function modeBadge(mode: IntegrationHealth['mode']) {
  return (
    <CalciteChip style={{ ['--calcite-chip-text-color' as never]: tokens.mode[mode] }} value={mode}>
      {mode}
    </CalciteChip>
  );
}

export function HealthCards() {
  const { adapter, lang } = useApp();
  // Refetch whenever the Integration Console injects/clears a fault, so the
  // cards + Operator Banner react live to a source degrading / going offline.
  const faultDep = useFaultDep();
  const state = useAsync<IntegrationHealth[]>(() => adapter.getIntegrationHealth(), [adapter, faultDep]);
  return (
    <Panel heading={t('panel_health', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(health) => (
        <>
          <OperatorBanner health={health} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Inject a source fault (DEGRADED / OFFLINE / kill) and watch fallback engage.
            </span>
            <CalciteButton scale="s" appearance="outline" iconStart="plug" style={{ marginLeft: 'auto' }} onClick={() => faultStore.setOpen(true)}>
              Integration Console
            </CalciteButton>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            {health.map((h) => (
              <CalciteCard key={h.sourceSystem} style={{ minWidth: 170 }}>
                <div slot="heading" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    aria-label={`status ${h.degradation}`}
                    style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: tokens.degradation[h.degradation], display: 'inline-block',
                    }}
                  />
                  {h.sourceSystem}
                </div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  Errors: {h.errorCount}
                  <br />
                  Last poll: {h.lastGoodPollTs ? new Date(h.lastGoodPollTs).toLocaleString() : '—'}
                </div>
                <div slot="footer-start">{modeBadge(h.mode)}</div>
              </CalciteCard>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
