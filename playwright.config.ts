import { defineConfig } from '@playwright/test'

/**
 * The e2e smoke suite (`e2e/`): Playwright driving the BUILT Electron app
 * (`out/main/index.js` — run `bun run build` first). One worker: each test
 * launches its own app instance against a throwaway userData profile
 * (`VIBE_MISTRO_USER_DATA` seam in `src/main/index.ts`), and parallel Electron
 * instances fight over the dock/focus.
 *
 * Screenshot baselines live next to the spec (`*-snapshots/`) and are
 * MACHINE-LOCAL by design (font rendering differs across OSes); regenerate
 * with `bun run test:e2e:update` after an intentional visual change.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  expect: {
    toHaveScreenshot: {
      // Animations frozen for determinism. The pixel budget is deliberately
      // SMALL and absolute: same-machine captures are near-identical, and a
      // ratio cushion (even 2% ≈ 25k px at 1400x900) silently swallows a whole
      // missing row — exactly the regression class this suite exists to catch.
      animations: 'disabled',
      maxDiffPixels: 200,
    },
  },
})
