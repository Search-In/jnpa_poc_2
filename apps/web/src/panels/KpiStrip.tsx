/**
 * KPI strip (prompt §10) — the seven KPIs (+ rollups) with baseline + signed
 * improvement %. Positive improvement is green, negative red (direction already
 * normalised by the engine).
 */
import { CalciteCard, CalciteChip } from '@esri/calcite-components-react';
import type { KpiResult } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimStore } from '../sim/useSimStore.js';

function KpiCard({ kpi }: { kpi: KpiResult }) {
  const { lang } = useApp();
  const positive = kpi.improvementPct >= 0;
  const color = positive ? tokens.kpi.better : tokens.kpi.worse;
  const arrow = positive ? '▲' : '▼';
  return (
    <CalciteCard style={{ minWidth: 180 }} data-kpi={kpi.key}>
      <div slot="heading" style={{ fontSize: 13, color: tokens.color.textMuted }}>{kpi.label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: tokens.color.text }}>
        {kpi.value}
        <span style={{ fontSize: 13, color: tokens.color.textMuted }}> {kpi.unit}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <span style={{ color, fontWeight: 600 }}>
          {arrow} {Math.abs(kpi.improvementPct)}% {t('improvement', lang)}
        </span>
      </div>
      <div slot="footer-start" style={{ fontSize: 11, color: tokens.color.textMuted }}>
        {t('baseline', lang)}: {kpi.baseline} {kpi.unit}
      </div>
    </CalciteCard>
  );
}

export function KpiStrip() {
  const { adapter, lang } = useApp();
  // Refetch when the simulator advances (tick) or its levers change, so the
  // headline KPIs move with the rest of the dashboard. The override signature
  // catches manual changes even while the clock is paused.
  const sim = useSimStore();
  const simSig = JSON.stringify([sim.gates, sim.pendency, sim.rail, sim.movementRate, sim.scanQueue]);
  const state = useAsync<KpiResult[]>(() => adapter.getKPIs(), [adapter, sim.tick, simSig]);
  // The seven primary KPIs are first; show them prominently, rollups after.
  return (
    <Panel heading={t('panel_kpis', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(kpis) => (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {kpis.slice(0, 7).map((k) => (
            <KpiCard key={k.key} kpi={k} />
          ))}
          <div style={{ flexBasis: '100%' }} />
          {kpis.slice(7).map((k) => (
            <CalciteChip key={k.key} kind="neutral" value={k.key} data-kpi={k.key}>
              {k.label}: {k.value} {k.unit}
            </CalciteChip>
          ))}
        </div>
      )}
    </Panel>
  );
}
