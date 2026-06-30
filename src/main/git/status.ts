import { execFile, type ExecFileException } from 'node:child_process'
import { getShellEnv } from '../shell-env'
import type { GitFile, GitStatus } from '../../shared/ipc'

/**
 * Read a Workspace working tree's git status (#84, ADR-0008). Git runs in MAIN via
 * `child_process` (ADR-0002 thin orchestrator) — no git2 / isomorphic-git. The PURE
 * `parseGitStatus` is the testable seam (it never shells out); `readGitStatus` is the
 * thin impure shell that runs the git commands (through an injectable runner,
 * mirroring `AcpClient`'s `spawn` injection) and feeds the parser.
 *
 * v1 is purely OBSERVATIONAL: status only, no writes. Any git failure (a non-repo
 * Workspace, a missing `git`, a broken index) is swallowed into `isRepo:false` — it
 * NEVER throws into the stream, so a watcher tick or a fetch can't crash the manager.
 */

/**
 * Run a git command and capture its stdout + exit code. Injectable for tests so they
 * never shell real git (Seam, mirroring `AcpClient.spawn`). The default resolves
 * `git` via the shell-env PATH (so a Finder/Dock launch still finds it, like the
 * agent spawn) and resolves — never rejects — with the exit code even on failure.
 */
export type GitRun = (args: string[], cwd: string) => Promise<{ stdout: string; code: number }>

export const defaultGitRun: GitRun = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, env: getShellEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err: ExecFileException | null, stdout: string) => {
        // execFile's `err.code` is the numeric exit code on a non-zero exit, or a
        // string (e.g. 'ENOENT' when git is missing) on a spawn failure — map both
        // to a non-zero code so the caller degrades to `isRepo:false`.
        const code = err == null ? 0 : typeof err.code === 'number' ? err.code : 1
        resolve({ stdout: stdout ?? '', code })
      },
    )
  })

/** The empty, not-a-repo status — also the swallow-all-errors fallback. */
function notARepo(): GitStatus {
  return { isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
}

interface Numstat {
  insertions: number
  deletions: number
}

/**
 * Parse one `git diff --numstat` / `git diff --cached --numstat` block into a
 * path -> {insertions, deletions} map. Each line is `<ins>\t<del>\t<path>`; a binary
 * file reports `-`/`-` (parsed as 0/0). A rename shows in the path as `old => new`
 * (optionally with a `{old => new}` brace segment) — we normalize to the NEW path so
 * it keys the same as the porcelain=2 entry's (new) path.
 */
function parseNumstat(numstat: string): Map<string, Numstat> {
  const map = new Map<string, Numstat>()
  for (const line of numstat.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const secondTab = line.indexOf('\t', tab + 1)
    if (secondTab < 0) continue
    const insRaw = line.slice(0, tab)
    const delRaw = line.slice(tab + 1, secondTab)
    const rawPath = line.slice(secondTab + 1)
    map.set(normalizeRenamePath(rawPath), {
      insertions: insRaw === '-' ? 0 : Number(insRaw) || 0,
      deletions: delRaw === '-' ? 0 : Number(delRaw) || 0,
    })
  }
  return map
}

/** Resolve a numstat rename path (`old => new` or `pre/{old => new}/post`) to the new path. */
function normalizeRenamePath(path: string): string {
  if (path.includes('{') && path.includes(' => ')) {
    // `pre/{old => new}/post` -> `pre/new/post`
    return path.replace(/\{[^}]*? => ([^}]*?)\}/g, '$1').replace(/\/{2,}/g, '/')
  }
  const arrow = path.indexOf(' => ')
  return arrow >= 0 ? path.slice(arrow + 4) : path
}

/**
 * PURE parser (#84): turn `git status --porcelain=2 --branch` + the two numstat
 * blocks into a `GitStatus`. The porcelain=2 grammar (verified against real git):
 *  - `# branch.head <name>` (`(detached)` when detached), `# branch.upstream <name>`,
 *    `# branch.ab +<ahead> -<behind>` (both header lines absent with no upstream).
 *  - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — an ordinary changed entry.
 *  - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<orig>` — rename/copy.
 *  - `u <XY> ... <path>` — unmerged; `? <path>` — untracked; `! <path>` — ignored.
 * The XY code's X (index) half being non-`.`/`?` marks the path `staged`.
 */
export function parseGitStatus(porcelain: string, numstat: string, cachedNumstat: string): GitStatus {
  const status: GitStatus = { isRepo: true, branch: null, upstream: null, ahead: 0, behind: 0, files: [] }
  const unstaged = parseNumstat(numstat)
  const staged = parseNumstat(cachedNumstat)

  for (const line of porcelain.split('\n')) {
    if (!line) continue
    if (line.startsWith('# ')) {
      parseHeader(line.slice(2), status)
      continue
    }
    const kind = line[0]
    if (kind === '1' || kind === '2') {
      const file = parseChangedEntry(line, kind, unstaged, staged)
      if (file) status.files.push(file)
    } else if (kind === '?') {
      const path = line.slice(2)
      status.files.push({ path, status: '?', insertions: 0, deletions: 0, staged: false, untracked: true })
    }
    // `u` (unmerged) and `!` (ignored, not requested) are intentionally skipped in v1.
  }
  return status
}

/** Fold one `# branch.*` header line into the status (mutates). */
function parseHeader(rest: string, status: GitStatus): void {
  if (rest.startsWith('branch.head ')) {
    const name = rest.slice('branch.head '.length)
    status.branch = name === '(detached)' ? null : name
  } else if (rest.startsWith('branch.upstream ')) {
    status.upstream = rest.slice('branch.upstream '.length)
  } else if (rest.startsWith('branch.ab ')) {
    // `+<ahead> -<behind>`
    const m = /\+(-?\d+) -(-?\d+)/.exec(rest.slice('branch.ab '.length))
    if (m) {
      status.ahead = Number(m[1]) || 0
      status.behind = Number(m[2]) || 0
    }
  }
}

/**
 * Parse a `1`/`2` changed entry into a `GitFile`, merging its numstat churn. The
 * path is the remainder after the fixed leading fields (8 for `1`, 9 for `2`, the
 * extra being the rename score); a `2` entry's path is `<new>\t<orig>` so we take the
 * portion before the tab. Insertions/deletions sum the staged + unstaged numstat for
 * the path (an `MM` file is dirty in both), so the panel shows total churn.
 */
function parseChangedEntry(
  line: string,
  kind: '1' | '2',
  unstaged: Map<string, Numstat>,
  staged: Map<string, Numstat>,
): GitFile | null {
  const leadingFields = kind === '1' ? 8 : 9
  const { fields, rest } = splitLeading(line, leadingFields)
  if (fields.length < leadingFields) return null
  const xy = fields[1]
  const path = kind === '2' ? rest.split('\t')[0] : rest
  if (!path) return null
  const churn = {
    insertions: (unstaged.get(path)?.insertions ?? 0) + (staged.get(path)?.insertions ?? 0),
    deletions: (unstaged.get(path)?.deletions ?? 0) + (staged.get(path)?.deletions ?? 0),
  }
  return {
    path,
    status: xy,
    insertions: churn.insertions,
    deletions: churn.deletions,
    // X (index) half non-`.` => staged. (`?`/`!` never reach here.)
    staged: xy[0] !== '.' && xy[0] !== '?',
    untracked: false,
  }
}

/** Split off the first `n` space-delimited fields, keeping the remainder (the path) intact. */
function splitLeading(line: string, n: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let i = 0
  for (let f = 0; f < n; f++) {
    const sp = line.indexOf(' ', i)
    if (sp < 0) {
      fields.push(line.slice(i))
      return { fields, rest: '' }
    }
    fields.push(line.slice(i, sp))
    i = sp + 1
  }
  return { fields, rest: line.slice(i) }
}

/**
 * Impure read (#84): run the git commands for `cwd` and parse them. First gate on
 * `git rev-parse --is-inside-work-tree`; on non-zero (non-repo / no git) return the
 * empty `isRepo:false` status. All git errors are swallowed into that fallback — this
 * NEVER throws, so a watcher tick or background fetch can't crash the status manager.
 */
export async function readGitStatus(cwd: string, run: GitRun = defaultGitRun): Promise<GitStatus> {
  try {
    const inside = await run(['rev-parse', '--is-inside-work-tree'], cwd)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return notARepo()
    // `-c core.quotePath=false` so paths with non-ASCII chars (accented / CJK /
    // emoji) come back as plain UTF-8, not octal-escaped + quoted (git's default
    // would render `src/héllo.txt` as the literal `"src/h\303\251llo.txt"` in the
    // panel). Applied to BOTH status and the numstats so their path keys still match.
    const [porcelain, numstat, cachedNumstat] = await Promise.all([
      // `--untracked-files=all` expands an untracked DIRECTORY into its individual
      // files (the default `normal` mode collapses it to one `? dir/` entry, which
      // the diff viewer can't `--no-index` against — it'd dead-click on `dir/`).
      run(['-c', 'core.quotePath=false', 'status', '--porcelain=2', '--branch', '--untracked-files=all'], cwd),
      run(['-c', 'core.quotePath=false', 'diff', '--numstat'], cwd),
      run(['-c', 'core.quotePath=false', 'diff', '--cached', '--numstat'], cwd),
    ])
    if (porcelain.code !== 0) return notARepo()
    return parseGitStatus(porcelain.stdout, numstat.stdout, cachedNumstat.stdout)
  } catch {
    return notARepo()
  }
}

/**
 * Best-effort background `git fetch` for the remote-tracking refresh (#84). Quiet and
 * swallow-all: an offline / no-upstream / auth-failed fetch just resolves (the caller
 * re-reads status either way, so ahead/behind simply stays as it was). Never throws.
 */
export async function gitFetch(cwd: string, run: GitRun = defaultGitRun): Promise<void> {
  try {
    await run(['fetch', '--quiet'], cwd)
  } catch {
    // best-effort — a failed fetch is a no-op for the stream.
  }
}
