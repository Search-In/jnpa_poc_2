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
import type { DataAdapter } from '@jnpa/data';
import { LiveAdapter, MockAdapter, Poc3CargoAdapter } from '@jnpa/data';
import type { Role } from '@jnpa/schemas';
import type { BaselinesConfig } from '@jnpa/kpi';
import terminalsConfig from '../../../../config/terminals.json';
import baselinesConfig from '../../../../config/baselines.json';
import type { Lang } from '../i18n/strings.js';
import { SimAdapter } from '../sim/SimAdapter.js';

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
const CARGO_API_BASE = (import.meta.env?.VITE_CARGO_API_BASE as string | undefined) || '/poc3';
const CARGO_FROM_POC3 = (import.meta.env?.VITE_CARGO_SOURCE ?? 'poc3') !== 'mock';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [role, setRole] = useState<Role>('DTCCC_ADMIN');
  const [lang, setLang] = useState<Lang>('en');
  const [authReady, setAuthReady] = useState(MODE === 'mock');

  // Latest JWT, read by the LiveAdapter via getToken().
  const tokenRef = useRef<string | undefined>(undefined);

  const adapter = useMemo<DataAdapter>(() => {
    const base =
      MODE === 'live'
        ? new LiveAdapter({ gatewayBaseUrl: GATEWAY_BASE, getToken: () => tokenRef.current })
        : new MockAdapter({
            terminalsConfig: terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'],
            baselines: baselinesConfig as unknown as BaselinesConfig,
          });
    // Re-source cargo from the POC-3 shared Cargo API (single source of truth);
    // all other panels keep the mock/live base. Skipped when VITE_CARGO_SOURCE=mock.
    const withCargo = CARGO_FROM_POC3
      ? new Poc3CargoAdapter(base, { cargoBaseUrl: CARGO_API_BASE, getToken: () => tokenRef.current })
      : base;
    // Wrap so the live-data Simulator's overrides flow into every tab + the map.
    return new SimAdapter(withCargo);
  }, []);

  // Live mode: (re)mint a dev token whenever the role changes.
  useEffect(() => {
    if (MODE !== 'live') return;
    let cancelled = false;
    setAuthReady(false);
    fetch(`${GATEWAY_BASE}/auth/dev-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, sub: `dashboard-${role}` }),
    })
      .then((r) => r.json())
      .then((d: { token?: string }) => {
        if (cancelled) return;
        tokenRef.current = d.token;
        setAuthReady(Boolean(d.token));
      })
      .catch(() => {
        if (!cancelled) setAuthReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role]);

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
