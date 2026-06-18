import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@jnpa/schemas': fileURLToPath(new URL('../../packages/schemas/src/index.ts', import.meta.url)),
      '@jnpa/sim': fileURLToPath(new URL('../../packages/sim/src/index.ts', import.meta.url)),
    },
  },
  server: { port: Number(process.env.DEMO_CONSOLE_PORT ?? 5174) },
  build: { target: 'es2022' },
});
