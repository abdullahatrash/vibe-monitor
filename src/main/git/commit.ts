import { defaultGitRun, type GitRun } from './status'
import type { GitCommitResult } from '../../shared/ipc'

/**
 * Commit working-tree changes from the Changes panel (#86, ADR-0008) — the FIRST git
 * WRITE. Like #84's status read and #85's diff read, git runs in MAIN via
 * `child_process` through the injectable `GitRun` seam (reused from `status.ts`) — no
 * git2 / isomorphic-git. There is NO stage/unstage/discard UI: selection is decided at
 * COMMIT time (like t3code's `prepareCommitContext`), so this stages exactly the
 * caller's selection, then commits.
 *
 * Staging semantics (be precise — a wrong `add`/`reset` commits the wrong files):
 *  - SUBSET (`paths.length > 0`): `git reset -q` first — a MIXED reset that unstages
 *    everything but KEEPS the working tree — then `git add -- <paths…>`. Net effect:
 *    ONLY the selected paths are staged, so a file the user previously staged out of
 *    band but did NOT select is excluded from this commit.
 *  - ALL (`paths` empty): `git add -A` — stage every change (modifications, untracked
 *    adds, and deletions).
 * Then `git -c core.quotePath=false commit -m <message>`. `core.quotePath=false` keeps
 * us consistent with #84's status read (its paths are unquoted UTF-8). Each path is its
 * own argv element (no shell), so a path with spaces is safe.
 *
 * Failure is SWALLOWED into the result — this NEVER throws (mirroring #84/#85 and the
 * #78 auth-error style): a non-zero `reset`/`add`/`commit` returns `{ok:false, error}`
 * carrying git's ACTUAL reason ("nothing to commit", a failed pre-commit hook, an
 * index lock) rather than a collapsed "commit failed". `GitRun` resolves even on a
 * non-zero exit, so we gate on `.code` after every step.
 */
export async function gitCommit(
  cwd: string,
  message: string,
  paths: string[],
  run: GitRun = defaultGitRun,
): Promise<GitCommitResult> {
  try {
    if (paths.length > 0) {
      // A pre-staged RENAME shows in #84's status as ONE `R` row whose path is the NEW
      // name only (the deleted source isn't a selectable row). `git reset -q` decomposes
      // that staged rename into a `.D <orig>` + `? <new>`, so a plain `add -- <new>` would
      // stage ONLY the add and DROP the deletion — committing both files. So FIRST collect
      // the origins of any selected staged-renames (read before the reset destroys them)
      // and stage BOTH halves below. (Best-effort: a failed status read yields no origins.)
      const renameOrigins = await collectRenameOrigins(cwd, paths, run)
      // Mixed reset (keeps the working tree) so the index starts from HEAD, then stage
      // exactly the selection — any other previously-staged path drops out of the index.
      const reset = await run(['reset', '-q'], cwd)
      if (reset.code !== 0) return fail(reset)
      // `add -- <paths + rename-origins>` stages modifications, untracked adds, deletions
      // of the selected tracked paths (git ≥2.0 default), AND a selected rename's deleted
      // source — so a deleted/renamed selected file commits whole.
      const add = await run(['add', '--', ...paths, ...renameOrigins], cwd)
      if (add.code !== 0) return fail(add)
    } else {
      // Commit-all: stage everything (incl. untracked + deletions).
      const add = await run(['add', '-A'], cwd)
      if (add.code !== 0) return fail(add)
    }
    const commit = await run(['-c', 'core.quotePath=false', 'commit', '-m', message], cwd)
    if (commit.code !== 0) return fail(commit)
    return { ok: true }
  } catch (err) {
    // A truly unexpected throw (a runner that rejects) still degrades to a result.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The deleted-source paths of any SELECTED staged renames (#86 review fold). Reads
 * `git status --porcelain=2` BEFORE the commit's reset (which would decompose the
 * rename) and, for each `2`-entry (`<XY> <sub> <m…> <h…> <Xscore> <new>\t<orig>`)
 * whose NEW path is in the selection, returns its `<orig>` so both halves get staged.
 * Best-effort: a non-zero status read returns `[]` (the commit proceeds without it,
 * degrading to the original add-the-new-only behaviour — never throws/blocks).
 */
async function collectRenameOrigins(cwd: string, paths: string[], run: GitRun): Promise<string[]> {
  const selected = new Set(paths)
  const res = await run(['-c', 'core.quotePath=false', 'status', '--porcelain=2'], cwd)
  if (res.code !== 0) return []
  const origins: string[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.startsWith('2 ')) continue // `2` = rename/copy entry
    // The pathnames follow 9 space-delimited fields, as `<new>\t<orig>`.
    const rest = afterFields(line, 9)
    const tab = rest.indexOf('\t')
    if (tab < 0) continue
    const newPath = rest.slice(0, tab)
    const orig = rest.slice(tab + 1)
    if (orig && selected.has(newPath)) origins.push(orig)
  }
  return origins
}

/** Drop the first `n` space-delimited fields of a line, returning the remainder verbatim. */
function afterFields(line: string, n: number): string {
  let i = 0
  for (let f = 0; f < n; f++) {
    const sp = line.indexOf(' ', i)
    if (sp < 0) return ''
    i = sp + 1
  }
  return line.slice(i)
}

/**
 * Map a non-zero git step to the failure result, surfacing the real reason. git writes
 * hook / lock failures to STDERR and "nothing to commit" to STDOUT, so prefer stderr
 * and fall back to stdout — never collapse to a generic message (#78 style).
 */
function fail(res: { stdout: string; stderr?: string; code: number }): GitCommitResult {
  const reason = (res.stderr ?? '').trim() || res.stdout.trim() || 'git command failed'
  return { ok: false, error: reason }
}
