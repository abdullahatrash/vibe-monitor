import { defaultGitRun, type GitRun } from './status'
import type { GitBranch, GitBranchesResult, GitOpResult } from '../../shared/ipc'

/**
 * Branch list / checkout / create on a Workspace's working tree (#87, slice 3 of the
 * Changes panel, ADR-0008). Like #84's status read, #85's diff read, and #86's commit
 * write, git runs in MAIN via `child_process` through the injectable `GitRun` seam
 * (reused from `status.ts`) — no git2 / isomorphic-git. The PURE `parseBranches` is the
 * testable seam (it never shells out); `gitBranches` is the thin impure shell that runs
 * the commands and feeds the parser.
 *
 * Every failure is SWALLOWED into a result — these NEVER throw (mirroring #84/#85/#86):
 * a list failure returns `{ok:false, error}`, a checkout/create failure returns
 * `{ok:false, error}` carrying git's ACTUAL reason. A dirty-tree checkout git refuses
 * ("Your local changes would be overwritten…") is a NON-zero exit we just surface — git
 * protects the tree, there is NO data loss; we never `--force`/`--discard`.
 */

/**
 * PURE parser (#87): turn `git for-each-ref --format='%(HEAD) %(refname)'` text +
 * the resolved default-branch name into the `GitBranch[]` the panel renders.
 *
 * The `for-each-ref` grammar (verified against real git, see branches.test.ts):
 *  - `%(HEAD)` is `*` for the CURRENT branch, else a single space — so each line is
 *    `<*| > <refname>`, i.e. the marker is `line[0]` and the refname is `line.slice(2)`.
 *  - `refs/heads/<name>`        -> a LOCAL branch  `{name, isRemote:false, current}`.
 *  - `refs/remotes/<remote>/<name>` -> a REMOTE branch `{name:'<remote>/<name>', isRemote:true}`.
 *  - a `refs/remotes/<remote>/HEAD` ref is the symbolic origin/HEAD POINTER, not a
 *    branch — EXCLUDED.
 *
 * Then DEDUPE (pure, mirroring t3code's `dedupeRemoteBranchesWithLocalMatches`): drop a
 * remote branch whose trailing name has a matching LOCAL head (e.g. drop `origin/main`
 * when local `main` exists) so the list shows the local + only the remote-ONLY branches.
 *
 * `isDefault` marks the branch the default-ref points at (best-effort; all false when
 * unresolved): a local whose name matches, or a remote-only whose trailing name matches.
 */
export function parseBranches(forEachRef: string, defaultName: string | null): GitBranch[] {
  const locals: GitBranch[] = []
  const remotes: GitBranch[] = []
  const localNames = new Set<string>()

  for (const line of forEachRef.split('\n')) {
    if (!line) continue
    // `%(HEAD)` is one char (`*`/space) then a literal space, so the refname starts at 2.
    const current = line[0] === '*'
    const refname = line.slice(2)
    if (refname.startsWith('refs/heads/')) {
      const name = refname.slice('refs/heads/'.length)
      if (!name) continue
      localNames.add(name)
      locals.push({ name, isRemote: false, current, isDefault: name === defaultName })
    } else if (refname.startsWith('refs/remotes/')) {
      const name = refname.slice('refs/remotes/'.length)
      // `<remote>/<branch>` — exclude the `<remote>/HEAD` symbolic pointer (not a branch).
      if (!name || name.endsWith('/HEAD')) continue
      const trailing = remoteTrailingName(name)
      remotes.push({ name, isRemote: true, current: false, isDefault: trailing === defaultName })
    }
    // Any other ref namespace is ignored.
  }

  // Dedupe: keep a remote ONLY when no local head shares its trailing branch name.
  const remoteOnly = remotes.filter((r) => !localNames.has(remoteTrailingName(r.name)))
  return [...locals, ...remoteOnly]
}

/** The branch portion of a `<remote>/<branch>` name (drop the leading remote segment). */
function remoteTrailingName(name: string): string {
  const slash = name.indexOf('/')
  return slash >= 0 ? name.slice(slash + 1) : name
}

/**
 * PURE: resolve the default branch name from `git symbolic-ref refs/remotes/origin/HEAD`
 * stdout (e.g. `refs/remotes/origin/main` -> `main`). Returns null when unresolved, so a
 * missing origin/HEAD just leaves every branch `isDefault:false` (best-effort).
 */
export function defaultBranchName(symbolicRef: string): string | null {
  const ref = symbolicRef.trim()
  if (!ref.startsWith('refs/remotes/')) return null
  const name = remoteTrailingName(ref.slice('refs/remotes/'.length))
  return name || null
}

/**
 * Impure list (#87): run `for-each-ref` for `cwd` and parse it, with a best-effort
 * default-branch lookup. The default lookup NEVER fails the whole call — a missing
 * origin/HEAD (a clone with no remote, a fresh repo) just yields no default. A failed
 * `for-each-ref` is swallowed into `{ok:false, error}` (its git reason). Never throws.
 */
export async function gitBranches(cwd: string, run: GitRun = defaultGitRun): Promise<GitBranchesResult> {
  try {
    // `-c core.quotePath=false` keeps unicode branch names plain UTF-8 (consistent with
    // #84-#86). `--format` is ONE argv element (no shell, so no surrounding quotes).
    const refs = await run(
      ['-c', 'core.quotePath=false', 'for-each-ref', '--format=%(HEAD) %(refname)', 'refs/heads', 'refs/remotes'],
      cwd,
    )
    if (refs.code !== 0) return { ok: false, error: failReason(refs) }
    // Best-effort default-branch probe — a non-zero exit (no origin/HEAD) leaves it null.
    const sym = await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd)
    const defaultName = sym.code === 0 ? defaultBranchName(sym.stdout) : null
    return { ok: true, branches: parseBranches(refs.stdout, defaultName) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Impure checkout (#87): switch to a branch. The renderer (which knows `isRemote`) passes
 * the branch's full `name` plus `track`: a LOCAL branch (`track:false`) → `git switch
 * <name>` (the name may contain `/`, e.g. `feat/87-…`, so it's never stripped); a
 * remote-only branch (`track:true`) → `git switch --track <remote>/<branch>`, which
 * creates a tracking local UNAMBIGUOUSLY (a bare DWIM `git switch <branch>` would error
 * when two remotes share the trailing name).
 *
 * A dirty-tree switch git refuses ("Your local changes … would be overwritten") exits
 * non-zero -> `{ok:false, error: <git reason>}`. NO data loss: git protects the tree; we
 * surface the reason and the user resolves it (commit/stash). Never throws.
 */
export async function gitCheckout(
  cwd: string,
  name: string,
  track = false,
  run: GitRun = defaultGitRun,
): Promise<GitOpResult> {
  try {
    // `track` (a remote-only branch): `git switch --track <remote>/<branch>` creates a
    // local branch (named after the trailing segment) tracking that EXACT remote ref —
    // unambiguous even when two remotes share a trailing name, where a bare DWIM
    // `git switch <branch>` would error. A LOCAL branch (`track:false`) switches by name.
    const args = track
      ? ['-c', 'core.quotePath=false', 'switch', '--track', name]
      : ['-c', 'core.quotePath=false', 'switch', name]
    const res = await run(args, cwd)
    if (res.code !== 0) return { ok: false, error: failReason(res) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Impure create (#87): `git switch -c <name>` from the current HEAD (no base ref in v1).
 * A name collision (`fatal: a branch named '<name>' already exists`) exits non-zero ->
 * `{ok:false, error}` carrying git's reason. Never throws.
 */
export async function gitCreateBranch(cwd: string, name: string, run: GitRun = defaultGitRun): Promise<GitOpResult> {
  try {
    const res = await run(['-c', 'core.quotePath=false', 'switch', '-c', name], cwd)
    if (res.code !== 0) return { ok: false, error: failReason(res) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Map a non-zero git step to its failure reason. git puts switch refusals / collisions on
 * STDERR, so prefer stderr and fall back to stdout — never collapse to a generic message
 * (#78 / #86 style).
 */
function failReason(res: { stdout: string; stderr?: string; code: number }): string {
  return (res.stderr ?? '').trim() || res.stdout.trim() || 'git command failed'
}
