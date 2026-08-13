/**
 * Workspace-wide ESLint config for the pnpm monorepo (packages/, services/,
 * apps/, scripts/). Mirrors the conventions of the sibling standalone projects
 * (web/.eslintrc.cjs, mobile-pwa/.eslintrc.cjs): ESLint 8 legacy config,
 * eslint:recommended + @typescript-eslint/recommended, react-hooks, and the
 * project's existing decision to allow `any` (`no-explicit-any: off`).
 *
 * Run with: pnpm lint   →  eslint . --ext .ts,.tsx,.mjs,.cjs --max-warnings 0
 *
 * web/ and mobile-pwa/ are NOT part of the pnpm workspace — each has its own
 * .eslintrc.cjs and its own dependency install — so they are ignored here.
 */
module.exports = {
  root: true,
  env: { browser: true, node: true, es2022: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    // Anchored: the standalone sibling projects only — NOT apps/web.
    '/web/',
    '/mobile-pwa/',
    '.eslintrc.cjs',
    '**/*.tsbuildinfo',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    // Existing project decision, carried over from web/.eslintrc.cjs.
    '@typescript-eslint/no-explicit-any': 'off',
    // `catch {}` with a comment and `while (empty)` polling loops are used
    // deliberately; the TS-aware unused-vars below still catches dead bindings.
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  },
  overrides: [
    // react-refresh/only-export-components is deliberately NOT adopted here
    // (the standalone web/ and mobile-pwa/ keep it in their own configs): it is
    // an HMR-optimisation advisory, and its only hits in this workspace are
    // architectural facts of shared modules — AppContext's exported constants
    // (CARGO_API_BASE et al.) are its public API, ReactiveGuide exports its
    // alias map, LifecycleSteps re-exports. Splitting those files apart to
    // satisfy an advisory would churn shared code for no correctness gain.
    {
      // Plain-JS node scripts (ingest/screenshot tooling) — CommonJS-era rules
      // that @typescript-eslint applies to .ts don't fit here.
      files: ['**/*.mjs', '**/*.cjs'],
      rules: {
        '@typescript-eslint/no-require-imports': 'off',
      },
    },
  ],
};
