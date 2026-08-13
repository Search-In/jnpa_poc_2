import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@jnpa/schemas': alias('../../packages/schemas/src/index.ts'),
      '@jnpa/sim': alias('../../packages/sim/src/index.ts'),
      '@jnpa/kpi': alias('../../services/kpi/src/index.ts'),
      '@jnpa/data': alias('../../packages/data/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // scene3d.test.ts OOMs the default worker heap when it runs alongside the
    // rest of the pool (the ArcGIS scene graph is big); give workers room.
    poolOptions: { forks: { execArgv: ['--max-old-space-size=4096'] } },
  },
});
