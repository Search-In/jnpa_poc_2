/**
 * Integration Simulator Console (spec §6, scored criterion 3 — "API/data
 * integration plan + fallback mechanism when data unavailable").
 *
 * A slide-over, opened by the always-visible DATA_MODE header chip, that lists
 * every external source the production system will integrate. Per source it
 * offers the spec's controls: LIVE / DEGRADED / OFFLINE, a stale-data toggle,
 * latency injection, and a hard kill switch.
 *
 * ⚠ WHAT UC2-041 CHANGED — the controls now drive something real.
 *
 * Until this ticket the console wrote ONLY to a `localStorage` fault store, and
 * `applyIntegrationFaults` overlaid that on the health cards. UC2-040 had
 * already built `injectConnectorFault` against the connectors' real
 * `POST /inject-fault`; nothing called it. So with all six containers up and
 * healthy, dragging a control here changed a colour in the browser and nothing
 * else — and because the overlay spread `...h`, the resulting card kept
 * `source: 'CONNECTOR'` while carrying a degradation the connector had never
 * reported.
 *
 * Now: when a real connector backs a source, the control POSTs to that
 * connector and the card that comes back is the connector's own. When none does
 * — a demo laptop with no Docker — the browser simulator takes over and the row
 * says so. The simulator is kept deliberately; what is not kept is the ambiguity
 * about which one you are looking at.
 *
 * The `Run drill` button is the rehearsal itself: the connector performs four
 * real polls under four real injected conditions and returns what happened,
 * including the steps that did not reach their tier.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteSegmentedControl,
  CalciteSegmentedControlItem, CalciteSwitch, CalciteNotice, CalciteLoader,
} from '@esri/calcite-components-react';
import type { IntegrationHealth, SourceSystem } from '@jnpa/schemas';
import { faultStore, CONSOLE_SOURCES, SOURCE_LABELS, dataQualityFor, type SourceMode } from './faultStore.js';
import { useFaultStore, useFaultDep } from './useFaultStore.js';
import { drillTranscript, drillVerdict, levelForMode, type DrillReport } from './drill.js';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';

const modeColor: Record<SourceMode | 'OFFLINE', string> = {
  LIVE: tokens.degradation.GREEN,
  DEGRADED: tokens.degradation.AMBER,
  OFFLINE: tokens.degradation.RED,
};

const verdictColor = {
  pass: tokens.degradation.GREEN,
  partial: tokens.degradation.AMBER,
  unconfigured: tokens.degradation.AMBER,
  none: tokens.degradation.RED,
} as const;

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

/** What the connector itself currently reports — tier, upstream and reason. */
function ConnectorLine({ card }: { card: IntegrationHealth }) {
  return (
    <div style={{
      marginTop: 8, padding: '6px 8px', borderRadius: 6,
      background: tokens.color.bgElevated, fontSize: 10.5, color: tokens.color.textMuted,
    }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: tokens.mode[card.mode] }}>{card.mode}</strong>
        <span>tier</span>
        {card.upstream && <span>· via {card.upstream}</span>}
      </div>
      {/* The note is the WHY — how stale the cache is, or which credential is
          missing. It is the single most useful line on a degraded card and was
          never rendered anywhere before this ticket. */}
      {card.note && <div style={{ marginTop: 3, lineHeight: 1.35 }}>{card.note}</div>}
    </div>
  );
}

function DrillTranscript({ report }: { report: DrillReport }) {
  const verdict = drillVerdict(report);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: verdictColor[verdict.tone], marginBottom: 2,
      }}>
        {verdict.headline}
      </div>
      <div style={{ fontSize: 10.5, color: tokens.color.textMuted, lineHeight: 1.4, marginBottom: 6 }}>
        {verdict.detail}
      </div>
      {report.steps.map((s) => (
        <div key={s.step} style={{
          display: 'grid', gridTemplateColumns: '1fr auto', gap: 4,
          padding: '5px 7px', marginBottom: 4, borderRadius: 6,
          border: `1px solid ${s.matched ? tokens.color.border : tokens.degradation.AMBER}`,
          fontSize: 10.5, color: tokens.color.textMuted,
        }}>
          <strong style={{ color: tokens.color.text }}>{s.step}</strong>
          <span style={{ color: s.matched ? tokens.degradation.GREEN : tokens.degradation.AMBER }}>
            {s.tier}{s.matched ? '' : ` (wanted ${s.expectedTier})`}
          </span>
          <span style={{ gridColumn: '1 / -1', lineHeight: 1.35 }}>{s.why}</span>
          {s.note && <span style={{ gridColumn: '1 / -1', opacity: 0.85 }}>{s.note}</span>}
        </div>
      ))}
      <CalciteButton
        scale="s" appearance="outline" iconStart="copy-to-clipboard" width="full"
        onClick={() => navigator.clipboard?.writeText(drillTranscript(report))}
      >
        Copy transcript
      </CalciteButton>
    </div>
  );
}

export function IntegrationConsole() {
  const state = useFaultStore();
  const { adapter } = useApp();
  const faultDep = useFaultDep();
  // Which sources a real connector is currently backing. Refetched whenever a
  // fault lands, so a connector that dies mid-drill stops claiming to be live.
  const health = useAsync<IntegrationHealth[]>(
    () => (state.open ? adapter.getIntegrationHealth() : Promise.resolve([])),
    [adapter, faultDep, state.open],
  );
  // Memoised so `drive`/`runDrill` (which depend on it) keep a stable identity
  // between health refetches — same data, same Map, fewer callback rebuilds.
  const cards = useMemo(
    () => new Map((health.data ?? []).map((h) => [h.sourceSystem, h])),
    [health.data],
  );

  const [drills, setDrills] = useState<Record<string, DrillReport | null>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [driven, setDriven] = useState<Record<string, 'connector' | 'browser'>>({});

  /**
   * Drive a source's fault. The connector wins when there is one.
   *
   * The console control state still goes to the fault store either way — it is
   * the one place the segmented control's position lives, and cross-tab sync
   * depends on it. What the store no longer does is REWRITE a connector's card
   * (see `applyIntegrationFaults`), so writing it here is not double-application.
   */
  const drive = useCallback(async (src: SourceSystem, next: { mode?: SourceMode; killed?: boolean }) => {
    // Write the intent, THEN read back the resulting state to decide the level.
    // Deriving it from the arguments instead was a real bug: turning the kill
    // switch OFF passed the still-killed `effectiveMode` of OFFLINE alongside
    // `killed: false`, and the two together re-killed the source. The store is
    // the one place that reconciles mode and kill, so let it.
    if (next.killed !== undefined) faultStore.setKilled(src, next.killed);
    if (next.mode !== undefined) faultStore.setMode(src, next.mode);
    const after = faultStore.getState().sources[src];

    const backed = cards.get(src)?.source === 'CONNECTOR';
    if (!backed || !adapter.injectConnectorFault) {
      setDriven((d) => ({ ...d, [src]: 'browser' }));
      return;
    }
    const card = await adapter.injectConnectorFault(
      src, levelForMode(after?.mode ?? 'LIVE', after?.killed ?? false),
    );
    // A null answer means the POST did not land. Say the browser drove it rather
    // than leaving the operator believing a connector accepted the injection.
    setDriven((d) => ({ ...d, [src]: card ? 'connector' : 'browser' }));
    faultStore.bump();
  }, [adapter, cards]);

  const runDrill = useCallback(async (src: SourceSystem) => {
    setRunning(src);
    try {
      const report = (await adapter.runConnectorDrill?.(src)) ?? null;
      setDrills((d) => ({ ...d, [src]: report as DrillReport | null }));
    } finally {
      setRunning(null);
      faultStore.bump();
    }
  }, [adapter]);

  if (!state.open) return null;

  const anyConnector = [...cards.values()].some((h) => h.source === 'CONNECTOR');

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
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(460px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="plug" scale="s" />
          <strong style={{ fontSize: 14 }}>Integration Console</strong>
          <button
            onClick={() => faultStore.setOpen(false)}
            aria-label="Close"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}
          >
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
          {/* One sentence, and it must be the true one for THIS machine. */}
          <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 10px', lineHeight: 1.45 }}>
            {anyConnector
              ? <>Controls below POST to the <strong>real connector services</strong>. Faults change
                  which fallback tier serves, not just a colour — <strong>Run drill</strong> walks
                  LIVE→CACHED→SYNTHETIC and back, and reports what actually happened.</>
              : <>No connector service answered, so every control here is <strong>simulated in the
                  browser</strong>. Start the connectors to drive the real fallback chain.</>}
          </p>

          {/* Reconciliation reports queued on recovery (§6.2).
              Shown only for browser-simulated sources: the buffered-event counts
              are derived from the source name, and printing an invented figure
              beside a real connector's card would make it read as measured. */}
          {state.reconciliations
            .filter((r) => cards.get(r.source as SourceSystem)?.source !== 'CONNECTOR')
            .map((r, i) => (
              <CalciteNotice key={i} open kind="success" icon="refresh" scale="s" style={{ marginBottom: 8 }} closable
                onCalciteNoticeClose={() => faultStore.ackReconciliation(i)}>
                <div slot="title">{r.source} reconciled (simulated)</div>
                <div slot="message">
                  {r.bufferedEvents} buffered events applied; {r.conflicts} conflict{r.conflicts === 1 ? '' : 's'} resolved last-writer-wins.
                </div>
              </CalciteNotice>
            ))}

          {CONSOLE_SOURCES.map((src) => {
            const f = state.sources[src];
            const effectiveMode: SourceMode = f?.killed ? 'OFFLINE' : (f?.mode ?? 'LIVE');
            const dq = dataQualityFor(f);
            const card = cards.get(src);
            const backed = card?.source === 'CONNECTOR';
            const report = drills[src];
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
                  {/* WHO this row's controls reach. Never inferred from intent —
                      taken from whether a connector answered its own /health. */}
                  <span
                    title={backed
                      ? 'This row drives the real connector service.'
                      : (driven[src] === 'browser' && card
                        ? (card.fallbackReason ?? 'No connector answered; this row is simulated in the browser.')
                        : 'No connector answered; this row is simulated in the browser.')}
                    style={{
                      fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4,
                      padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap',
                      border: `1px solid ${backed ? tokens.degradation.GREEN : tokens.color.border}`,
                      color: backed ? tokens.degradation.GREEN : tokens.color.textMuted,
                    }}
                  >
                    {backed ? 'connector' : 'simulated'}
                  </span>
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
                    void drive(src, { mode: (e.target as unknown as { value: SourceMode }).value })
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
                      onCalciteSwitchChange={(e) =>
                        void drive(src, { killed: (e.target as unknown as { checked: boolean }).checked })
                      }
                    />
                    <span style={{ color: f?.killed ? tokens.degradation.RED : undefined, fontWeight: f?.killed ? 700 : 400 }}>Kill switch</span>
                  </label>
                </div>

                {/* What the connector itself says right now. */}
                {backed && card && <ConnectorLine card={card} />}

                {/* Data-quality meters — drop when degraded/offline (provenance to KPIs). */}
                <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
                  <DqMeter label="Freshness" value={dq.freshness} />
                  <DqMeter label="Completeness" value={dq.completeness} />
                  <DqMeter label="Validity" value={dq.validity} />
                </div>

                {/* The rehearsal (UC2-041). Disabled without a connector — there
                    would be nothing to walk, and a button that returned a green
                    tick off the browser simulator would be worse than no button. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <CalciteButton
                    scale="s" appearance="outline" iconStart="play"
                    disabled={!backed || running === src}
                    onClick={() => void runDrill(src)}
                  >
                    Run drill
                  </CalciteButton>
                  {running === src && <CalciteLoader inline label="running" />}
                  {!backed && (
                    <span style={{ fontSize: 10.5, color: tokens.color.textMuted }}>
                      needs the connector running
                    </span>
                  )}
                </div>

                {running !== src && src in drills && (
                  report
                    ? <DrillTranscript report={report} />
                    : <div style={{ marginTop: 8, fontSize: 10.5, color: tokens.degradation.RED }}>
                        No drill ran — the connector did not answer POST /drill. Nothing was
                        exercised, so this is not a pass.
                      </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          <CalciteButton
            scale="s" appearance="outline" iconStart="reset"
            onClick={() => {
              faultStore.resetAll();
              // Clear the real connectors too, or the board would show a green
              // console over six still-faulted services.
              for (const src of CONSOLE_SOURCES) void adapter.injectConnectorFault?.(src, null);
            }}
          >
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
