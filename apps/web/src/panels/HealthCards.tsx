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

/**
 * WHO produced this card (UC2-040) — a real connector, or the browser simulator.
 *
 * Separate from the mode badge on purpose. `mode` is which tier of the
 * connector's own fallback chain is serving; this is whether a connector spoke
 * at all. `mode: SYNTHETIC, source: CONNECTOR` is a real service honestly
 * reporting simulated data, and that is a different claim from a card the
 * browser invented — which is the confusion this ticket exists to end.
 */
function sourceBadge(h: IntegrationHealth) {
  const live = h.source === 'CONNECTOR';
  return (
    <span
      title={live
        ? 'This card came from the connector service’s own /health endpoint.'
        : h.fallbackReason ?? 'No connector answered; this card is simulated in the browser.'}
      style={{
        fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4,
        padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap',
        border: `1px solid ${live ? tokens.degradation.GREEN : tokens.color.border}`,
        color: live ? tokens.degradation.GREEN : tokens.color.textMuted,
      }}
    >
      {live ? 'connector' : 'simulated'}
    </span>
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
              {health.some((h) => h.source === 'CONNECTOR')
                ? 'Faults are injected into the real connector services (POST /inject-fault). Stop a container and its card flips to simulated.'
                : 'No connector service answered, so these cards and the fault console are simulated in the browser. Start the connectors to drive the real ones.'}
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
                  {/* WHICH upstream served this tier (UC2-041). `mode: LIVE` on
                      its own became ambiguous the moment the connectors gained a
                      live tier that answers — it can mean the source was
                      onboarded, or that the connector read the ingested corpus
                      from POC-3. Those are very different claims to make. */}
                  {h.upstream && (
                    <>
                      <br />
                      <span style={{ opacity: 0.9 }}>via {h.upstream}</span>
                    </>
                  )}
                  {/* The reason, which the connector has always produced and
                      nothing ever rendered: how stale the cache is, or which
                      credential is missing. It is the most useful line on a
                      degraded card. */}
                  {h.note && (
                    <div style={{ marginTop: 4, lineHeight: 1.35, opacity: 0.9 }}>{h.note}</div>
                  )}
                </div>
                <div slot="footer-start" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {modeBadge(h.mode)}
                  {sourceBadge(h)}
                </div>
              </CalciteCard>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
