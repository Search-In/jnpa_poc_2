/**
 * What-if scenario panel (prompt §10, §12). Runs CGO-1/2/3 + lane-assignment,
 * shows the before/after KPI delta and the automated action(s) fired (incl. the
 * CGO-2 cross-twin push to UC3). Deterministic — same scenario, same result.
 */
import { useState } from 'react';
import {
  CalciteButton, CalciteCard, CalciteChip, CalciteNotice,
} from '@esri/calcite-components-react';
import type { ScenarioResultDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';

const SCENARIOS = [
  { id: 'CGO-1', label: 'CGO-1 · CFS Pendency Spike' },
  { id: 'CGO-2', label: 'CGO-2 · Customs Flag Surge → UC3' },
  { id: 'CGO-3', label: 'CGO-3 · ITRHO Optimisation' },
  { id: 'LANE-ASSIGN', label: 'Congestion → Dynamic Lane Assignment' },
];

export function Scenarios({ onResult }: { onResult?: (r: ScenarioResultDTO) => void }) {
  const { adapter, lang } = useApp();
  const [result, setResult] = useState<ScenarioResultDTO | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  async function run(id: string) {
    setRunning(id);
    const r = await adapter.runScenario(id, {});
    setResult(r);
    onResult?.(r);
    setRunning(null);
  }

  const state = { data: result, loading: false, error: null };

  return (
    <Panel heading={t('panel_scenarios', lang)} state={state} isEmpty={() => false}>
      {() => (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {SCENARIOS.map((s) => (
              <CalciteButton
                key={s.id}
                scale="s"
                appearance="outline"
                loading={running === s.id}
                onClick={() => run(s.id)}
              >
                {s.label}
              </CalciteButton>
            ))}
          </div>

          {result && (
            <>
              <CalciteNotice open kind="success" icon="lightbulb">
                <div slot="title">{result.scenarioId} — automated actions</div>
                <div slot="message">
                  {result.actions.map((a, i) => (
                    <div key={i}>
                      <CalciteChip
                        value={a.kind}
                        scale="s"
                        kind={a.kind === 'CROSS_TWIN_PUSH' ? 'brand' : 'neutral'}
                      >
                        {a.kind}
                      </CalciteChip>{' '}
                      {a.detail}
                      {a.target ? ` → ${a.target}` : ''}
                    </div>
                  ))}
                </div>
              </CalciteNotice>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                {result.after.slice(0, 7).map((after, i) => {
                  const before = result.before[i]!;
                  const delta = after.value - before.value;
                  const improved = after.improvementPct >= before.improvementPct;
                  return (
                    <CalciteCard key={after.key} style={{ minWidth: 160 }}>
                      <div slot="heading" style={{ fontSize: 12, color: tokens.color.textMuted }}>{after.label}</div>
                      <div style={{ fontSize: 13 }}>
                        {t('before', lang)}: {before.value} {before.unit}
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 700 }}>
                        {t('after', lang)}: {after.value} {after.unit}
                      </div>
                      <div
                        slot="footer-start"
                        style={{ color: improved ? tokens.kpi.better : tokens.kpi.worse, fontSize: 12 }}
                      >
                        Δ {delta > 0 ? '+' : ''}{Math.round(delta * 100) / 100} {after.unit}
                      </div>
                    </CalciteCard>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
