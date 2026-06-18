import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@jnpa/schemas': fileURLToPath(new URL('../schemas/src/index.ts', import.meta.url)),
      '@jnpa/sim': fileURLToPath(new URL('../sim/src/index.ts', import.meta.url)),
      '@jnpa/kpi': fileURLToPath(new URL('../../services/kpi/src/index.ts', import.meta.url)),
    },
  },
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
