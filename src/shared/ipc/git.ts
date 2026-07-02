/**
 * Git domain of the shared IPC contract (#84-#87, ADR-0008): the streamed status
 * subscription + push, single-file diff read, commit, and branch list / checkout /
 * create. Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The git channel entries, merged into the single `IPC` const in `./index`. */
export const gitChannels = {
  /**
   * Renderer -> main: subscribe to the active Workspace's STREAMED git status
   * (#84, ADR-0008). Ref-counted per `workspaceDir` in main — the first subscribe
   * starts one fs watcher + one background fetch and emits a `snapshot`; later
   * subscribes only bump the count (and re-emit the current snapshot). Returns void;
   * status arrives on the `gitStatus` push channel. Active-Workspace-only by
   * construction: only the mounted Changes panel subscribes (ADR-0008).
   */
  gitSubscribeStatus: 'git:subscribe-status',
  /**
   * Renderer -> main: drop one subscriber's hold on a Workspace's status stream
   * (#84). The last unsubscribe tears down the watcher + fetch timer; an over-count
   * unsubscribe is a no-op. Paired with `gitSubscribeStatus` on panel mount/unmount.
   */
  gitUnsubscribeStatus: 'git:unsubscribe-status',
  /** Main -> renderer: a streamed git-status update for a subscribed Workspace (#84) — see {@link GitStatusEvent}. */
  gitStatus: 'git:status',
  /** Renderer -> main: read ONE changed path's working-tree unified diff (#85) — see {@link GitDiffArgs}. */
  gitDiff: 'git:diff',
  /** Renderer -> main: COMMIT working-tree changes from the Changes panel (#86) — see {@link GitCommitArgs}. */
  gitCommit: 'git:commit',
  /** Renderer -> main: list the active Workspace's branches (#87) — see {@link GitBranchesArgs}. */
  gitBranches: 'git:branches',
  /** Renderer -> main: CHECK OUT a branch on the active Workspace (#87) — see {@link GitBranchOpArgs}. */
  gitCheckout: 'git:checkout',
  /** Renderer -> main: CREATE + switch to a new branch on the active Workspace (#87) — see {@link GitBranchOpArgs}. */
  gitCreateBranch: 'git:create-branch',
} as const

/**
 * One changed path in a Workspace's working tree (#84, ADR-0008). `status` is the
 * raw `git status --porcelain=2` XY code (e.g. `.M`, `A.`, `RM`, `MM`) or `?` for an
 * untracked path — the renderer maps it to a display glyph. `insertions`/`deletions`
 * are the merged `git diff` + `git diff --cached` numstat for the path (0 for a
 * binary `-`/`-` entry). `staged` is true when the index half (X) is non-clean; a
 * path can be both staged and worktree-dirty (e.g. `MM`) — `staged` then still true.
 */
export interface GitFile {
  path: string
  status: string
  insertions: number
  deletions: number
  staged: boolean
  untracked: boolean
}

/**
 * A Workspace working tree's git status (#84, ADR-0008) — the observational v1
 * payload. `isRepo:false` (with the empty defaults) covers a non-repo Workspace OR
 * any git failure swallowed into the stream (never a throw): the renderer then shows
 * no Changes panel ("a Workspace need not be a git repo", CONTEXT.md). `ahead`/
 * `behind` are 0 with no upstream; `branch`/`upstream` are null when detached / unset.
 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

/** Which trigger produced a `gitStatus` push (#84). */
export type GitStatusKind = 'snapshot' | 'localUpdated' | 'remoteUpdated'

/**
 * Main -> renderer streamed git-status update (#84). Tagged by `workspaceDir` so a
 * renderer with one mounted Changes panel ignores events for other Workspaces (the
 * push fans out to every window, like `thread:status`). `kind` distinguishes the
 * trigger — `snapshot` (on subscribe), `localUpdated` (fs watcher / turn-end / manual
 * refresh), `remoteUpdated` (background fetch refreshed ahead/behind). The renderer
 * filters by `workspaceDir` and holds the latest status.
 */
export interface GitStatusEvent {
  workspaceDir: string
  kind: GitStatusKind
  status: GitStatus
}

/** Args for `gitSubscribeStatus` / `gitUnsubscribeStatus` (#84). */
export interface GitStatusSubscriptionArgs {
  workspaceDir: string
}

/**
 * Args for `gitDiff` (#85, ADR-0008): read one changed path's working-tree diff. `path`
 * is the `GitFile.path` (relative to the Workspace root, as `git status` reported it).
 * `untracked` routes to the `git diff --no-index -- /dev/null <path>` form (a new file
 * has no index entry to diff against). `ignoreWhitespace` re-reads the diff with `-w`
 * for the panel's whitespace toggle — @pierre can't ignore whitespace on a pre-parsed
 * patch, so the toggle drives a fresh read (a new `diffHash`) here. The renderer parses
 * + renders the patch with `@pierre/diffs`; main only shells `git diff`. Working-tree
 * source only, read-only. Not agent activity, so it does NOT touch the warm-agent pool.
 */
export interface GitDiffArgs {
  workspaceDir: string
  path: string
  untracked: boolean
  ignoreWhitespace?: boolean
}

/**
 * The `gitDiff` reply (#85): a changed path's RAW working-tree unified diff plus a
 * content `diffHash` (sha256 of `patch`) the renderer memoizes on, so an unchanged
 * file skips a re-parse / re-render. `truncated` is true when the patch was capped
 * (~120 KB) — the viewer flags it. The empty result (`patch:''`, `diffHash:''`,
 * `truncated:false`) covers BOTH a clean path (no diff) and a swallowed git failure;
 * the renderer renders nothing for it (degrade quietly, like #84's non-repo panel).
 */
export interface GitDiffResult {
  patch: string
  diffHash: string
  truncated: boolean
}

/**
 * Args for `gitCommit` (#86, ADR-0008 — the first git WRITE): commit working-tree
 * changes. `message` is the commit message (the panel disables Commit on an
 * empty/whitespace one). `paths` is the commit-time selection of `GitFile.path`s — a
 * NON-empty subset stages exactly those (a mixed `reset` + `add -- <paths>`), an EMPTY
 * array commits ALL changes (`add -A`). On success main re-reads status
 * (`gitStatus.refresh`) so the committed files drop off the panel — a `.git`-only
 * change the fs watcher won't see, like #84's turn-end refresh. NOT agent activity, so
 * it does NOT touch the warm-agent pool (like `git:diff`).
 */
export interface GitCommitArgs {
  workspaceDir: string
  message: string
  paths: string[]
}

/**
 * The `gitCommit` reply (#86). `{ok:true}` on a clean commit (main then refreshes the
 * Changes panel so the committed files drop off). `{ok:false, error}` carries git's
 * ACTUAL reason — "nothing to commit", a failed pre-commit hook, an index lock — not a
 * collapsed "commit failed" (#78 style). The renderer shows `error` inline + recoverable.
 */
export type GitCommitResult = { ok: true } | { ok: false; error: string }

/**
 * One branch in a Workspace's repo (#87). `name` is the local branch name (e.g. `main`,
 * `feat/x`) or, for a remote-only branch, the `<remote>/<branch>` name (e.g.
 * `origin/feature`). `isRemote` distinguishes the two; `current` marks the checked-out
 * branch; `isDefault` marks the repo's default branch (best-effort from origin/HEAD,
 * false everywhere when unresolved). The list shows local branches + only the remotes
 * with NO matching local (deduped), so a tracked branch appears once.
 */
export interface GitBranch {
  name: string
  isRemote: boolean
  current: boolean
  isDefault: boolean
}

/**
 * The `gitBranches` reply (#87). `{ok:true, branches}` on a successful list (local +
 * remote-only, deduped). `{ok:false, error}` carries git's actual reason (e.g. not a
 * git repository) — never a collapsed message. The dropdown surfaces the error inline.
 */
export type GitBranchesResult = { ok: true; branches: GitBranch[] } | { ok: false; error: string }

/**
 * The reply shape for a branch WRITE — `gitCheckout` / `gitCreateBranch` (#87).
 * `{ok:true}` on a clean switch/create (main then refreshes status so the panel header
 * shows the new branch). `{ok:false, error}` carries git's ACTUAL reason — a dirty-tree
 * checkout refusal (NO data loss; git protects), a name collision — surfaced inline +
 * recoverable.
 */
export type GitOpResult = { ok: true } | { ok: false; error: string }

/**
 * Args for `gitBranches` (#87): list one Workspace's branches. Read-only, so — like
 * `git:diff` — it does NOT touch the warm-agent pool. The dropdown fetches on open.
 */
export interface GitBranchesArgs {
  workspaceDir: string
}

/**
 * Args for `gitCheckout` / `gitCreateBranch` (#87). For a CHECKOUT `name` is the branch's
 * full name and `track` says whether it's a remote-only branch: `track:true` →
 * `git switch --track <remote>/<branch>` (an unambiguous tracking-local create), else
 * `git switch <name>` (a local name, which may contain `/`, switches verbatim). For a
 * CREATE, `name` is the NEW branch name (`git switch -c <name>` from the current HEAD;
 * no base ref in v1, `track` unused). On success main re-reads status so the header
 * shows the new branch.
 */
export interface GitBranchOpArgs {
  workspaceDir: string
  name: string
  track?: boolean
}
