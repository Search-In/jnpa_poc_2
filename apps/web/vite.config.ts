import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The single `.env` lives at the MONOREPO ROOT, but the web app runs in apps/web,
// so Vite's default envDir (apps/web) would never load it — leaving POC3_URL/etc.
// undefined and the proxy stuck on the localhost fallbacks. Load the root `.env`
// explicitly so the dev-proxy targets + data-mode come from configuration, not
// hardcoded defaults. No URL is hardcoded here — the value stays in `.env`.
const rootDir = fileURLToPath(new URL('../../', import.meta.url));

// Mock mode runs entirely client-side against @jnpa/data MockAdapter — the
// workspace deps are aliased to source for fast HMR (no pre-build step needed).
export default defineConfig(({ mode }) => {
  // `.env` fills unset vars; a real shell export still wins. Prefix '' so the
  // server-side (non-VITE_) vars POC3_URL/GATEWAY_URL/WEB_PORT/DATA_MODE resolve.
  const env = { ...loadEnv(mode, rootDir, ''), ...process.env } as Record<string, string | undefined>;
  return {
    plugins: [react()],
    // Client-side VITE_* vars (e.g. VITE_CARGO_API_BASE/VITE_CARGO_SOURCE) also
    // resolve from the same root `.env`.
    envDir: rootDir,
    resolve: {
      alias: {
        '@jnpa/schemas': fileURLToPath(new URL('../../packages/schemas/src/index.ts', import.meta.url)),
        '@jnpa/sim': fileURLToPath(new URL('../../packages/sim/src/index.ts', import.meta.url)),
        '@jnpa/kpi': fileURLToPath(new URL('../../services/kpi/src/index.ts', import.meta.url)),
        '@jnpa/data': fileURLToPath(new URL('../../packages/data/src/index.ts', import.meta.url)),
      },
    },
    server: {
      port: Number(env.WEB_PORT ?? 5173),
      proxy: {
        // Live mode: proxy /gateway → the BFF so the browser avoids CORS.
        '/gateway': {
          target: env.GATEWAY_URL ?? 'http://localhost:8080',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/gateway/, ''),
        },
        // Cargo: proxy /poc3 → the POC-3 shared Cargo API so the browser stays
        // same-origin (no CORS dependency in dev). The adapter calls /poc3/api/cargo.
        '/poc3': {
          target: env.POC3_URL ?? 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/poc3/, ''),
        },
        // UC-2 model services (UC2-015). The four AI containers listen on 8200
        // inside the compose network; compose now publishes them so the browser
        // can reach one through this proxy without the model being internet-
        // facing. Killing the container is what flips the Gate panel's badge.
        '/ai/gate-queue': {
          target: env.AI_GATE_QUEUE_URL ?? 'http://localhost:8202',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/ai\/gate-queue/, ''),
        },
        // NLDS Logistics Data Bank — Manage → Track. Browser calls /ldb/…;
        // Vite rewrites to the public LDB origin (avoids CORS). LDB rejects
        // requests whose Origin is localhost ("Invalid CORS request" → 403), so
        // rewrite Origin/Referer to the LDB site on the upstream hop.
        '/ldb': {
          target: env.LDB_URL ?? 'https://ldb.co.in',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/ldb/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Origin', 'https://ldb.co.in');
              proxyReq.setHeader('Referer', 'https://ldb.co.in/');
              proxyReq.removeHeader('cookie');
            });
          },
        },
      },
    },
    build: { target: 'es2022', sourcemap: false },
    define: {
      // expose DATA_MODE to the client (mock by default)
      'import.meta.env.VITE_DATA_MODE': JSON.stringify(env.DATA_MODE ?? 'mock'),
    },
  };
});
