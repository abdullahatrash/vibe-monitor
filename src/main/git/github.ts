import { execFile, type ExecFileException } from 'node:child_process'
import { getShellEnv } from '../shell-env'
import type { GhCreateResult, GhPr, GhPrResult } from '../../shared/ipc'

/**
 * Surface the current branch's GitHub PR + a create-PR action (#88, slice 4 of the
 * Changes panel, ADR-0008) — the LAST git slice. Unlike #84-#87's git operations, this
 * shells the **`gh` CLI** (the GitHub CLI), inheriting the user's own `gh auth` session —
 * NO Octokit, no token handling here (ADR-0008: GitHub-only, GitLab parity out of scope).
 * `gh` runs in MAIN via `child_process` through an injectable `GhRun` seam (mirroring
 * #84's `GitRun`), resolved on the shell-env PATH so a Finder/Dock launch still finds it.
 *
 * The PURE pieces are the testable seams: `parsePrJson` (the `gh pr view --json` shape)
 * and `mapPrView` / `mapCreate` (the stderr -> category outcome mapping). These NEVER
 * shell out and NEVER throw — every failure is folded into a result, exactly like the
 * git slices. The two impure shells (`ghCurrentPr`, `ghCreatePr`) just run `gh` and feed
 * the pure mappers, so a missing / unauthenticated / non-GitHub `gh` degrades to a typed
 * result rather than a crash.
 */

/**
 * Run a `gh` command and capture its stdout + exit code (+ stderr). Injectable for tests
 * (Seam, mirroring `GitRun`) so they never shell real `gh` — and so they NEVER open a
 * real PR. The default resolves `gh` via the shell-env PATH (like the git/agent spawns)
 * and resolves — never rejects — with the exit code even on failure.
 *
 * On a SPAWN failure (`gh` not installed — `err.code` is a string like `ENOENT`, not a
 * numeric exit), it resolves with the `GH_NOT_FOUND` sentinel code so the pure mapper can
 * distinguish "gh missing" from a normal non-zero `gh` exit and surface the install hint.
 */
export type GhRun = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>

/**
 * Sentinel exit code the default runner resolves with when `gh` could not be SPAWNED
 * (not installed). A real `gh` process never exits with a negative code, so this can't
 * collide with a genuine non-zero exit — `mapPrView`/`mapCreate` test it first.
 */
export const GH_NOT_FOUND = -1

export const defaultGhRun: GhRun = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'gh',
      args,
      { cwd, env: getShellEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err: ExecFileException | null, stdout: string, stderr: string) => {
        // A numeric `err.code` is gh's exit code; a STRING code (e.g. 'ENOENT') is a spawn
        // failure (gh not installed) -> the `GH_NOT_FOUND` sentinel so the caller maps it
        // to the install hint rather than a generic non-zero.
        const code = err == null ? 0 : typeof err.code === 'number' ? err.code : GH_NOT_FOUND
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
      },
    )
  })

/** The error messages, kept as named constants so the tests assert the exact copy. */
export const GH_NOT_FOUND_MESSAGE = 'GitHub CLI (gh) not found — install it to use PR features.'
export const GH_NOT_AUTHED_MESSAGE = 'Not logged in to GitHub — run `gh auth login`.'
export const GH_PUSH_FIRST_MESSAGE = 'Push your branch to GitHub first, then create the PR.'

/**
 * PURE: parse a `gh pr view --json number,title,url,state` stdout into a `GhPr`. The JSON
 * is a single object, e.g. `{"number":42,"state":"OPEN","title":"…","url":"https://…/42"}`
 * (state is uppercase OPEN/CLOSED/MERGED — kept verbatim; the renderer tints on it).
 * Returns null when the JSON is absent/malformed or missing the required fields, so a
 * surprising gh payload degrades to "no PR" rather than throwing.
 */
export function parsePrJson(stdout: string): GhPr | null {
  const text = stdout.trim()
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<GhPr>
    if (
      typeof raw.number !== 'number' ||
      typeof raw.title !== 'string' ||
      typeof raw.url !== 'string' ||
      typeof raw.state !== 'string'
    ) {
      return null
    }
    return { number: raw.number, title: raw.title, url: raw.url, state: raw.state }
  } catch {
    return null
  }
}

/** The categories a non-zero `gh` exit's stderr maps to. */
type GhErrorCategory = 'no-pr' | 'auth' | 'no-remote' | 'push' | 'other'

/**
 * PURE: classify a non-zero `gh` exit's stderr into a category (verified against real gh
 * 2.74 output, see github.test.ts). Lowercased substring matches, ordered most- to
 * least-specific:
 *  - `no-pr`: "no pull requests found" / "no open pull requests" — the COMMON case for a
 *    branch without a PR (gh exits non-zero on it), NOT an error.
 *  - `auth`: an authentication failure ("gh auth login" / "not logged in" / "authentication").
 *  - `no-remote`: no GitHub remote ("no git remotes found" / "not a git repository" /
 *    "none of the git remotes … point to a known github host") — no PR surface.
 *  - `push`: the branch isn't pushed (`gh pr create` non-interactively can't prompt to push).
 *  - `other`: anything else — surfaced verbatim.
 */
export function classifyGhError(stderr: string): GhErrorCategory {
  const s = stderr.toLowerCase()
  if (s.includes('no pull requests found') || s.includes('no open pull requests')) return 'no-pr'
  if (
    s.includes('gh auth login') ||
    s.includes('not logged in') ||
    s.includes('to get started with github cli') ||
    s.includes('authentication required') ||
    s.includes('requires authentication')
  ) {
    return 'auth'
  }
  if (
    s.includes('no git remotes found') ||
    s.includes('not a git repository') ||
    s.includes('none of the git remotes') ||
    s.includes('to a known github host')
  ) {
    return 'no-remote'
  }
  if (s.includes('must first push') || s.includes('push the') || s.includes('aborted')) return 'push'
  return 'other'
}

/**
 * PURE: map a `gh pr view` outcome (stdout/stderr/code) to a `GhPrResult`.
 *  - `GH_NOT_FOUND` sentinel → the install-gh hint.
 *  - exit 0 → parse the JSON → `{ok:true, pr}` (pr null only if the payload is unparseable).
 *  - non-zero: `no-pr` / `no-remote` → `{ok:true, pr:null}` (no PR surface, the common case,
 *    NOT an error); `auth` → the login hint; anything else → gh's stderr reason.
 */
export function mapPrView(stdout: string, stderr: string, code: number): GhPrResult {
  if (code === GH_NOT_FOUND) return { ok: false, error: GH_NOT_FOUND_MESSAGE }
  if (code === 0) return { ok: true, pr: parsePrJson(stdout) }
  const category = classifyGhError(stderr)
  if (category === 'no-pr' || category === 'no-remote') return { ok: true, pr: null }
  if (category === 'auth') return { ok: false, error: GH_NOT_AUTHED_MESSAGE }
  return { ok: false, error: stderr.trim() || 'gh pr view failed' }
}

/**
 * PURE: map a `gh pr create` outcome to a `GhCreateResult`. On exit 0, gh prints the new
 * PR's URL on stdout — captured + trimmed. On failure, map gh-missing / not-authed / push
 * the same friendly way as `mapPrView`; surface any other reason verbatim.
 */
export function mapCreate(stdout: string, stderr: string, code: number): GhCreateResult {
  if (code === GH_NOT_FOUND) return { ok: false, error: GH_NOT_FOUND_MESSAGE }
  if (code === 0) {
    const url = lastUrl(stdout)
    if (url) return { ok: true, url }
    return { ok: false, error: 'gh pr create succeeded but returned no URL.' }
  }
  const category = classifyGhError(stderr)
  if (category === 'auth') return { ok: false, error: GH_NOT_AUTHED_MESSAGE }
  if (category === 'push') return { ok: false, error: GH_PUSH_FIRST_MESSAGE }
  return { ok: false, error: stderr.trim() || 'gh pr create failed' }
}

/**
 * The PR URL from `gh pr create` stdout. gh prints the URL as the LAST line on success
 * (it may emit a "Creating pull request…" preamble first), so take the last non-empty
 * line that looks like an http(s) URL.
 */
function lastUrl(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^https?:\/\//.test(lines[i])) return lines[i]
  }
  return null
}

/**
 * Impure read (#88): the current branch's GitHub PR (or null). Runs
 * `gh pr view --json number,title,url,state` in `cwd` and feeds the pure `mapPrView`.
 * This is a NETWORK call (gh hits the GitHub API), fine on demand (the renderer fetches
 * on branch-change, not on every status tick). NEVER throws — a runner that rejects still
 * degrades to a result.
 */
export async function ghCurrentPr(cwd: string, run: GhRun = defaultGhRun): Promise<GhPrResult> {
  try {
    const res = await run(['pr', 'view', '--json', 'number,title,url,state'], cwd)
    return mapPrView(res.stdout, res.stderr, res.code)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Impure write (#88): create a PR for the current branch. Runs
 * `gh pr create --title <t> --body <b>` in `cwd` and feeds the pure `mapCreate`. We do NOT
 * pass `--base` — gh defaults to the repo's default branch (acp-capture / `gh pr create
 * --help`), and guessing it wrong would target the wrong base; letting gh resolve it is
 * safer. We also do NOT push: `gh pr create` non-interactively (no TTY) CANNOT prompt to
 * push, so an unpushed branch errors (`push` category -> the "push first" hint). The
 * renderer GATES the affordance on the branch having an upstream (#84's status), so this
 * push error is a backstop, not the primary path — we never `git push` on the user's
 * behalf here (no surprise writes to their remote). NEVER throws.
 */
export async function ghCreatePr(
  cwd: string,
  fields: { title: string; body: string },
  run: GhRun = defaultGhRun,
): Promise<GhCreateResult> {
  try {
    // Each value is its own argv element (no shell), so a title/body with spaces or shell
    // metacharacters is safe. An empty body is passed as `--body ''` (gh accepts it).
    const res = await run(['pr', 'create', '--title', fields.title, '--body', fields.body], cwd)
    return mapCreate(res.stdout, res.stderr, res.code)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
