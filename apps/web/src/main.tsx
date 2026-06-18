/**
 * App entry. Registers Calcite components (CDN assets), mounts the dashboard
 * inside the AppProvider. Reduced-motion + dark mode honoured via Calcite.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { setAssetPath } from '@esri/calcite-components';
import { defineCustomElements } from '@esri/calcite-components/dist/loader';
import { AppProvider } from './state/AppContext.js';
import { Dashboard } from './Dashboard.js';

// Calcite assets from CDN (works offline once cached; bundle locally for air-gap).
setAssetPath('https://js.arcgis.com/calcite-components/3.3.0/assets');
defineCustomElements(window);

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <AppProvider>
      <Dashboard />
    </AppProvider>
  </React.StrictMode>,
);
