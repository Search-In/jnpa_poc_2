import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jnpa/schemas': alias('../../packages/schemas/src/index.ts'),
      '@jnpa/sim': alias('../../packages/sim/src/index.ts'),
      '@jnpa/kpi': alias('../kpi/src/index.ts'),
      '@jnpa/data': alias('../../packages/data/src/index.ts'),
    },
  },
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts'] },
});
