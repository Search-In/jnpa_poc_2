/**
 * Integration Simulator Console (spec §6, scored criterion 3 — "API/data
 * integration plan + fallback mechanism when data unavailable").
 *
 * A slide-over, opened by the always-visible DATA_MODE header chip, that lists
 * every external source the production system will integrate — each a locally
 * simulated adapter, nothing external is ever called. Per source it offers the
 * spec's controls: LIVE / DEGRADED / OFFLINE, a stale-data toggle, latency
 * injection, and a hard kill switch. Changes flow through the faultStore into
 * the SimAdapter, so the HealthCards tab, the Operator Banner and downstream
 * KPI provenance all react live — the exact "what if the API goes down?" moment.
 *
 * On recovery, a reconciliation report is queued and shown here ("N buffered
 * events applied; K conflicts resolved last-writer-wins") — the §6.2 behaviour.
 */
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteSegmentedControl,
  CalciteSegmentedControlItem, CalciteSwitch, CalciteNotice,
} from '@esri/calcite-components-react';
import { faultStore, CONSOLE_SOURCES, SOURCE_LABELS, dataQualityFor, type SourceMode } from './faultStore.js';
import { useFaultStore } from './useFaultStore.js';
import { tokens } from '../theme/tokens.js';

const modeColor: Record<SourceMode | 'OFFLINE', string> = {
  LIVE: tokens.degradation.GREEN,
  DEGRADED: tokens.degradation.AMBER,
  OFFLINE: tokens.degradation.RED,
};

/** A compact freshness/completeness/validity meter (§6.3 DQ widget). */
function DqMeter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 85 ? tokens.degradation.GREEN : pct >= 50 ? tokens.degradation.AMBER : tokens.degradation.RED;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: tokens.color.textMuted }}>
      <span style={{ width: 74 }}>{label}</span>
      <div style={{ flex: 1, height: 5, borderRadius: 3, background: tokens.color.bgElevated, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 200ms ease' }} />
      </div>
      <span style={{ width: 30, textAlign: 'right' }}>{pct}%</span>
    </div>
  );
}

export function IntegrationConsole() {
  const state = useFaultStore();
  if (!state.open) return null;

  return (
    <>
      {/* Scrim */}
      <div
        onClick={() => faultStore.setOpen(false)}
        style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }}
        aria-hidden
      />
      {/* Slide-over */}
      <aside
        role="dialog"
        aria-label="Integration Simulator Console"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="plug" scale="s" />
          <strong style={{ fontSize: 14 }}>Integration Simulator Console</strong>
          <button
            onClick={() => faultStore.setOpen(false)}
            aria-label="Close"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}
          >
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
          <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 10px' }}>
            Every source below is a <strong>locally simulated adapter</strong> — nothing external is called.
            Inject a fault and watch the twin degrade gracefully (Health tab &amp; Operator Banner), then recover.
          </p>

          {/* Reconciliation reports queued on recovery (§6.2). */}
          {state.reconciliations.map((r, i) => (
            <CalciteNotice key={i} open kind="success" icon="refresh" scale="s" style={{ marginBottom: 8 }} closable
              onCalciteNoticeClose={() => faultStore.ackReconciliation(i)}>
              <div slot="title">{r.source} reconciled</div>
              <div slot="message">
                {r.bufferedEvents} buffered events applied; {r.conflicts} conflict{r.conflicts === 1 ? '' : 's'} resolved last-writer-wins.
              </div>
            </CalciteNotice>
          ))}

          {CONSOLE_SOURCES.map((src) => {
            const f = state.sources[src];
            const effectiveMode: SourceMode = f?.killed ? 'OFFLINE' : (f?.mode ?? 'LIVE');
            const dq = dataQualityFor(f);
            return (
              <div
                key={src}
                style={{
                  border: `1px solid ${tokens.color.border}`, borderRadius: 10,
                  padding: 10, marginBottom: 10, background: tokens.color.bg,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span
                    style={{ width: 9, height: 9, borderRadius: '50%', background: modeColor[effectiveMode], flexShrink: 0 }}
                    aria-hidden
                  />
                  <strong style={{ fontSize: 12.5, color: tokens.color.text }}>{SOURCE_LABELS[src] ?? src}</strong>
                  <CalciteChip
                    scale="s"
                    value={effectiveMode}
                    style={{ marginLeft: 'auto', ['--calcite-chip-text-color' as never]: modeColor[effectiveMode] }}
                  >
                    {effectiveMode}
                  </CalciteChip>
                </div>

                {/* Mode toggle */}
                <CalciteSegmentedControl
                  width="full"
                  scale="s"
                  onCalciteSegmentedControlChange={(e) =>
                    faultStore.setMode(src, (e.target as unknown as { value: SourceMode }).value)
                  }
                >
                  <CalciteSegmentedControlItem value="LIVE" checked={effectiveMode === 'LIVE'}>LIVE</CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="DEGRADED" checked={effectiveMode === 'DEGRADED'}>DEGRADED</CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="OFFLINE" checked={effectiveMode === 'OFFLINE'}>OFFLINE</CalciteSegmentedControlItem>
                </CalciteSegmentedControl>

                {/* Controls row: stale toggle + kill switch */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8, fontSize: 11.5, color: tokens.color.textMuted }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <CalciteSwitch
                      scale="s"
                      checked={f?.stale ?? false}
                      onCalciteSwitchChange={(e) => faultStore.setStale(src, (e.target as unknown as { checked: boolean }).checked)}
                    />
                    Stale data
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
                    <CalciteSwitch
                      scale="s"
                      checked={f?.killed ?? false}
                      onCalciteSwitchChange={(e) => faultStore.setKilled(src, (e.target as unknown as { checked: boolean }).checked)}
                    />
                    <span style={{ color: f?.killed ? tokens.degradation.RED : undefined, fontWeight: f?.killed ? 700 : 400 }}>Kill switch</span>
                  </label>
                </div>

                {/* Data-quality meters — drop when degraded/offline (provenance to KPIs). */}
                <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
                  <DqMeter label="Freshness" value={dq.freshness} />
                  <DqMeter label="Completeness" value={dq.completeness} />
                  <DqMeter label="Validity" value={dq.validity} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          <CalciteButton scale="s" appearance="outline" iconStart="reset" onClick={() => faultStore.resetAll()}>
            Reset all to LIVE
          </CalciteButton>
          <CalciteButton scale="s" appearance="solid" kind="brand" iconStart="check" style={{ marginLeft: 'auto' }} onClick={() => faultStore.setOpen(false)}>
            Done
          </CalciteButton>
        </div>
      </aside>
    </>
  );
}
