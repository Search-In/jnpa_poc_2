/**
 * What-If Scenarios panel (prompt §10, §12). Each of the four §8.4.5 scenarios
 * (CGO-1/2/3 + dynamic lane-assignment) runs as a *guided, live playback*:
 * pressing Run starts a step-by-step tour (see GuidedTour) that drives the real
 * sim levers, so every panel, the KPI strip and the map animate in real time and
 * a coach-mark explains — in plain language — what is changing and why.
 *
 * The deterministic before/after engine (adapter.runScenario, scenarios-mock.ts)
 * is still available behind "View full KPI impact" for the numeric delta panel
 * and the cross-twin action log.
 */
import { useState } from 'react';
import {
  CalciteButton, CalciteCard, CalciteChip, CalciteNotice, CalciteIcon,
} from '@esri/calcite-components-react';
import type { ScenarioResultDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { simStore } from '../sim/simStore.js';
import { useSimStore } from '../sim/useSimStore.js';
import { SCENARIO_SCRIPTS } from '../sim/scenarioPlayer.js';

export function Scenarios({ onResult }: { onResult?: (r: ScenarioResultDTO) => void }) {
  const { adapter, lang } = useApp();
  const sim = useSimStore();
  const activeId = sim.tour.scenarioId;
  const [result, setResult] = useState<ScenarioResultDTO | null>(null);
  const [impactFor, setImpactFor] = useState<string | null>(null);
  const [loadingImpact, setLoadingImpact] = useState<string | null>(null);

  // Numeric before/after impact (kept from the deterministic engine).
  async function showImpact(id: string) {
    setLoadingImpact(id);
    const r = await adapter.runScenario(id, {});
    setResult(r);
    setImpactFor(id);
    onResult?.(r);
    setLoadingImpact(null);
  }

  const state = { data: SCENARIO_SCRIPTS, loading: false, error: null };

  return (
    <Panel heading={t('panel_scenarios', lang)} state={state} isEmpty={() => false}>
      {() => (
        <>
          <CalciteNotice open icon="lightbulb" kind="brand" scale="s">
            <div slot="message">
              Run a scenario to start a guided walkthrough. The board and map update live and a
              tip card explains each change — no port-ops experience needed.
            </div>
          </CalciteNotice>

          <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
            {SCENARIO_SCRIPTS.map((s) => {
              const running = activeId === s.id;
              return (
                <CalciteCard key={s.id} style={running ? { outline: `2px solid ${tokens.color.brand}` } : undefined}>
                  <div slot="heading" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <CalciteIcon icon={s.icon} scale="s" />
                    <span>{s.id} · {s.title}</span>
                    {running && <CalciteChip scale="s" kind="brand" value="running">running</CalciteChip>}
                  </div>
                  <div slot="description" style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {s.blurb}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                    {running ? (
                      <CalciteButton scale="s" kind="danger" iconStart="x" onClick={() => simStore.stopScenario()}>
                        Stop & reset
                      </CalciteButton>
                    ) : (
                      <CalciteButton scale="s" iconStart="play" onClick={() => simStore.startScenario(s.id)}>
                        Run guided scenario
                      </CalciteButton>
                    )}
                    <CalciteButton
                      scale="s"
                      appearance="outline"
                      iconStart="graph-time-series"
                      loading={loadingImpact === s.id}
                      onClick={() => showImpact(s.id)}
                    >
                      View full KPI impact
                    </CalciteButton>
                  </div>
                </CalciteCard>
              );
            })}
          </div>

          {/* Numeric before/after delta + automated-action log for the last
              "View full KPI impact" run. */}
          {result && impactFor && (
            <div style={{ marginTop: 16 }}>
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
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
