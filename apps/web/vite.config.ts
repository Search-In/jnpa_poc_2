import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Mock mode runs entirely client-side against @jnpa/data MockAdapter — the
// workspace deps are aliased to source for fast HMR (no pre-build step needed).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@jnpa/schemas': fileURLToPath(new URL('../../packages/schemas/src/index.ts', import.meta.url)),
      '@jnpa/sim': fileURLToPath(new URL('../../packages/sim/src/index.ts', import.meta.url)),
      '@jnpa/kpi': fileURLToPath(new URL('../../services/kpi/src/index.ts', import.meta.url)),
      '@jnpa/data': fileURLToPath(new URL('../../packages/data/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      // Live mode: proxy /gateway → the BFF so the browser avoids CORS.
      '/gateway': {
        target: process.env.GATEWAY_URL ?? 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gateway/, ''),
      },
      // Cargo: proxy /poc3 → the POC-3 shared Cargo API so the browser stays
      // same-origin (no CORS dependency in dev). The adapter calls /poc3/api/cargo.
      '/poc3': {
        target: process.env.POC3_URL ?? 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/poc3/, ''),
      },
    },
  },
  build: { target: 'es2022', sourcemap: false },
  define: {
    // expose DATA_MODE to the client (mock by default)
    'import.meta.env.VITE_DATA_MODE': JSON.stringify(process.env.DATA_MODE ?? 'mock'),
  },
});
