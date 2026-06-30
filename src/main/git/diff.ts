import { createHash } from 'node:crypto'
import { defaultGitRun, type GitRun } from './status'
import type { GitDiffResult } from '../../shared/ipc'

/**
 * Read a single changed path's WORKING-TREE unified diff (#85, ADR-0008). Like #84's
 * status read, git runs in MAIN via `child_process` through the injectable `GitRun`
 * seam (reused from `status.ts`) — no git2 / isomorphic-git. The renderer parses +
 * renders the raw patch with `@pierre/diffs`; this side only produces the raw text.
 *
 * The data contract is deliberately thin: main returns the RAW unified-diff text plus
 * a content `diffHash` (so the renderer can memoize an unchanged file and skip a
 * re-parse), and a `truncated` flag when the patch is capped. Working-tree source
 * only (no branch-range). Read-only. Any git failure is swallowed into the empty
 * result — it NEVER throws, mirroring `readGitStatus`.
 */

/**
 * Cap on the raw patch size handed to the renderer (~120 KB). A huge diff (a vendored
 * lockfile, a generated bundle) would otherwise bloat the IPC payload and stall the
 * worker render; past the cap we hand back a `truncated` prefix the viewer flags.
 */
const MAX_PATCH_BYTES = 120 * 1024

/**
 * PURE seam: turn a raw `git diff` stdout into the renderer payload. Caps the patch at
 * `MAX_PATCH_BYTES` (BY BYTES, so a multibyte UTF-8 file can't smuggle past the cap),
 * flags `truncated`, and hashes the FINAL (post-cap) patch with sha256 — the hash keys
 * the renderer's memo, so it must reflect exactly the text the renderer receives. An
 * empty input yields the empty result (`patch:''`, `diffHash:''`) — also the
 * swallow-all-errors fallback shape, so a no-diff and a failed-diff read look alike.
 */
export function finalizeDiff(raw: string): GitDiffResult {
  if (!raw) return { patch: '', diffHash: '', truncated: false }
  const bytes = Buffer.from(raw, 'utf8')
  const truncated = bytes.byteLength > MAX_PATCH_BYTES
  const patch = truncated ? bytes.subarray(0, MAX_PATCH_BYTES).toString('utf8') : raw
  const diffHash = createHash('sha256').update(patch).digest('hex')
  return { patch, diffHash, truncated }
}

/**
 * Impure read (#85): run `git diff` for one path in `cwd` and finalize it. Two shapes:
 *  - TRACKED: `git -c core.quotePath=false diff --no-color [-w] -- <path>` (exit 0 OK).
 *  - UNTRACKED: `git ... diff --no-color [-w] --no-index -- /dev/null <path>`. `--no-index`
 *    exits **1 when there IS a diff** (verified against real git) — so 0 AND 1 are both
 *    success (capture stdout); only a LARGER code (a real error) degrades to empty.
 * `core.quotePath=false` so non-ASCII paths come back as plain UTF-8 (matching #84's
 * status read). `ignoreWhitespace` adds `-w` (`--ignore-all-space`) — @pierre can't
 * ignore whitespace on a pre-parsed patch, so the toggle re-reads the diff here.
 * All git failure is swallowed into the empty result — this NEVER throws.
 */
export async function readGitDiff(
  cwd: string,
  path: string,
  untracked: boolean,
  ignoreWhitespace = false,
  run: GitRun = defaultGitRun,
): Promise<GitDiffResult> {
  try {
    const ws = ignoreWhitespace ? ['-w'] : []
    if (untracked) {
      const res = await run(
        ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, '--no-index', '--', '/dev/null', path],
        cwd,
      )
      // `--no-index`: 0 = no diff, 1 = diff present, >1 = a real failure.
      if (res.code !== 0 && res.code !== 1) return finalizeDiff('')
      return finalizeDiff(res.stdout)
    }
    // `HEAD` (not the bare worktree-vs-index `git diff`) so a fully-STAGED file still
    // shows its diff: the Changes panel lists a file's churn as staged+unstaged (vs
    // HEAD), so the viewer must match — a bare `git diff` is empty for an `M.`/`A.`
    // file and would dead-click. (A zero-commit repo has no HEAD → empty; rare edge.)
    const res = await run(['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, 'HEAD', '--', path], cwd)
    if (res.code !== 0) return finalizeDiff('')
    return finalizeDiff(res.stdout)
  } catch {
    return finalizeDiff('')
  }
}
