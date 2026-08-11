/**
 * DTCCC Cargo dashboard shell (prompt §10) — the ArcGIS map is the anchor;
 * Calcite panels (KPI strip, movements, pendency, rail, gate, scan, empty,
 * health, notifications, scenarios) are composed around it. Role + language
 * selectors in the shell drive RBAC scoping and i18n.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalciteShell, CalciteShellPanel, CalcitePanel, CalciteNavigation, CalciteNavigationLogo,
  CalciteLabel, CalciteSelect, CalciteOption, CalciteChip, CalciteTabs, CalciteTab,
  CalciteTabNav, CalciteTabTitle, CalciteLoader, CalciteButton, CalciteSegmentedControl,
  CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import type { Role, Facility, Terminal, IntegrationHealth } from '@jnpa/schemas';
import { ROLES } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { useApp, CARGO_SOURCE } from './state/AppContext.js';
import { useAsync } from './state/useAsync.js';
import { boardSummary, screenProvenance } from './state/provenance.js';
import { authEnabled, getUsername, logout } from './auth/session.js';
import { cargoTokenStore } from './state/cargoTokenStore.js';
import { PortMap } from './map/PortMap.js';
import { PortScene, type PortSceneHandle, type CameraPreset, type Lighting } from './map/PortScene.js';
import { AssetExplorer } from './map/AssetExplorer.js';
import { AssetTransform } from './map/AssetTransform.js';
import { placementStore, downloadPlacements, importPlacements } from './map/placementStore.js';
import { tokens } from './theme/tokens.js';
import { t, type Lang } from './i18n/strings.js';
import { KpiStrip } from './panels/KpiStrip.js';
import { ContainerMovements } from './panels/ContainerMovements.js';
import { ExportList } from './panels/ExportList.js';
import { ImportList } from './panels/ImportList.js';
import { Pendency } from './panels/Pendency.js';
import { RailSide } from './panels/RailSide.js';
import { Itrho } from './panels/Itrho.js';
import { GateOps } from './panels/GateOps.js';
import { EmptyPool } from './panels/EmptyPool.js';
import { CfsEcy } from './panels/CfsEcy.js';
import { HealthCards } from './panels/HealthCards.js';
import { DataQuality } from './panels/DataQuality.js';
import { JnpaApiFeed, JNPA_FEED_ENABLED } from './panels/JnpaApiFeed.js';
import { Notifications } from './panels/Notifications.js';
import { Scenarios } from './panels/Scenarios.js';
import { MethodologyPanel } from './panels/MethodologyPanel.js';
import { ModelCards } from './panels/ModelCards.js';
import { WorkflowRuns } from './workflow/WorkflowRuns.js';
import { ReactiveGuide } from './whatif/ReactiveGuide.js';
import { useSimStore, hasSimOverrides, useSimDep } from './sim/useSimStore.js';
import { applyFlows } from './sim/applySim.js';
import { navigate } from './sim/useHashRoute.js';
import { GuidedTour } from './sim/GuidedTour.js';
import { simStore } from './sim/simStore.js';
import { getScript, type TabId } from './sim/scenarioPlayer.js';
import { IntegrationConsole } from './console/IntegrationConsole.js';
import { faultStore } from './console/faultStore.js';
import { useFaultStore, useFaultDep } from './console/useFaultStore.js';
import { DataSourceToggle } from './components/DataSourceToggle.js';
import { TABS, ROLE_TAB_IDS } from './tabs.js';
import { ProvenanceBanner } from './panels/ProvenanceBanner.js';

const DEMO_WINDOW = {
  from: new Date(Date.UTC(2026, 5, 15, 0, 0, 0)).toISOString(),
  to: new Date(Date.UTC(2026, 5, 17, 0, 0, 0)).toISOString(),
};

export function Dashboard() {
  const { adapter, role, setRole, lang, setLang, authReady } = useApp();
  // Live-data simulator state. `tick` advances while the sim clock runs; keying
  // the data fetches on it makes every panel + the map refetch (through the
  // SimAdapter overlay) so the board updates in real time.
  const sim = useSimStore();
  // simDep changes on every tick AND on every manual lever change (even while
  // paused), so the map's gate/pendency data refetches through the SimAdapter.
  const simDep = useSimDep();
  // Any injected integration fault → the DATA_MODE chip flips to a degraded look.
  const faults = useFaultStore();
  const faultDep = useFaultDep();
  const faulted = faultStore.anyFaulted(faults);
  // UC2-064 — what is ACTUALLY serving each screen, for the banner under the tab
  // bar and the header chip. The connector probe is the same six /health calls
  // the Integration tab makes; it is done at shell level so every screen can
  // state its own source, not only the one that happens to be open.
  const health = useAsync<IntegrationHealth[]>(
    () => adapter.getIntegrationHealth(), [adapter, authReady, faultDep],
  );
  const provenanceCtx = {
    cargoSource: CARGO_SOURCE,
    baseMode: adapter.mode,
    // null until the probe lands — never optimistically "live".
    connectorsLive: health.loading
      ? null
      : (health.data ?? []).some((h) => h.source === 'CONNECTOR'),
  };
  const board = boardSummary(screenProvenance(provenanceCtx));
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
  // During a guided What-If tour the step's explicit spotlight wins (it may
  // include terminals/facilities the levers don't key on); otherwise fall back
  // to whatever the manual simulator is driving.
  const highlights = useMemo(
    () =>
      sim.tour.scenarioId
        ? sim.highlights
        : // Outside a guided tour, surface explicit spotlights (e.g. an Empty Pool
          // row click via simStore.setHighlights) alongside whatever the manual
          // simulator is driving, so panel row → map focus reuses the same halo.
          [...new Set([...sim.highlights, ...Object.keys(sim.gates), ...Object.keys(sim.pendency)])],
    [sim.tour.scenarioId, sim.highlights, sim.gates, sim.pendency],
  );

  const [mapOverlay, setMapOverlay] = useState<unknown>(null);
  // Lands on the inbound leg — the first stop in the lifecycle and the tab that
  // now carries the per-container chain view.
  const [activeTab, setActiveTab] = useState<string>('import');
  // A sub-view a guided-tour step asked for inside Import/Export (see
  // ScenarioStep.view). Bumped with a nonce so re-selecting the same view on a
  // later step still re-applies it; the panels treat it as "jump here now",
  // not as a controlled value, so the user stays free to navigate afterwards.
  const [tourView, setTourView] = useState<{ view: string; nonce: number } | null>(null);
  const goToTab = (tab: TabId, view?: string) => {
    setActiveTab(tab);
    setTourView(view ? { view, nonce: Date.now() } : null);
  };
  // Whether the What-If coach-mark is minimised — the Reactive Guide only shows
  // when it is, so the two floating panels never overlap during a scenario.
  const [coachCollapsed, setCoachCollapsed] = useState(false);
  // UI-only tab visibility for the current role (see ROLE_TAB_IDS).
  const canSeeTab = (id: TabId) => ROLE_TAB_IDS[role].includes(id);
  const visibleTabs = useMemo(() => TABS.filter((tb) => ROLE_TAB_IDS[role].includes(tb.id)), [role]);
  // If the active tab isn't visible for this role (e.g. after switching role),
  // fall back to the first visible tab.
  useEffect(() => {
    if (!visibleTabs.some((tb) => tb.id === activeTab)) {
      setActiveTab(visibleTabs[0]?.id ?? 'movements');
    }
  }, [visibleTabs, activeTab]);
  // Anchor-map view mode: flat 2D MapView vs. the new 3D SceneView sea-port.
  const [mapMode, setMapMode] = useState<'2d' | '3d'>('2d');
  // Asset selected in the 3D scene / explorer tree (kept in sync both ways).
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  // The selected asset's placement key (the movable ones: vessel/crane/gate/yard).
  const [selectedPkey, setSelectedPkey] = useState<string | null>(null);
  const sceneRef = useRef<PortSceneHandle | null>(null);
  // Placement edit mode: pick an asset in the tree, then click the map to place it.
  const [editingPlacement, setEditingPlacement] = useState(false);
  // 3D cinematic controls: current lighting (day/dusk) for the day/dusk toggle.
  const [lighting, setLighting] = useState<Lighting>('day');
  // Route-draw mode: the `truckroute:<T>` key currently being traced (null = off).
  const [drawRouteKey, setDrawRouteKey] = useState<string | null>(null);
  // Seeded from data/positions.json, so Export/Reset are live from first render.
  const [placementCount, setPlacementCount] = useState(() => placementStore.count());

  // Sign-out affordance. Rendered ONLY when the sign-in gate is on
  // (VITE_AUTH_ENABLED) — with it off there is no session to end and the header
  // is exactly as it was for the credential-free mock demo. The account name is
  // read once on mount; it cannot change without a sign-out.
  const signedInAs = useMemo(() => (authEnabled() ? getUsername() : null), []);
  const signOut = () => {
    // Drop the in-memory POC-3 bearer first so nothing can present it during
    // tear-down, then hand off to the shared auth module: it clears the stored
    // session (jnpa_uc3_*) and reloads at '/', which rebuilds AuthGate with no
    // token — so the login screen is the only thing that can render.
    cargoTokenStore.setToken(undefined);
    logout();
  };

  // Demo convenience: `?scenario=CGO-2` (or &auto=0 to pause, &step=N to jump to
  // a step) auto-starts a guided What-If tour on load, so a single link can open
  // straight into it.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get('scenario');
    if (id && getScript(id) && simStore.getState().tour.scenarioId == null) {
      const auto = q.get('auto') !== '0';
      simStore.startScenario(id, auto);
      const step = Number(q.get('step'));
      if (Number.isFinite(step) && step > 0) simStore.gotoStep(step);
    }
  }, []);

  return (
    <>
    <CalciteShell style={{ height: '100vh', background: tokens.color.bg }}>
      <CalciteNavigation slot="header">
        <CalciteNavigationLogo
          slot="logo"
          heading={t('appTitle', lang)}
          description={`JNPA UC2 · ${adapter.mode.toUpperCase()} mode`}
        />
        <div slot="content-end" style={{ display: 'flex', gap: 16, alignItems: 'center', paddingInline: 16 }}>
          {/* Data-SOURCE toggle (LIVE JNPA-API rows | DEMO pre-loaded rows). Injects
              the X-Data-Mode header on every cargo request; separate from DATA_MODE. */}
          <DataSourceToggle />
          {hasSimOverrides(sim) && (
            <CalciteChip value="sim" kind="brand" icon={sim.running ? 'play-f' : 'pause-f'}>
              SIM {sim.running ? 'LIVE' : 'PAUSED'}
            </CalciteChip>
          )}
          <CalciteButton appearance="outline" iconStart="play" scale="s" onClick={() => navigate('/simulator')}>
            Simulator
          </CalciteButton>
          {/* Provenance chip (Integrity Rule §1, UC2-064).
              It used to render `adapter.mode` — one word for the whole board —
              which is wrong on every screen, because the board is genuinely
              mixed: the base adapter is the simulator while cargo, customs and
              the export chain come from POC-3's ingested corpus. It now reports
              the MIXTURE, and the banner under the tab bar says what the screen
              you are actually looking at is. Clicking still opens the
              Integration Console (per-source LIVE/DEGRADED/OFFLINE). */}
          <CalciteChip
            value={board.label}
            kind={board.label === 'LIVE' ? 'brand' : faulted ? 'inverse' : 'neutral'}
            icon={board.label === 'LIVE' ? 'lightning' : faulted ? 'exclamation-mark-triangle' : 'play'}
            style={{ cursor: 'pointer' }}
            title={`${board.detail} Click to open the Integration Console.`}
            onClick={() => faultStore.setOpen(true)}
          >
            {board.label}{faulted ? ' · DEGRADED' : ''} · {board.real}/{board.real + board.mixed + board.simulated} real
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
          {/* Sign out — the only authenticated-session control in the shell.
              Hidden entirely when VITE_AUTH_ENABLED is off (no session exists). */}
          {authEnabled() && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {signedInAs && (
                <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{signedInAs}</span>
              )}
              <CalciteButton
                appearance="outline"
                kind="neutral"
                iconStart="sign-out"
                scale="s"
                onClick={signOut}
                title="Sign out and return to the sign-in screen"
              >
                Sign out
              </CalciteButton>
            </div>
          )}
        </div>
      </CalciteNavigation>

      {/* Left: the map is the anchor. A 2D/3D toggle flips it between the flat
          MapView and the georeferenced 3D SceneView sea-port. In 3D mode an
          asset-explorer tree rides alongside so operators can pick berths,
          cranes, gates and yard blocks and fly the camera to them. */}
      {/* Map panel. Calcite caps the drag range of the panel-start ↔ KPI
          splitter via --calcite-shell-panel-max-width (default ~40vw for scale
          "l"); raise it to 90vw so the map can be dragged out to fill most of
          the window, and set a sensible starting/min width. */}
      <CalciteShellPanel
        slot="panel-start"
        widthScale="l"
        resizable
        style={{
          '--calcite-shell-panel-min-width': '320px',
          '--calcite-shell-panel-width': '40vw',
          '--calcite-shell-panel-max-width': '90vw',
        } as React.CSSProperties}
      >
        <CalcitePanel heading={mapMode === '3d' ? `${t('panel_map', lang)} · 3D` : t('panel_map', lang)}>
          <div slot="header-actions-end" style={{ display: 'flex', gap: 8, alignItems: 'center', paddingInline: 8 }}>
            {/* Placement editor (3D only): toggle edit mode, then drag assets to
                their real spot and export the corrected positions.json. */}
            {mapMode === '3d' && (
              <>
                <CalciteButton
                  scale="s"
                  appearance={editingPlacement ? 'solid' : 'outline'}
                  kind={editingPlacement ? 'brand' : 'neutral'}
                  iconStart={editingPlacement ? 'check' : 'pencil'}
                  onClick={() => setEditingPlacement((v) => { if (v) setDrawRouteKey(null); return !v; })}
                  title="Pick an asset in the left tree, then click the map to place it"
                >
                  {editingPlacement
                    ? selectedPkey
                      ? `Click map to place ${selectedAsset ?? ''}`
                      : 'Editing — pick an asset in the tree'
                    : 'Edit placement'}
                </CalciteButton>
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="download"
                  disabled={placementCount === 0}
                  onClick={() => downloadPlacements('JNPA 3D asset placements')}
                  title="Download positions.json (commit it to data/positions.json to make it permanent)"
                >
                  Export{placementCount ? ` (${placementCount})` : ''}
                </CalciteButton>
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="upload"
                  onClick={() => {
                    void importPlacements()
                      .then((n) => {
                        sceneRef.current?.rebuild();
                        setPlacementCount(placementStore.count());
                        // eslint-disable-next-line no-console
                        console.info(`Imported ${n} placements`);
                      })
                      .catch(() => {
                        /* user cancelled or invalid file — no-op */
                      });
                  }}
                  title="Upload a positions.json to preview it live (then Export + commit to make it permanent)"
                >
                  Import
                </CalciteButton>
                {placementCount > 0 && (
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="danger"
                    iconStart="reset"
                    onClick={() => { placementStore.clear(); sceneRef.current?.rebuild(); setPlacementCount(placementStore.count()); }}
                    title="Revert to the seeded placements (data/positions.json)"
                  >
                    Reset
                  </CalciteButton>
                )}
                {/* Day / dusk lighting toggle — repositions the sun in the scene. */}
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart={lighting === 'day' ? 'brightness' : 'moon'}
                  onClick={() => {
                    const next: Lighting = lighting === 'day' ? 'dusk' : 'day';
                    setLighting(next);
                    sceneRef.current?.setLighting(next);
                  }}
                  title="Toggle day / dusk lighting"
                >
                  {lighting === 'day' ? 'Dusk' : 'Day'}
                </CalciteButton>
              </>
            )}
            <CalciteSegmentedControl
              width="auto"
              scale="s"
              onCalciteSegmentedControlChange={(e) =>
                setMapMode(((e.target as unknown as { value: '2d' | '3d' }).value) === '3d' ? '3d' : '2d')
              }
            >
              <CalciteSegmentedControlItem value="2d" checked={mapMode === '2d'} iconStart="map">2D</CalciteSegmentedControlItem>
              <CalciteSegmentedControlItem value="3d" checked={mapMode === '3d'} iconStart="urban-model">3D</CalciteSegmentedControlItem>
            </CalciteSegmentedControl>
          </div>

          <div style={{ height: 'calc(100vh - 120px)', display: 'flex' }}>
            {facilities.data && terminals.data && gateOps.data && pendency.data ? (
              mapMode === '3d' ? (
                <>
                  <div style={{ width: 260, flexShrink: 0, borderRight: `1px solid ${tokens.color.border}`, overflow: 'hidden' }}>
                    <AssetExplorer
                      terminals={terminals.data}
                      facilities={facilities.data}
                      gateOps={gateOps.data}
                      pendency={pendency.data}
                      selectedId={selectedAsset}
                      onSelect={(id, pkey) => {
                        setSelectedAsset(id);
                        setSelectedPkey(pkey ?? null);
                        // Leaving the route we were drawing → exit draw mode.
                        setDrawRouteKey((k) => (k && k !== pkey ? null : k));
                        sceneRef.current?.focus(id);
                      }}
                      // Closing a focused yard clears the selection and lets the
                      // 3D scene glide the camera back to where it was.
                      onClearFocus={() => {
                        sceneRef.current?.clearSelection();
                        setSelectedAsset(null);
                        setSelectedPkey(null);
                      }}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                    <PortScene
                      ref={sceneRef}
                      facilities={facilities.data}
                      terminals={terminals.data}
                      gateOps={gateOps.data}
                      pendency={pendency.data}
                      highlights={highlights}
                      onSelect={(id, pkey) => {
                        // Clicking an asset on the map selects it AND, if it's a
                        // movable asset, opens its transform editor (turns Edit on)
                        // — so you can edit directly without the side tree.
                        setSelectedAsset(id);
                        setSelectedPkey(pkey ?? null);
                        if (pkey) setEditingPlacement(true);
                        // Leaving the route we were drawing → exit draw mode.
                        setDrawRouteKey((k) => (k && k !== pkey ? null : k));
                      }}
                      editing={editingPlacement}
                      movePkey={selectedPkey}
                      drawRouteKey={drawRouteKey}
                      onPlacementsChanged={() => setPlacementCount(placementStore.count())}
                    />
                    {/* Move & rotate controls — in Edit mode, once an asset is
                        picked, rotate it (heading) and nudge it N/S/E/W. Edits
                        persist (localStorage) and export to positions.json. */}
                    {editingPlacement && selectedPkey && (
                      <AssetTransform
                        pkey={selectedPkey}
                        label={selectedAsset}
                        terminals={terminals.data}
                        drawing={drawRouteKey === selectedPkey}
                        onToggleDraw={() =>
                          setDrawRouteKey((k) => (k === selectedPkey ? null : selectedPkey))
                        }
                        onRouteEdited={() => {
                          // Undo/Clear changed the path → redraw preview + trucks.
                          sceneRef.current?.refreshRouteDraw();
                          sceneRef.current?.rebuildOne(selectedPkey);
                          setPlacementCount(placementStore.count());
                        }}
                        onChange={(pkey) => {
                          // Rebuild ONLY this asset's layer → the move/rotate shows
                          // on the map instantly; the store write already happened
                          // synchronously (that's the export data).
                          sceneRef.current?.rebuildOne(pkey);
                          setPlacementCount(placementStore.count());
                        }}
                      />
                    )}
                    {/* Cinematic camera presets — fly the SceneView to framed
                        viewpoints (each computed from real terminal geography). */}
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 12,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        display: 'flex',
                        gap: 4,
                        background: tokens.color.bgPanel,
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: 6,
                        padding: 4,
                        boxShadow: '0 2px 8px rgba(0,0,0,.12)',
                        zIndex: 5,
                      }}
                    >
                      {([
                        ['overview', 'Overview', 'extent'],
                        ['channel', 'Channel', 'water'],
                        ['gate', 'Gate', 'car'],
                        ['rail', 'Rail', 'train'],
                        ['crane', 'Cranes', 'organization'],
                      ] as [CameraPreset, string, string][]).map(([id, label, icon]) => (
                        <CalciteButton
                          key={id}
                          scale="s"
                          appearance="outline"
                          iconStart={icon}
                          onClick={() => sceneRef.current?.goToPreset(id)}
                          title={`Fly to ${label}`}
                        >
                          {label}
                        </CalciteButton>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <PortMap
                    facilities={facilities.data}
                    terminals={terminals.data}
                    gateOps={gateOps.data}
                    pendency={pendency.data}
                    flows={liveFlows}
                    scenarioOverlay={mapOverlay}
                    highlights={highlights}
                  />
                </div>
              )
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
          <div key={role} data-tour-panels>
            <div style={{ padding: 12 }} data-tour-tab="kpis">
              <KpiStrip />
            </div>
            {/* UC2-064 — what is serving THIS screen, above the tabs so a panel
                added later cannot forget to declare itself. */}
            <ProvenanceBanner activeTab={activeTab as TabId} ctx={provenanceCtx} />
            {/* Controlled tabs: the active tab lives in React state (`activeTab`)
                and is re-asserted via the `selected`/`tab` linkage on every
                render. Without this, each sim-tick re-render would reset the
                uncontrolled selection back to the first tab. */}
            <CalciteTabs layout="inline" style={{ padding: 12 }}>
              <CalciteTabNav slot="title-group">
                {visibleTabs.map((tb) => (
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
              {/* UI-only: each panel renders only when the role may see its tab
                  (ROLE_TAB_IDS). Data behind each panel is unchanged/role-scoped. */}
              {canSeeTab('movements') && <CalciteTab tab="movements" selected={activeTab === 'movements'}><div data-tour-tab="movements"><ContainerMovements /></div></CalciteTab>}
              {canSeeTab('rail') && <CalciteTab tab="rail" selected={activeTab === 'rail'}><div data-tour-tab="rail"><RailSide window={DEMO_WINDOW} /></div></CalciteTab>}
              {canSeeTab('itrho') && <CalciteTab tab="itrho" selected={activeTab === 'itrho'}><div data-tour-tab="itrho"><Itrho window={DEMO_WINDOW} /></div></CalciteTab>}
              {canSeeTab('gate') && <CalciteTab tab="gate" selected={activeTab === 'gate'}><div data-tour-tab="gate"><GateOps window={DEMO_WINDOW} /></div></CalciteTab>}
              {canSeeTab('pendency') && <CalciteTab tab="pendency" selected={activeTab === 'pendency'}><div data-tour-tab="pendency"><Pendency /></div></CalciteTab>}
              {canSeeTab('empty') && <CalciteTab tab="empty" selected={activeTab === 'empty'}><div data-tour-tab="empty"><EmptyPool /></div></CalciteTab>}
              {/* The two lifecycle spines. `onOpenTab` lets a step on the strip
                  jump to the tab that holds its register (e.g. Shipping Bill →
                  Customs), so the chain stays navigable across tabs. */}
              {canSeeTab('import') && <CalciteTab tab="import" selected={activeTab === 'import'}><div data-tour-tab="import"><ImportList onOpenTab={setActiveTab} jumpToView={tourView} /></div></CalciteTab>}
              {canSeeTab('export') && <CalciteTab tab="export" selected={activeTab === 'export'}><div data-tour-tab="export"><ExportList onOpenTab={setActiveTab} jumpToView={tourView} /></div></CalciteTab>}
              {canSeeTab('cfsecy') && <CalciteTab tab="cfsecy" selected={activeTab === 'cfsecy'}><div data-tour-tab="cfsecy"><CfsEcy /></div></CalciteTab>}
              {canSeeTab('scenarios') && <CalciteTab tab="scenarios" selected={activeTab === 'scenarios'}><div data-tour-tab="scenarios"><Scenarios onResult={(r) => setMapOverlay(r.mapOverlay)} /></div></CalciteTab>}
              {canSeeTab('workflows') && <CalciteTab tab="workflows" selected={activeTab === 'workflows'}><div data-tour-tab="workflows"><WorkflowRuns /></div></CalciteTab>}
              {canSeeTab('models') && <CalciteTab tab="models" selected={activeTab === 'models'}><div data-tour-tab="models"><ModelCards /></div></CalciteTab>}
              {/* The real external feed sits ABOVE the simulated adapters, so the
                  tab never implies that everything on it is equally live. Gated
                  HERE rather than inside the panel so a hidden card issues no
                  requests at all — its three health calls would otherwise fire on
                  every visit to this tab. Off unless VITE_SHOW_JNPA_FEED says otherwise. */}
              {canSeeTab('health') && <CalciteTab tab="health" selected={activeTab === 'health'}><div data-tour-tab="health">{JNPA_FEED_ENABLED && <JnpaApiFeed />}<HealthCards /></div></CalciteTab>}
              {canSeeTab('dataquality') && <CalciteTab tab="dataquality" selected={activeTab === 'dataquality'}><div data-tour-tab="dataquality"><DataQuality /></div></CalciteTab>}
              {canSeeTab('notifications') && <CalciteTab tab="notifications" selected={activeTab === 'notifications'}><div data-tour-tab="notifications"><Notifications /></div></CalciteTab>}
              {canSeeTab('methodology') && <CalciteTab tab="methodology" selected={activeTab === 'methodology'}><div data-tour-tab="methodology"><MethodologyPanel /></div></CalciteTab>}
            </CalciteTabs>
          </div>
        )}
      </CalcitePanel>
    </CalciteShell>
    {/* Guided What-If tour overlay — narrates a scenario as it drives the board.
        Switches the active tab per step so the spotlight lands on the right panel. */}
    <GuidedTour onTab={goToTab} onCollapsedChange={setCoachCollapsed} />
    {/* Reactive Guide (§8.1, crit 5) — the causal WHICH/WHERE/HOW/WHY panel that
        rides alongside a running scenario; hovering a WHERE node re-rings its
        geography on the map via setHighlights. */}
    <ReactiveGuide onSpotlight={(ids) => simStore.setHighlights(ids)} coachCollapsed={coachCollapsed} />
    {/* Integration Simulator Console (§6) — slide-over opened by the DATA_MODE
        chip; injects per-source faults the whole board reacts to. */}
    <IntegrationConsole />
    </>
  );
}
