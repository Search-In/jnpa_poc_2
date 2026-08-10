/**
 * App-wide context: the data adapter (mock|live), current RBAC role, and UI
 * language. The whole dashboard binds ONLY to the adapter (prompt §5).
 *
 * In live mode the LiveAdapter calls the gateway BFF via the Vite `/gateway`
 * proxy and authenticates with a JWT. The token is minted from the gateway's
 * dev-token endpoint for the selected role and re-minted when the role changes
 * (RBAC is claim-based, so the role lives in the token). A ref keeps the
 * adapter's getToken() reading the latest token without rebuilding the adapter.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { DataAdapter, ReferenceCargoOverride } from '@jnpa/data';
import {
  AiForecastAdapter, ConnectorAdapter, LiveAdapter, MockAdapter, Poc3CargoAdapter, ReferenceCargoAdapter,
} from '@jnpa/data';
import type { Role } from '@jnpa/schemas';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../../config/terminals.json';
import baselinesConfig from '../../../../config/baselines.json';
import type { Lang } from '../i18n/strings.js';
import { SimAdapter } from '../sim/SimAdapter.js';
import { cargoRefreshStore } from './cargoRefreshStore.js';
import { cargoTokenStore } from './cargoTokenStore.js';
import { getDataSourceMode } from './dataSourceMode.js';
import { getToken as getSessionToken } from '../auth/session.js';

interface AppState {
  adapter: DataAdapter;
  role: Role;
  setRole: (r: Role) => void;
  lang: Lang;
  setLang: (l: Lang) => void;
  /** True until the live token is fetched (mock mode is always ready). */
  authReady: boolean;
}

const AppContext = createContext<AppState | null>(null);

const MODE = (import.meta.env?.VITE_DATA_MODE as 'mock' | 'live') ?? 'mock';
const GATEWAY_BASE = '/gateway';

// POC-3 shared Cargo API. Cargo is re-sourced from POC-3 (the single common
// backend); every other panel stays on the mock/live base adapter. In dev the
// browser hits the relative `/poc3` path (Vite proxies it to the POC-3 gateway,
// avoiding CORS); set VITE_CARGO_API_BASE to the gateway origin for a deployed
// build. Set VITE_CARGO_SOURCE=mock to opt out and keep cargo on the simulator.
export const CARGO_API_BASE = (import.meta.env?.VITE_CARGO_API_BASE as string | undefined) || '/poc3';
// Cargo source, cargo-only (never changes the base adapter or non-cargo panels):
//   'poc3'      (default) — wrap cargo with the POC-3 client.
//   'mock'      — keep cargo on the synthetic simulator (pure base adapter).
//   'reference' — layer a cargo-only decorator that serves container movements
//                 from the JNPA reference dataset, fetched at runtime (below).
const CARGO_SOURCE = (import.meta.env?.VITE_CARGO_SOURCE as string | undefined) ?? 'poc3';
/**
 * The gate-queue model service. Relative by default so the Vite dev proxy (and a
 * same-origin reverse proxy in a deployed build) can reach a container that is
 * NOT publicly exposed — the browser never needs the model's own port.
 */
export const AI_GATE_QUEUE_BASE =
  (import.meta.env?.VITE_AI_GATE_QUEUE_BASE as string | undefined) || '/ai/gate-queue';
const CARGO_FROM_POC3 = CARGO_SOURCE === 'poc3';
const CARGO_FROM_REFERENCE = CARGO_SOURCE === 'reference';
/** Runtime path of the generated reference dataset (served from public/, not bundled). */
const REFERENCE_DATASET_URL = '/reference-dataset.json';

// POC-3 authentication (the Cargo API returns 401 when the gateway runs with
// AUTH_ENABLED=true). The JWT now comes from the SIGNED-IN USER: auth/session.ts
// posts what they typed to POC-3's `POST /api/auth/login` — the same endpoint,
// the same core.app_user accounts and the same 8 h token UC-3's console uses.
//
// It used to be minted here from VITE_CARGO_AUTH_USER / VITE_CARGO_AUTH_PASS,
// which Vite inlines at build time: the credentials shipped inside the JS bundle
// and were readable in devtools by anyone. Those two variables, and the GitHub
// Actions secrets feeding them, are gone.
//
// A pre-issued token can still be injected verbatim via VITE_CARGO_API_TOKEN for
// unattended/service use; that path is unchanged.
const CARGO_STATIC_TOKEN = (import.meta.env?.VITE_CARGO_API_TOKEN as string | undefined) || undefined;

/**
 * Mint a POC-3-issued JWT via POC-3's documented `POST /api/auth/login` using the
 * configured credentials — the same in local dev and production. (The legacy
 * `/api/auth/dev-token` endpoint is no longer served by POC-3 and has been removed
 * from this flow.) Returns undefined if no token could be obtained (caller degrades).
 */
async function mintCargoToken(): Promise<string | undefined> {
  // The signed-in user's own POC-3 JWT, minted by auth/session.ts against the
  // same `POST /api/auth/login` this used to call with build-time credentials.
  // Nothing credential-shaped is compiled into the bundle any more.
  return getSessionToken() ?? undefined;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<Role>('DTCCC_ADMIN');
  const [lang, setLang] = useState<Lang>('en');
  // Readiness is tracked per credential so neither blocks the other: the live
  // gateway token (base adapter) and the POC-3 cargo token are independent.
  const [gatewayReady, setGatewayReady] = useState(MODE === 'mock');
  const [cargoReady, setCargoReady] = useState(!CARGO_FROM_POC3);

  // Latest gateway JWT, read by the LiveAdapter via getToken().
  const tokenRef = useRef<string | undefined>(undefined);
  // Latest POC-3-issued JWT, read by the Poc3CargoAdapter via getToken(). Kept
  // separate from the gateway token — POC-3 validates its own issuer/audience.
  const cargoTokenRef = useRef<string | undefined>(undefined);
  // Reference dataset, fetched at runtime in reference mode only (see effect
  // below). Read lazily by the ReferenceCargoAdapter via getOverride().
  const referenceRef = useRef<ReferenceCargoOverride | undefined>(undefined);

  const adapter = useMemo<DataAdapter>(() => {
    // The base adapter is chosen by DATA_MODE ALONE — cargo source never changes
    // it, so gate/rail/KPI/dashboard panels are identical across cargo sources.
    const base =
      MODE === 'live'
        ? new LiveAdapter({ gatewayBaseUrl: GATEWAY_BASE, getToken: () => tokenRef.current })
        : new MockAdapter({
            terminalsConfig: terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'],
            baselines: baselinesConfig as unknown as BaselinesConfig,
          });
    // Layer a cargo-only decorator per VITE_CARGO_SOURCE: POC-3 client ('poc3'),
    // the reference-dataset decorator ('reference'), or nothing ('mock'). Each
    // re-sources ONLY cargo and delegates every other method to `base`.
    const withCargo = CARGO_FROM_POC3
      ? new Poc3CargoAdapter(base, {
          cargoBaseUrl: CARGO_API_BASE,
          getToken: () => cargoTokenRef.current,
          setToken: (t) => { cargoTokenRef.current = t; cargoTokenStore.setToken(t); },
          // On a 401 the adapter re-mints the POC-3 JWT and retries once, so an
          // absent/expired token self-heals. A pre-issued static token opts out.
          refreshToken: CARGO_STATIC_TOKEN ? undefined : mintCargoToken,
          // Data-source provenance filter (LIVE = JNPA-API rows, DEMO = pre-loaded).
          // Read fresh on every request, so the header always reflects the toggle.
          getDataMode: () => getDataSourceMode(),
        })
      : CARGO_FROM_REFERENCE
        ? new ReferenceCargoAdapter(base, {
            terminalsConfig: terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'],
            baselines: baselinesConfig as unknown as BaselinesConfig,
            getOverride: () => referenceRef.current,
          })
        : base;
    /**
     * Route the gate-queue forecast through the real Python model (UC2-015).
     *
     * Layered here, INSIDE SimAdapter, so the simulator's overrides still apply
     * to the result — a What-If that raises the gate queue must still move a
     * model-sourced curve, or the two would tell different stories.
     *
     * The decorator falls back to the wrapped adapter's heuristic when the
     * service is unreachable, and labels which answered. That labelling is the
     * ticket's acceptance: stop the container and the Gate panel must visibly
     * say HEURISTIC.
     */
    const withForecast = new AiForecastAdapter(withCargo, { gateQueueBaseUrl: AI_GATE_QUEUE_BASE });

    /**
     * Route the Integration health cards through the six real connectors
     * (UC2-040).
     *
     * Layered here, INSIDE SimAdapter, for the same reason the forecast is: the
     * fault console's overrides must still apply on top, so injecting a fault
     * from the console moves a connector-sourced card rather than being ignored.
     *
     * Each card carries whether a connector answered. Stop a container and its
     * card flips CONNECTOR -> SIMULATED with the reason — that flip is the
     * ticket's acceptance.
     */
    const withConnectors = new ConnectorAdapter(withForecast);

    // Wrap so the live-data Simulator's overrides flow into every tab + the map.
    return new SimAdapter(withConnectors);
  }, []);

  // Reference mode only: fetch the generated reference dataset at runtime (it is
  // served from public/, never bundled, so mock/poc3 builds don't contain it).
  // On success, populate the ref and bump the cargo refresh so the Container
  // Movement panel refetches. Failure degrades to an empty cargo list.
  useEffect(() => {
    if (!CARGO_FROM_REFERENCE) return;
    let cancelled = false;
    fetch(REFERENCE_DATASET_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { containers?: unknown[]; events?: unknown[] }) => {
        if (cancelled) return;
        referenceRef.current = {
          containers: (data.containers ?? []) as ReferenceCargoOverride['containers'],
          events: (data.events ?? []) as ReferenceCargoOverride['events'],
        };
        cargoRefreshStore.bump();
      })
      .catch(() => { /* no reference dataset present → cargo shows empty */ });
    return () => { cancelled = true; };
  }, []);

  // Mint the POC-3 cargo token on mount, regardless of DATA_MODE (the cargo
  // adapter runs in every mode). Role-agnostic for cargo (POC-3 accepts any
  // valid stakeholder role), so it is minted once — not re-minted per UI role.
  // On failure the dashboard still proceeds (cargoReady flips true) so non-cargo
  // panels are never blocked by POC-3 auth; the Cargo panel shows its error state.
  useEffect(() => {
    if (!CARGO_FROM_POC3) return;
    if (CARGO_STATIC_TOKEN) {
      cargoTokenRef.current = CARGO_STATIC_TOKEN;
      cargoTokenStore.setToken(CARGO_STATIC_TOKEN);
      setCargoReady(true);
      return;
    }
    let cancelled = false;
    setCargoReady(false);
    mintCargoToken()
      .then((tok) => {
        if (cancelled) return;
        cargoTokenRef.current = tok;
        cargoTokenStore.setToken(tok);
        setCargoReady(true);
      })
      .catch(() => {
        if (!cancelled) setCargoReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Live mode: (re)mint a dev token whenever the role changes.
  useEffect(() => {
    if (MODE !== 'live') return;
    let cancelled = false;
    setGatewayReady(false);
    fetch(`${GATEWAY_BASE}/auth/dev-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, sub: `dashboard-${role}` }),
    })
      .then((r) => r.json())
      .then((d: { token?: string }) => {
        if (cancelled) return;
        tokenRef.current = d.token;
        setGatewayReady(Boolean(d.token));
      })
      .catch(() => {
        if (!cancelled) setGatewayReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

  // The dashboard is ready once BOTH credentials are settled (each defaults
  // ready when its source isn't in use). Gating cargo fetches on this avoids an
  // initial unauthenticated 401 before the POC-3 token lands.
  const authReady = gatewayReady && cargoReady;

  const value = useMemo(
    () => ({ adapter, role, setRole, lang, setLang, authReady }),
    [adapter, role, lang, authReady],
  );
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
