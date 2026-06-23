/**
 * App entry. Registers Calcite components (CDN assets), mounts the dashboard
 * inside the AppProvider. Reduced-motion + dark mode honoured via Calcite.
 *
 * A tiny hash router selects between the dashboard (`#/`) and the live-data
 * Simulator (`#/simulator`). Both share the same AppProvider (one adapter) and
 * the cross-tab simStore, so the simulator can drive the dashboard live.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { setAssetPath } from '@esri/calcite-components';
import { defineCustomElements } from '@esri/calcite-components/dist/loader';
import { AppProvider } from './state/AppContext.js';
import { Dashboard } from './Dashboard.js';
import { SimulatorPage } from './sim/SimulatorPage.js';
import { useHashRoute } from './sim/useHashRoute.js';

// Calcite assets from CDN (works offline once cached; bundle locally for air-gap).
setAssetPath('https://js.arcgis.com/calcite-components/3.3.0/assets');
defineCustomElements(window);

function App() {
  const route = useHashRoute();
  return route.startsWith('/simulator') ? <SimulatorPage /> : <Dashboard />;
}

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>,
);
