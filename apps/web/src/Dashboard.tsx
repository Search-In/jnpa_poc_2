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
  CalciteTabNav, CalciteTabTitle, CalciteLoader,
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

const DEMO_WINDOW = {
  from: new Date(Date.UTC(2026, 5, 15, 0, 0, 0)).toISOString(),
  to: new Date(Date.UTC(2026, 5, 17, 0, 0, 0)).toISOString(),
};

export function Dashboard() {
  const { adapter, role, setRole, lang, setLang, authReady } = useApp();
  // In live mode, panels must not fetch before the JWT lands → key on authReady.
  const facilities = useAsync<Facility[]>(() => adapter.getFacilities(role), [adapter, role, authReady]);
  const terminals = useAsync<Terminal[]>(() => adapter.getTerminals(), [adapter, authReady]);
  const gateOps = useAsync<GateOpsDTO[]>(() => adapter.getGateOps(DEMO_WINDOW), [adapter, authReady]);
  const pendency = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter, authReady]);

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

  const [mapOverlay, setMapOverlay] = useState<unknown>(null);

  return (
    <CalciteShell style={{ height: '100vh', background: tokens.color.bg }}>
      <CalciteNavigation slot="header">
        <CalciteNavigationLogo
          slot="logo"
          heading={t('appTitle', lang)}
          description={`JNPA UC2 · ${adapter.mode.toUpperCase()} mode`}
        />
        <div slot="content-end" style={{ display: 'flex', gap: 16, alignItems: 'center', paddingInline: 16 }}>
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
                flows={flows}
                scenarioOverlay={mapOverlay}
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
            <CalciteTabs layout="inline" style={{ padding: 12 }}>
              <CalciteTabNav slot="title-group">
                <CalciteTabTitle selected>Movements</CalciteTabTitle>
                <CalciteTabTitle>Rail T1/T2</CalciteTabTitle>
                <CalciteTabTitle>Gate</CalciteTabTitle>
                <CalciteTabTitle>Pendency</CalciteTabTitle>
                <CalciteTabTitle>Scan</CalciteTabTitle>
                <CalciteTabTitle>Empty</CalciteTabTitle>
                <CalciteTabTitle>Scenarios</CalciteTabTitle>
                <CalciteTabTitle>Health</CalciteTabTitle>
                <CalciteTabTitle>Notifications</CalciteTabTitle>
              </CalciteTabNav>
              <CalciteTab selected><ContainerMovements /></CalciteTab>
              <CalciteTab><RailSide window={DEMO_WINDOW} /></CalciteTab>
              <CalciteTab><GateOps window={DEMO_WINDOW} /></CalciteTab>
              <CalciteTab><Pendency /></CalciteTab>
              <CalciteTab><ScanQueue /></CalciteTab>
              <CalciteTab><EmptyPool /></CalciteTab>
              <CalciteTab><Scenarios onResult={(r) => setMapOverlay(r.mapOverlay)} /></CalciteTab>
              <CalciteTab><HealthCards /></CalciteTab>
              <CalciteTab><Notifications /></CalciteTab>
            </CalciteTabs>
          </div>
        )}
      </CalcitePanel>
    </CalciteShell>
  );
}
