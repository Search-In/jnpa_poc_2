import React from 'react';
import { createRoot } from 'react-dom/client';
import { setAssetPath } from '@esri/calcite-components';
import { defineCustomElements } from '@esri/calcite-components/dist/loader';
import { App } from './App.js';

setAssetPath('https://js.arcgis.com/calcite-components/3.3.0/assets');
defineCustomElements(window);

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
