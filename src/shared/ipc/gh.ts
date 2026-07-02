/**
 * GitHub domain of the shared IPC contract (#88, slice 4, ADR-0008): read the current
 * branch's PR and create a PR, both via the `gh` CLI. Keep this file free of Node/DOM
 * imports so both sides can consume it.
 */

/** The gh channel entries, merged into the single `IPC` const in `./index`. */
export const ghChannels = {
  /** Renderer -> main: read the CURRENT branch's GitHub PR via `gh` (#88) — see {@link GhPrResult}. */
  ghCurrentPr: 'gh:current-pr',
  /** Renderer -> main: CREATE a PR for the current branch via `gh pr create` (#88) — see {@link GhCreatePrArgs}. */
  ghCreatePr: 'gh:create-pr',
} as const

/**
 * A GitHub pull request, as `gh pr view --json number,title,url,state` reports it (#88).
 * `state` is gh's uppercase status — `OPEN` / `CLOSED` / `MERGED` (kept verbatim; the
 * renderer tints the chip on it). `url` is the PR's web URL (opened externally via the
 * renderer's `target="_blank"` anchor -> main's `setWindowOpenHandler` -> `shell.openExternal`).
 */
export interface GhPr {
  number: number
  title: string
  url: string
  state: string
}

/**
 * The `ghCurrentPr` reply (#88). `{ok:true, pr}` where `pr` is the current branch's PR or
 * `null` (no PR for the branch, or the repo isn't on GitHub — both a normal "no PR
 * surface", NOT an error). `{ok:false, error}` is reserved for gh-missing / not-authed /
 * an unexpected gh failure — surfaced as a subtle hint in the panel, never a crash. A
 * NETWORK call (gh hits the GitHub API), so the renderer fetches on branch-change +
 * manual refresh, NOT on every status tick. Read-only, so it does NOT touch the pool.
 */
export type GhPrResult = { ok: true; pr: GhPr | null } | { ok: false; error: string }

/**
 * The `ghCreatePr` reply (#88). `{ok:true, url}` carries the new PR's URL (gh prints it on
 * success — the renderer shows the chip + opens it externally). `{ok:false, error}` carries
 * a friendly reason: gh-missing, the `gh auth login` hint, "push your branch first", or
 * gh's verbatim stderr — surfaced inline + recoverable.
 */
export type GhCreateResult = { ok: true; url: string } | { ok: false; error: string }

/** Args for `ghCurrentPr` (#88): read one Workspace's current-branch PR. */
export interface GhCurrentPrArgs {
  workspaceDir: string
}

/**
 * Args for `ghCreatePr` (#88): create a PR for one Workspace's current branch. gh inherits
 * the user's `gh auth`; we pass no `--base` (gh defaults to the repo's default branch) and
 * do NOT push (the renderer gates the affordance on the branch having an upstream). NOT
 * agent activity, so no `pool.touch`.
 */
export interface GhCreatePrArgs {
  workspaceDir: string
  title: string
  body: string
}
