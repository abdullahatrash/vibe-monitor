import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test'

/**
 * Visual smoke suite (slice 1): launch the BUILT app against a throwaway
 * userData profile and pin the cold UI states with screenshots — the layer the
 * vitest suite deliberately can't see (pure modules, node env, no DOM). This is
 * the net for the layout-regression class of bug: composer not pinned, control
 * rows overflowing, the side panel not stretching.
 *
 * Deliberately NO agent interaction in this slice: nothing here clicks a
 * Workspace or Thread row, so no `vibe-acp` is ever spawned and the suite runs
 * the same on a machine without Vibe installed. Driving a live conversation
 * (composer states, streaming, the side panel) needs a scripted fake `vibe-acp`
 * on PATH speaking minimal ACP — that's slice 2.
 */

const MAIN_ENTRY = resolve(import.meta.dirname, '../out/main/index.js')

/** Fixed window size so screenshots are comparable across runs. */
const WINDOW = { width: 1400, height: 900 }

test.beforeAll(() => {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error('out/main/index.js is missing — run `bun run build` before `bun run test:e2e`.')
  }
})

/** Launch the built app with its profile pointed at `userData` (the test seam). */
async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, VIBE_MISTRO_USER_DATA: userData },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 50, y: 50, ...bounds })
  }, WINDOW)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('first run: shell chrome + empty state render', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-'))
  const { app, page } = await launch(userData)
  try {
    await expect(page.getByText('New chat')).toBeVisible()
    await expect(page.getByText('Projects')).toBeVisible()
    await expect(page).toHaveScreenshot('first-run.png')
  } finally {
    await app.close()
  }
})

test('seeded profile: sidebar lists the persisted Workspace and its Thread', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-'))
  const fakeProjectDir = await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-project-'))
  // Recent-but-fixed-offset timestamps: old enough that the relative-time label
  // ("5m") is stable for the duration of a run, recent enough that it can't
  // drift between runs the way a hardcoded epoch would ("2y" -> "3y").
  const now = Date.now()
  await writeFile(
    join(userData, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { id: 'ws-1', dir: fakeProjectDir, displayName: 'seeded-project', lastOpenedAt: now - 5 * 60_000 },
      ],
      threads: [
        {
          id: 'th-1',
          workspaceId: 'ws-1',
          sessionId: 'sess-stale',
          title: 'Sum two numbers',
          createdAt: now - 10 * 60_000,
          lastActiveAt: now - 5 * 60_000,
        },
      ],
    }),
  )
  const { app, page } = await launch(userData)
  try {
    await expect(page.getByText('seeded-project')).toBeVisible()
    // Expanding the project is SAFE: the header row is the fold trigger and
    // folding is peek-only — it never connects. But do NOT click the thread row
    // itself: since #203 that auto-continues, which would spawn a real
    // `vibe-acp` here.
    await page.getByText('seeded-project').click()
    await expect(page.getByText('Sum two numbers')).toBeVisible()
    // Settle: confirm the fold HOLDS open (a transient auto-wait pass right after
    // the click would mask a state reset re-collapsing the project).
    await page.waitForTimeout(300)
    await expect(page.getByText('Sum two numbers')).toBeVisible()
    await expect(page).toHaveScreenshot('seeded-sidebar.png')
  } finally {
    await app.close()
  }
})
