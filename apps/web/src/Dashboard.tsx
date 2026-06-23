/**
 * DTCCC Cargo dashboard shell (prompt §10) — the ArcGIS map is the anchor;
 * Calcite panels (KPI strip, movements, pendency, rail, gate, scan, empty,
 * health, notifications, scenarios) are composed around it. Role + language
 * selectors in the shell drive RBAC scoping and i18n.
 */
import { useMemo, useState } from 'react';
import {
  CalciteShell, CalciteShellPanel, CalcitePanel, CalciteNavigation, CalciteNavigationLogo,
  CalciteLabel, CalciteSelect, CalciteOption, CalciteChip, CalciteTabs, CalciteTab,
  CalciteTabNav, CalciteTabTitle, CalciteLoader, CalciteButton,
} from '@esri/calcite-components-react';
import type { Role, Facility, Terminal } from '@jnpa/schemas';
import { ROLES } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { useApp } from './state/AppContext.js';
import { useAsync } from './state/useAsync.js';
import { PortMap } from './map/PortMap.js';
import { tokens } from './theme/tokens.js';
import { t, type Lang } from './i18n/strings.js';
import { KpiStrip } from './panels/KpiStrip.js';
import { ContainerMovements } from './panels/ContainerMovements.js';
import { Pendency } from './panels/Pendency.js';
import { RailSide } from './panels/RailSide.js';
import { GateOps } from './panels/GateOps.js';
import { ScanQueue } from './panels/ScanQueue.js';
import { EmptyPool } from './panels/EmptyPool.js';
import { HealthCards } from './panels/HealthCards.js';
import { Notifications } from './panels/Notifications.js';
import { Scenarios } from './panels/Scenarios.js';
import { useSimStore, hasSimOverrides, useSimDep } from './sim/useSimStore.js';
import { applyFlows } from './sim/applySim.js';
import { navigate } from './sim/useHashRoute.js';

const DEMO_WINDOW = {
  from: new Date(Date.UTC(2026, 5, 15, 0, 0, 0)).toISOString(),
  to: new Date(Date.UTC(2026, 5, 17, 0, 0, 0)).toISOString(),
};

/** Stable tab ids ↔ labels; ids drive the controlled tab selection. */
const TABS = [
  { id: 'movements', label: 'Movements' },
  { id: 'rail', label: 'Rail T1/T2' },
  { id: 'gate', label: 'Gate' },
  { id: 'pendency', label: 'Pendency' },
  { id: 'scan', label: 'Scan' },
  { id: 'empty', label: 'Empty' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'health', label: 'Health' },
  { id: 'notifications', label: 'Notifications' },
] as const;

export function Dashboard() {
  const { adapter, role, setRole, lang, setLang, authReady } = useApp();
  // Live-data simulator state. `tick` advances while the sim clock runs; keying
  // the data fetches on it makes every panel + the map refetch (through the
  // SimAdapter overlay) so the board updates in real time.
  const sim = useSimStore();
  // simDep changes on every tick AND on every manual lever change (even while
  // paused), so the map's gate/pendency data refetches through the SimAdapter.
  const simDep = useSimDep();
  // In live mode, panels must not fetch before the JWT lands → key on authReady.
  const facilities = useAsync<Facility[]>(() => adapter.getFacilities(role), [adapter, role, authReady]);
  const terminals = useAsync<Terminal[]>(() => adapter.getTerminals(), [adapter, authReady]);
  const gateOps = useAsync<GateOpsDTO[]>(() => adapter.getGateOps(DEMO_WINDOW), [adapter, authReady, simDep]);
  const pendency = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter, authReady, simDep]);

  // Derive cargo OD flows between terminals for the map (import/export/transship/ITRHO).
  const flows = useMemo(() => {
    const terms = terminals.data ?? [];
    if (terms.length < 2) return [];
    const streams: Array<keyof typeof tokens.flow> = ['IMPORT', 'EXPORT', 'TRANSSHIP', 'ITRHO'];
    const out: Array<{ from: string; to: string; stream: keyof typeof tokens.flow; count: number }> = [];
    streams.forEach((stream, i) => {
      const from = terms[i % terms.length]!.terminalId;
      const to = terms[(i + 1) % terms.length]!.terminalId;
      out.push({ from, to, stream, count: 20 + i * 15 });
    });
    return out;
  }, [terminals.data]);

  // Scale flow thickness/counts by the simulator's movement rate.
  const liveFlows = useMemo(() => applyFlows(flows, sim), [flows, sim.movementRate]);

  // Assets the simulator is driving → drawn with a highlight halo on the map.
  const highlights = useMemo(
    () => [...new Set([...Object.keys(sim.gates), ...Object.keys(sim.pendency)])],
    [sim.gates, sim.pendency],
  );

  const [mapOverlay, setMapOverlay] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<string>('movements');

  return (
    <CalciteShell style={{ height: '100vh', background: tokens.color.bg }}>
      <CalciteNavigation slot="header">
        <CalciteNavigationLogo
          slot="logo"
          heading={t('appTitle', lang)}
          description={`JNPA UC2 · ${adapter.mode.toUpperCase()} mode`}
        />
        <div slot="content-end" style={{ display: 'flex', gap: 16, alignItems: 'center', paddingInline: 16 }}>
          {hasSimOverrides(sim) && (
            <CalciteChip value="sim" kind="brand" icon={sim.running ? 'play-f' : 'pause-f'}>
              SIM {sim.running ? 'LIVE' : 'PAUSED'}
            </CalciteChip>
          )}
          <CalciteButton appearance="outline" iconStart="play" scale="s" onClick={() => navigate('/simulator')}>
            Simulator
          </CalciteButton>
          <CalciteChip
            value={adapter.mode}
            kind={adapter.mode === 'live' ? 'brand' : 'neutral'}
            icon={adapter.mode === 'live' ? 'lightning' : 'play'}
          >
            {adapter.mode === 'live' ? 'LIVE' : 'MOCK / OFFLINE'}
          </CalciteChip>
          <CalciteLabel layout="inline">
            {t('role', lang)}
            <CalciteSelect label="role" onCalciteSelectChange={(e) => setRole((e.target as unknown as { value: Role }).value)}>
              {ROLES.map((r) => (
                <CalciteOption key={r} value={r} selected={r === role}>{r}</CalciteOption>
              ))}
            </CalciteSelect>
          </CalciteLabel>
          <CalciteLabel layout="inline">
            {t('language', lang)}
            <CalciteSelect label="language" onCalciteSelectChange={(e) => setLang((e.target as unknown as { value: Lang }).value)}>
              <CalciteOption value="en" selected={lang === 'en'}>English</CalciteOption>
              <CalciteOption value="hi" selected={lang === 'hi'}>हिन्दी</CalciteOption>
              <CalciteOption value="mr" selected={lang === 'mr'}>मराठी</CalciteOption>
            </CalciteSelect>
          </CalciteLabel>
        </div>
      </CalciteNavigation>

      {/* Left: the map is the anchor */}
      <CalciteShellPanel slot="panel-start" widthScale="l" resizable>
        <CalcitePanel heading={t('panel_map', lang)}>
          <div style={{ height: 'calc(100vh - 120px)' }}>
            {facilities.data && terminals.data && gateOps.data && pendency.data ? (
              <PortMap
                facilities={facilities.data}
                terminals={terminals.data}
                gateOps={gateOps.data}
                pendency={pendency.data}
                flows={liveFlows}
                scenarioOverlay={mapOverlay}
                highlights={highlights}
              />
            ) : null}
          </div>
        </CalcitePanel>
      </CalciteShellPanel>

      {/* Center/right: KPI strip + tabbed panels. Keyed on role so every panel
          re-mounts (and refetches with the new RBAC token) when the role changes;
          gated on authReady so live mode never fetches before the JWT lands. */}
      <CalcitePanel>
        {!authReady ? (
          <CalciteLoader label="Authenticating" text="Authenticating with gateway…" />
        ) : (
          <div key={role}>
            <div style={{ padding: 12 }}>
              <KpiStrip />
            </div>
            {/* Controlled tabs: the active tab lives in React state (`activeTab`)
                and is re-asserted via the `selected`/`tab` linkage on every
                render. Without this, each sim-tick re-render would reset the
                uncontrolled selection back to the first tab. */}
            <CalciteTabs layout="inline" style={{ padding: 12 }}>
              <CalciteTabNav slot="title-group">
                {TABS.map((tb) => (
                  <CalciteTabTitle
                    key={tb.id}
                    tab={tb.id}
                    selected={activeTab === tb.id}
                    onCalciteTabsActivate={() => setActiveTab(tb.id)}
                  >
                    {tb.label}
                  </CalciteTabTitle>
                ))}
              </CalciteTabNav>
              <CalciteTab tab="movements" selected={activeTab === 'movements'}><ContainerMovements /></CalciteTab>
              <CalciteTab tab="rail" selected={activeTab === 'rail'}><RailSide window={DEMO_WINDOW} /></CalciteTab>
              <CalciteTab tab="gate" selected={activeTab === 'gate'}><GateOps window={DEMO_WINDOW} /></CalciteTab>
              <CalciteTab tab="pendency" selected={activeTab === 'pendency'}><Pendency /></CalciteTab>
              <CalciteTab tab="scan" selected={activeTab === 'scan'}><ScanQueue /></CalciteTab>
              <CalciteTab tab="empty" selected={activeTab === 'empty'}><EmptyPool /></CalciteTab>
              <CalciteTab tab="scenarios" selected={activeTab === 'scenarios'}><Scenarios onResult={(r) => setMapOverlay(r.mapOverlay)} /></CalciteTab>
              <CalciteTab tab="health" selected={activeTab === 'health'}><HealthCards /></CalciteTab>
              <CalciteTab tab="notifications" selected={activeTab === 'notifications'}><Notifications /></CalciteTab>
            </CalciteTabs>
          </div>
        )}
      </CalcitePanel>
    </CalciteShell>
  );
}
