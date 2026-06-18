/**
 * Demo Console UI (Addendum B.1) — all control groups as standard Calcite
 * components: feeds, demo clock, event injectors, scenario triggers, fault
 * injection, load/rate, cross-twin, recorder, runbooks, status. Drives the same
 * event backbone as live connectors; everything offline + deterministic.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalciteShell, CalciteShellPanel, CalcitePanel, CalciteBlock, CalciteButton,
  CalciteActionBar, CalciteAction, CalciteSwitch, CalciteLabel, CalciteSlider,
  CalciteSegmentedControl, CalciteSegmentedControlItem, CalciteCard, CalciteChip,
  CalciteNotice, CalciteCombobox, CalciteComboboxItem, CalciteInputNumber, CalciteSelect, CalciteOption,
} from '@esri/calcite-components-react';
import { UC2_REGISTRY } from '@jnpa/sim';
import type { Degradation } from '@jnpa/schemas';
import { ConsoleController } from './controller.js';

const DEG_COLOR: Record<string, string> = { GREEN: '#2dbb6a', AMBER: '#f2a93b', RED: '#e04545' };

export function App() {
  const controller = useMemo(() => new ConsoleController(), []);
  const [, force] = useState(0);
  const rerender = () => force((n) => n + 1);
  const [speed, setSpeed] = useState(1);
  const [running, setRunning] = useState(false);
  const [params, setParams] = useState<Record<string, Record<string, unknown>>>({});
  const tickRef = useRef<number | null>(null);

  // demo clock loop
  useEffect(() => {
    if (running) controller.clock.play();
    else controller.clock.pause();
    controller.clock.setSpeed(speed);
    const id = window.setInterval(() => {
      controller.clock.tick(1000);
      rerender();
    }, 1000);
    tickRef.current = id;
    return () => window.clearInterval(id);
  }, [running, speed, controller]);

  // keyboard shortcuts for top scenario triggers (Addendum B.2)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inj = UC2_REGISTRY.injectors.find((i) => i.shortcut === e.key);
      if (inj && !(e.target instanceof HTMLInputElement)) {
        controller.fire(inj.id, params[inj.id] ?? {});
        rerender();
      }
      if (e.key === 'Escape') {
        controller.reset();
        rerender();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, params]);

  const fire = (id: string) => {
    controller.fire(id, params[id] ?? {});
    rerender();
  };

  const events = UC2_REGISTRY.injectors.filter((i) => i.group === 'event');
  const scenarios = UC2_REGISTRY.injectors.filter((i) => i.group === 'scenario');

  return (
    <CalciteShell style={{ height: '100vh' }}>
      <CalcitePanel heading="JNPA Demo Console — UC2 (offline · deterministic)">
        {/* degradation status row — large + always visible (Addendum B.2) */}
        <CalciteBlock heading="Integration status" open>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {Object.values(controller.health).map((h) => (
              <CalciteChip key={h.source} value={h.source} style={{ ['--calcite-chip-text-color' as never]: DEG_COLOR[h.degradation] }}>
                {h.source}: {h.degradation} ({h.mode})
              </CalciteChip>
            ))}
          </div>
        </CalciteBlock>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12 }}>
          {/* Demo clock */}
          <CalciteBlock heading="Demo clock" description={controller.clock.nowIso()} open>
            <CalciteSegmentedControl onCalciteSegmentedControlChange={(e) => setRunning((e.target as unknown as { value: string }).value === 'play')}>
              <CalciteSegmentedControlItem value="play" checked={running}>Play</CalciteSegmentedControlItem>
              <CalciteSegmentedControlItem value="pause" checked={!running}>Pause</CalciteSegmentedControlItem>
            </CalciteSegmentedControl>
            <CalciteLabel>Speed ×{speed}
              <CalciteSlider min={1} max={60} value={speed} onCalciteSliderChange={(e) => setSpeed((e.target as unknown as { value: number }).value)} />
            </CalciteLabel>
            <CalciteButton appearance="outline" iconStart="reset" onClick={() => { controller.reset(); rerender(); }}>
              Reset to clean state (Esc)
            </CalciteButton>
          </CalciteBlock>

          {/* Feeds */}
          <CalciteBlock heading="Feeds" open>
            {UC2_REGISTRY.feeds.map((f) => (
              <CalciteLabel key={f.source} layout="inline">
                {f.source}
                <CalciteSwitch
                  checked={controller.health[f.source]?.running}
                  onCalciteSwitchChange={(e) => { controller.toggleFeed(f.source, (e.target as unknown as { checked: boolean }).checked); rerender(); }}
                />
              </CalciteLabel>
            ))}
          </CalciteBlock>

          {/* Event injectors */}
          <CalciteBlock heading="Event injectors" open>
            <CalciteActionBar layout="horizontal" expandDisabled>
              {events.map((i) => (
                <CalciteAction key={i.id} text={i.label} textEnabled icon="lightning" onClick={() => fire(i.id)} />
              ))}
            </CalciteActionBar>
          </CalciteBlock>

          {/* Scenario triggers */}
          <CalciteBlock heading="Scenario triggers" open>
            {scenarios.map((s) => (
              <div key={s.id} style={{ marginBottom: 10 }}>
                <CalciteButton scale="s" appearance="solid" onClick={() => fire(s.id)}>
                  {s.label} {s.shortcut ? `(${s.shortcut})` : ''}
                </CalciteButton>
                {(s.params ?? []).map((p) =>
                  p.type === 'number' ? (
                    <CalciteInputNumber
                      key={p.key} scale="s" placeholder={p.label}
                      onCalciteInputNumberChange={(e) =>
                        setParams((prev) => ({ ...prev, [s.id]: { ...prev[s.id], [p.key]: Number((e.target as unknown as { value: string }).value) } }))}
                    />
                  ) : (
                    <CalciteSelect key={p.key} scale="s" label={p.label}
                      onCalciteSelectChange={(e) =>
                        setParams((prev) => ({ ...prev, [s.id]: { ...prev[s.id], [p.key]: (e.target as unknown as { value: string }).value } }))}>
                      {(p.options ?? []).map((o) => <CalciteOption key={o} value={o}>{o}</CalciteOption>)}
                    </CalciteSelect>
                  ),
                )}
              </div>
            ))}
          </CalciteBlock>

          {/* Fault injection */}
          <CalciteBlock heading="Fault injection (proves fallback)" open>
            {Object.values(controller.health).map((h) => (
              <CalciteLabel key={h.source} layout="inline">
                {h.source}
                <CalciteSegmentedControl
                  onCalciteSegmentedControlChange={(e) => { controller.injectFault(h.source, (e.target as unknown as { value: Degradation }).value); rerender(); }}>
                  <CalciteSegmentedControlItem value="GREEN" checked={h.degradation === 'GREEN'}>GREEN</CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="AMBER" checked={h.degradation === 'AMBER'}>AMBER</CalciteSegmentedControlItem>
                  <CalciteSegmentedControlItem value="RED" checked={h.degradation === 'RED'}>RED</CalciteSegmentedControlItem>
                </CalciteSegmentedControl>
              </CalciteLabel>
            ))}
          </CalciteBlock>

          {/* Cross-twin */}
          <CalciteBlock heading="Cross-twin (UC2 → UC3)" open>
            <CalciteButton iconStart="link" onClick={() => fire('crossTwinPush')}>
              Emit deferred-arrival → UC3 Trucking App
            </CalciteButton>
          </CalciteBlock>

          {/* Runbooks */}
          <CalciteBlock heading="Demo runbooks" open>
            <CalciteCombobox selectionMode="single" placeholder="Pick a runbook" clearDisabled
              onCalciteComboboxChange={(e) => {
                const id = (e.target as unknown as { value: string }).value;
                const rb = UC2_REGISTRY.runbooks.find((r) => r.id === id);
                if (rb) rb.steps.forEach((st) => fire(st.injectorId));
              }}>
              {UC2_REGISTRY.runbooks.map((r) => (
                <CalciteComboboxItem key={r.id} value={r.id} heading={`${r.label} (${r.durationLabel})`} />
              ))}
            </CalciteCombobox>
          </CalciteBlock>
        </div>
      </CalcitePanel>

      {/* Status sidebar */}
      <CalciteShellPanel slot="panel-end" widthScale="m">
        <CalcitePanel heading="Status">
          <CalciteCard>
            <div slot="heading">Live event counter</div>
            <div style={{ fontSize: 32, fontWeight: 700 }}>{controller.eventCount}</div>
            <div slot="footer-start">seed {controller.seedValue}</div>
          </CalciteCard>
          <CalciteNotice open kind="info" icon="play">
            <div slot="title">Offline-first</div>
            <div slot="message">All actions publish CloudEvents on the same topics live connectors use. Zero network.</div>
          </CalciteNotice>
          <CalciteBlock heading={`Recorder (${controller.recorder.length})`} open>
            {controller.recorder.slice(-12).map((r, i) => (
              <CalciteChip key={i} scale="s" value={r.action}>{r.action} @ {Math.round(r.atMs / 1000)}s</CalciteChip>
            ))}
          </CalciteBlock>
        </CalcitePanel>
      </CalciteShellPanel>
    </CalciteShell>
  );
}
