import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Needed so a test can render a component through react-dom/server and assert
  // on the markup. Without it a .tsx test file fails to transform. No DOM
  // dependency is added — `environment` stays 'node'; the server renderer needs
  // no browser (see test/ml-predictions-render.test.tsx for why that is enough).
  plugins: [react()],
  resolve: {
    alias: {
      '@jnpa/schemas': alias('../../packages/schemas/src/index.ts'),
      '@jnpa/sim': alias('../../packages/sim/src/index.ts'),
      '@jnpa/kpi': alias('../../services/kpi/src/index.ts'),
      '@jnpa/data': alias('../../packages/data/src/index.ts'),
    },
  },
  // `?(x)` widens the existing pattern to .tsx so component render tests are
  // collected. Every previously-matched .test.ts still matches.
  test: { globals: true, environment: 'node', include: ['test/**/*.test.ts?(x)'] },
});
