/**
 * SimulatorPage — the live-data control room. A separate route (`#/simulator`,
 * usually opened on its own screen) with per-faction controls: a master clock
 * (play / pause / speed), gate queues, rail T1/T2 placement, facility pendency,
 * movement throughput, customs scan depth, and empty-pool availability.
 *
 * Every control writes to simStore, which broadcasts over BroadcastChannel to
 * the Dashboard tab so its tabs + the ArcGIS map update in real time. Asset ids
 * are loaded from the adapter so controls reference the *real* gates/facilities
 * the map draws, and driving one highlights it on the map.
 */
import { useMemo } from 'react';
import {
  CalciteShell, CalciteNavigation, CalciteNavigationLogo, CalcitePanel, CalciteBlock,
  CalciteButton, CalciteSlider, CalciteLabel,
  CalciteChip, CalciteSegmentedControl, CalciteSegmentedControlItem, CalciteNotice,
} from '@esri/calcite-components-react';
import type { Facility, Terminal, ScanEvent } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO, EmptyPoolDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';
import { simStore } from './simStore.js';
import { useSimStore } from './useSimStore.js';
import { navigate } from './useHashRoute.js';

const DEMO_WINDOW = {
  from: new Date(Date.UTC(2026, 5, 15, 0, 0, 0)).toISOString(),
  to: new Date(Date.UTC(2026, 5, 17, 0, 0, 0)).toISOString(),
};
const SPEEDS = [0.5, 1, 2, 4, 8];
const SIDINGS = ['T1', 'T2'] as const;

const fmtSigned = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Recompute the highlight set from whatever overrides currently exist. */
function recomputeHighlights() {
  const s = simStore.getState();
  const ids = new Set<string>([
    ...Object.keys(s.gates),
    ...Object.keys(s.pendency),
  ]);
  simStore.setHighlights([...ids]);
}

export function SimulatorPage() {
  const { adapter } = useApp();
  const sim = useSimStore();

  const facilities = useAsync<Facility[]>(() => adapter.getFacilities(), [adapter]);
  const terminals = useAsync<Terminal[]>(() => adapter.getTerminals(), [adapter]);
  const gateOps = useAsync<GateOpsDTO[]>(() => adapter.getGateOps(DEMO_WINDOW), [adapter]);
  const pendency = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter]);
  const scans = useAsync<ScanEvent[]>(() => adapter.getScanQueue(), [adapter]);
  const empty = useAsync<EmptyPoolDTO>(() => adapter.getEmptyPool(), [adapter]);

  const gates = gateOps.data ?? [];
  const facs = useMemo(
    () => (pendency.data ?? []).slice().sort((a, b) => b.pendency - a.pendency),
    [pendency.data],
  );
  // Live baselines for the Scan/Empty controls (count of currently-pending
  // scans; total empty-pool balance) so the sliders read against real numbers.
  const livePendingScans = (scans.data ?? []).filter((s) => !s.result).length;
  const emptyBalance = (empty.data?.pools ?? []).reduce(
    (n, p) => n + (p.availableQty - p.projectedDemandQty),
    0,
  );

  const clock = new Date(sim.clockMs);

  return (
    <CalciteShell style={{ height: '100vh', background: tokens.color.bg }}>
      <CalciteNavigation slot="header">
        <CalciteNavigationLogo
          slot="logo"
          heading="JNPA UC-2 · Live Data Simulator"
          description="Drive the dashboard in real time"
        />
        <div slot="content-end" style={{ display: 'flex', gap: 12, alignItems: 'center', paddingInline: 16 }}>
          <CalciteChip kind={sim.running ? 'brand' : 'neutral'} icon={sim.running ? 'play-f' : 'pause-f'} value="status">
            {sim.running ? 'RUNNING' : 'PAUSED'}
          </CalciteChip>
          <CalciteChip kind="neutral" value="clock" icon="clock">
            {clock.toLocaleTimeString()}
          </CalciteChip>
          <CalciteButton appearance="outline" iconStart="map" onClick={() => navigate('/')}>
            Open dashboard
          </CalciteButton>
        </div>
      </CalciteNavigation>

      <CalcitePanel heading="Simulation controls">
        <div style={{ padding: 16, display: 'grid', gap: 16, maxWidth: 1100, margin: '0 auto' }}>
          <CalciteNotice open icon="lightning" kind="brand" scale="s">
            <div slot="message">
              Changes here stream live to the dashboard (open it in another tab/window). Press play to let
              metrics auto-advance, or set values manually.
            </div>
          </CalciteNotice>

          {/* ---- Master clock ---- */}
          <CalciteBlock open heading="Clock & playback" description="Master tick engine">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <CalciteButton
                iconStart={sim.running ? 'pause' : 'play'}
                kind={sim.running ? 'danger' : 'brand'}
                onClick={() => simStore.setRunning(!sim.running)}
              >
                {sim.running ? 'Pause' : 'Play'}
              </CalciteButton>
              <CalciteButton appearance="outline" iconStart="reset" onClick={() => simStore.reset()}>
                Reset all
              </CalciteButton>
              <CalciteLabel layout="inline" style={{ marginInlineStart: 16 }}>
                Speed
                <CalciteSegmentedControl
                  onCalciteSegmentedControlChange={(e) =>
                    simStore.setSpeed(Number((e.target as unknown as { value: string }).value))
                  }
                >
                  {SPEEDS.map((sp) => (
                    <CalciteSegmentedControlItem key={sp} value={String(sp)} checked={sim.speed === sp}>
                      {sp}×
                    </CalciteSegmentedControlItem>
                  ))}
                </CalciteSegmentedControl>
              </CalciteLabel>
            </div>
          </CalciteBlock>

          {/* ---- Gates ---- */}
          <CalciteBlock open heading="Gates" description="Live queue length per gate">
            {gates.length === 0 ? (
              <p style={{ color: tokens.color.textMuted }}>Loading gates…</p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {gates.map((g) => {
                  const val = sim.gates[g.gateId]?.queueLength ?? g.queueLength;
                  return (
                    <div key={g.gateId} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 48px', gap: 12, alignItems: 'center' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{g.gateId}</span>
                      <CalciteSlider
                        min={0}
                        max={30}
                        value={val}
                        labelHandles
                        onCalciteSliderInput={(e) => {
                          simStore.setGate(g.gateId, { queueLength: Number((e.target as unknown as { value: number }).value) });
                          recomputeHighlights();
                        }}
                      />
                      <CalciteChip
                        value={String(val)}
                        style={{ ['--calcite-chip-text-color' as never]: val > 16 ? tokens.congestion.RED : val > 8 ? tokens.congestion.AMBER : tokens.congestion.GREEN }}
                      >
                        {val}
                      </CalciteChip>
                    </div>
                  );
                })}
              </div>
            )}
          </CalciteBlock>

          {/* ---- Rail T1/T2 ---- */}
          <CalciteBlock open heading="Rail · T1 / T2" description="Inbound rake queue & placement">
            <div style={{ display: 'grid', gap: 16 }}>
              {SIDINGS.map((sd) => {
                const o = sim.rail[sd] ?? {};
                return (
                  <div key={sd} style={{ border: `1px solid ${tokens.color.border}`, borderRadius: 8, padding: 12 }}>
                    <strong style={{ fontSize: 13 }}>Siding {sd}</strong>
                    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 40px', gap: 12, alignItems: 'center', marginTop: 8 }}>
                      <span style={{ fontSize: 12 }}>Inbound queue</span>
                      <CalciteSlider min={0} max={12} value={o.inboundQueue ?? 0} labelHandles
                        onCalciteSliderInput={(e) => simStore.setRail(sd, { inboundQueue: Number((e.target as unknown as { value: number }).value) })} />
                      <span style={{ fontSize: 12, textAlign: 'right' }}>{o.inboundQueue ?? 0}</span>
                      <span style={{ fontSize: 12 }}>Placed on siding</span>
                      <CalciteSlider min={0} max={6} value={o.placed ?? 0} labelHandles
                        onCalciteSliderInput={(e) => simStore.setRail(sd, { placed: Number((e.target as unknown as { value: number }).value) })} />
                      <span style={{ fontSize: 12, textAlign: 'right' }}>{o.placed ?? 0}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CalciteBlock>

          {/* ---- Pendency ---- */}
          <CalciteBlock open heading="Pendency" description="Container backlog per facility">
            {facs.length === 0 ? (
              <p style={{ color: tokens.color.textMuted }}>Loading facilities…</p>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {facs.slice(0, 10).map((p) => {
                  const val = sim.pendency[p.facilityId]?.pendency ?? p.pendency;
                  return (
                    <div key={p.facilityId} style={{ display: 'grid', gridTemplateColumns: '200px 1fr 48px', gap: 12, alignItems: 'center' }}>
                      <span style={{ fontSize: 12 }}>{p.facilityName}</span>
                      <CalciteSlider min={0} max={300} value={val} labelHandles
                        onCalciteSliderInput={(e) => {
                          simStore.setPendency(p.facilityId, Number((e.target as unknown as { value: number }).value));
                          recomputeHighlights();
                        }} />
                      <span style={{ fontSize: 12, textAlign: 'right' }}>{val}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </CalciteBlock>

          {/* ---- Movements ---- */}
          <CalciteBlock open heading="Movements" description="Cargo-flow throughput multiplier">
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 56px', gap: 12, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>Flow rate</span>
              <CalciteSlider min={0} max={3} step={0.1} value={sim.movementRate} labelHandles ticks={1}
                onCalciteSliderInput={(e) => simStore.setMovementRate(Number((e.target as unknown as { value: number }).value))} />
              <CalciteChip value="rate">{sim.movementRate.toFixed(1)}×</CalciteChip>
            </div>
          </CalciteBlock>

          {/* ---- Scan & Empty ---- */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <CalciteBlock open heading="Customs scan" description="Pending scans in the queue">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <CalciteChip scale="s" value="live">Live: {livePendingScans} pending</CalciteChip>
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="download-to"
                  onClick={() => simStore.setScanQueue(livePendingScans)}
                >
                  Seed from live
                </CalciteButton>
                {sim.scanQueue != null && (
                  <CalciteButton scale="s" appearance="transparent" iconStart="x" onClick={() => simStore.setScanQueue(null)}>
                    Clear override
                  </CalciteButton>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 48px', gap: 12, alignItems: 'center' }}>
                <CalciteSlider min={0} max={80} value={sim.scanQueue ?? 0} labelHandles
                  onCalciteSliderInput={(e) => simStore.setScanQueue(Number((e.target as unknown as { value: number }).value))} />
                <span style={{ fontSize: 12, textAlign: 'right' }}>{sim.scanQueue ?? '—'}</span>
              </div>
            </CalciteBlock>
            <CalciteBlock open heading="Empty pool" description="Availability delta (± containers)">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                <CalciteChip
                  scale="s"
                  value="balance"
                  style={{ ['--calcite-chip-text-color' as never]: emptyBalance + sim.emptyDelta >= 0 ? tokens.kpi.better : tokens.kpi.worse }}
                >
                  Balance: {fmtSigned(emptyBalance + sim.emptyDelta)}
                </CalciteChip>
                <span style={{ fontSize: 11, color: tokens.color.textMuted }}>(base {fmtSigned(emptyBalance)})</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px', gap: 12, alignItems: 'center' }}>
                <CalciteSlider min={-200} max={200} value={sim.emptyDelta} labelHandles
                  onCalciteSliderInput={(e) => simStore.setEmptyDelta(Number((e.target as unknown as { value: number }).value))} />
                <span style={{ fontSize: 12, textAlign: 'right' }}>{fmtSigned(sim.emptyDelta)}</span>
              </div>
            </CalciteBlock>
          </div>

          <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Facilities loaded: {facilities.data?.length ?? 0} · terminals: {terminals.data?.length ?? 0} ·
            highlighted assets: {sim.highlights.length}
          </p>
        </div>
      </CalcitePanel>
    </CalciteShell>
  );
}
