// ESLint 9/10 flat config for vibe-mistro.
//
// Scope of this config: a pragmatic, non-type-checked safety net.
// We intentionally use typescript-eslint's *recommended* preset (syntax-only,
// no `parserOptions.project`) rather than `recommendedTypeChecked` /
// `strictTypeChecked`. Type-checked rules are a reasonable follow-up but would
// flood this existing codebase and require wiring the TS project graph here.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  // Things ESLint should never look at.
  {
    ignores: [
      'out/**',
      'dist*/**',
      'node_modules/**',
      'coverage/**',
      '**/*.gen.*',
      '*.tsbuildinfo',
    ],
  },

  // Base recommended rules for every TS/TSX file.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Main + preload run in a Node/Electron context.
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // One-off Node CLI probes (e.g. the issue #29 session/load spike). Run via
  // `bun scripts/*.ts`; not part of the app/build graph, so they live outside
  // tsconfig — this block keeps `eslint .` covering them with Node globals.
  {
    files: ['scripts/**/*.{ts,mts,mjs}', 'e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Renderer runs in the browser; React 19 (no react-in-jsx-scope needed).
  //
  // We register eslint-plugin-react-hooks manually and enable just the two
  // classic, high-signal rules. v7's `recommended` preset also turns on a large
  // batch of experimental React Compiler rules (purity, immutability,
  // set-state-in-render, ...) which are noisy on an existing codebase; enabling
  // those is a possible follow-up. Its `recommended` configs are also still in
  // legacy eslintrc (array-`plugins`) format and don't drop into flat config.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Shared code is environment-agnostic; give it both global sets so it lints
  // cleanly regardless of which side consumes it.
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // Tests: vitest globals. The handful of intentional `any` casts in tests are
  // scoped with inline `// eslint-disable-next-line` directives at their use
  // sites, so we keep the base rule set here rather than blanket-relaxing it.
  {
    files: ['**/*.test.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
