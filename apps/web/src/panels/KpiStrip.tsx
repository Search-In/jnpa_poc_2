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
          {arrow} {Math.abs(kpi.improvementPct)}%{positive ? ` ${t('improvement', lang)}` : ''}
        </span>
      </div>
      <div slot="footer-start" style={{ fontSize: 11, color: tokens.color.textMuted }}>
        {t('baseline', lang)}: {kpi.baseline} {kpi.unit}
      </div>
    </CalciteCard>
  );
}

/** Branch codes are stored as ORIGIN_STREAM enums; render them as prose. */
const BRANCH_LABEL: Record<string, string> = {
  IMPORT_CFS: 'Import · CFS',
  IMPORT_ICD: 'Import · ICD',
  IMPORT_DPD: 'Import · DPD',
  EXPORT_CFS: 'Export · CFS',
  EXPORT_ICD: 'Export · ICD',
  EXPORT_DPE: 'Export · DPE',
  TRANSSHIP: 'Transshipment',
  UNKNOWN: 'Unattributed',
};

/**
 * Container dwell in its spec-mandated form (WS4 KPI #9): **median + P90 per
 * branch, never a bare mean**. Rendered as its own block rather than a rollup
 * chip, because a chip can only carry one number — and one number is exactly the
 * form the spec rules out. P90 is the point of the KPI: it is where the
 * customs-held and DO-less boxes show up, which the median hides.
 */
function DwellBlock({ kpi }: { kpi: KpiResult }) {
  const d = kpi.distribution;
  if (!d) return null;
  const cell: React.CSSProperties = { padding: '3px 10px 3px 0', fontVariantNumeric: 'tabular-nums' };
  return (
    <div
      data-kpi={kpi.key}
      style={{
        flexBasis: '100%', marginTop: 4, padding: '10px 12px',
        background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>{kpi.label}</strong>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          all branches — median <strong style={{ color: tokens.color.text }}>{d.median} h</strong>
          {' · '}P90 <strong style={{ color: tokens.color.text }}>{d.p90} h</strong>
          {' · '}n={d.count}
        </span>
      </div>
      {d.byBranch.length > 0 && (
        <table style={{ marginTop: 8, borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: tokens.color.textMuted, textAlign: 'left' }}>
              <th style={cell}>Branch</th><th style={cell}>Median</th><th style={cell}>P90</th><th style={cell}>Containers</th>
            </tr>
          </thead>
          <tbody>
            {d.byBranch.map((b) => (
              <tr key={b.branch}>
                <td style={cell}>{BRANCH_LABEL[b.branch] ?? b.branch}</td>
                <td style={cell}>{b.median} h</td>
                {/* The actionable end — the long tail the median hides. */}
                <td style={{ ...cell, fontWeight: 700, color: tokens.color.text }}>{b.p90} h</td>
                <td style={{ ...cell, color: tokens.color.textMuted }}>{b.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
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
          {/* Dwell is excluded from the chip row on purpose — see DwellBlock. */}
          {kpis.slice(7).filter((k) => k.key !== 'containerDwell').map((k) => (
            <CalciteChip key={k.key} kind="neutral" value={k.key} data-kpi={k.key}>
              {k.label}: {k.value} {k.unit}
            </CalciteChip>
          ))}
          {kpis.filter((k) => k.key === 'containerDwell').map((k) => (
            <DwellBlock key={k.key} kpi={k} />
          ))}
        </div>
      )}
    </Panel>
  );
}
