/**
 * Files domain of the shared IPC contract: reveal a chip-referenced path in the OS file
 * manager (#116) and the confined Files Surface list / read (#188/#189, ADR-0013). All
 * three are addressed by `agentId` and confined to the warm agent's OWN Workspace root.
 * Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The files channel entries, merged into the single `IPC` const in `./index`. */
export const filesChannels = {
  /** Renderer -> main: REVEAL a chip-referenced file in the OS file manager (#116) — see {@link RevealPathArgs}. */
  revealPath: 'shell:reveal-path',
  /** Renderer -> main: LIST the active Workspace's files for the Files Surface tree (#188) — see {@link FilesListArgs}. */
  filesList: 'files:list',
  /** Renderer -> main: READ one Workspace file for the read-only preview (#189) — see {@link FilesReadArgs}. */
  filesRead: 'files:read',
} as const

/**
 * Args for `revealPath` (#116): reveal a file referenced by a clickable file-path chip in
 * the OS file manager. Fire-and-forget (invoke → `Promise<void>`, like `respondPermission`).
 * `agentId` identifies the hosting Workspace agent so main can resolve `path`'s Workspace
 * cwd (the renderer has no fs, so relative→absolute resolution is main's job) and confine
 * it. `path` is the `FileLink.path` from the chip — already stripped of any `:line:col`
 * position. The chip text is AGENT-AUTHORED (untrusted), so main never OPENS/executes the
 * target — it resolves the (possibly relative) path against the agent's Workspace cwd,
 * CONFINES it to the Workspace (symlink-resolved), and calls `shell.showItemInFolder`
 * (highlight only, no Launch Services / code execution). Best-effort — an out-of-Workspace
 * or bad path is a logged no-op, never thrown. Reveal can't deep-link a line, so the chip's
 * `Lx:Cy` ref stays display-only. (Do NOT switch this to `shell.openPath` — that would
 * execute `.app`/`.command`/installers from untrusted markdown on one click.)
 */
export interface RevealPathArgs {
  agentId: string
  path: string
}

/**
 * Args for `filesList` (#188, ADR-0013 decisions 3-4): list one Workspace's files.
 * Addressed by `agentId` — main resolves the listing root from the warm agent's OWN
 * `workspaceDir` (`pool.get(agentId)`), NOT from a renderer-supplied path (#188 security
 * review F3). This mirrors `revealPath`'s stricter model rather than the git handlers'
 * raw-`workspaceDir` one: the renderer can only list a CONNECTED Workspace's tree, never an
 * arbitrary main-readable directory. The walk honors `.gitignore` (root + nested),
 * HARD-SKIPS `.git`, includes dotfiles, caps at ~20k entries, and is Workspace-root-confined
 * + symlink-safe — deliberately STRICTER than the agent's unconfined `fs/read` (ADR-0004 vs
 * ADR-0013): it never follows a symlink during the walk, so a symlinked dir is listed but not
 * descended (blocks both escapes and cycles), and no entry can contain `..` or an absolute
 * path. Main CACHES the result per agent's workspace dir; `refresh:true` (the panel's Refresh
 * button) rebuilds, and the existing git status-stream watcher firing invalidates the cache
 * (NO new fs watcher). NOT agent activity, so — like `git:diff` — it does NOT `pool.touch`.
 */
export interface FilesListArgs {
  agentId: string
  refresh?: boolean
}

/**
 * One entry in a `filesList` reply (#188). `path` is RELATIVE to the Workspace root,
 * forward-slash separated, and — by construction of the confined walk — never contains
 * `..` or an absolute path. `kind` is `directory` for a real (descended) directory;
 * everything else, INCLUDING a symlink (never followed), is reported as a `file` leaf.
 */
export interface FileEntry {
  path: string
  kind: 'file' | 'directory'
}

/**
 * The `filesList` reply (#188). `entries` is the flat, deterministically-ordered
 * (directories-first, then name) listing the renderer maps to `@pierre/trees` paths.
 * `truncated` is true when the walk hit the ~20k-entry cap and stopped early — the panel
 * shows a "· partial" indicator. The empty result (`entries:[], truncated:false`) also
 * covers a swallowed walk failure (a missing / unreadable Workspace root) — never throws.
 */
export interface FilesListResult {
  entries: FileEntry[]
  truncated: boolean
}

/**
 * Args for `filesRead` (#189, ADR-0013 decisions 2-3): read one Workspace file for the
 * read-only preview. Addressed by `agentId` — main resolves the read root from the warm
 * agent's OWN `workspaceDir` (`pool.get(agentId)`), NOT a renderer-supplied path (review F3,
 * matching `filesList`/`revealPath`); an unknown agent → `{kind:'error'}`. `relativePath` is
 * a tree-relative path from a `filesList` entry (forward-slash separated, never absolute or
 * `..`); the target is confined with the SAME machinery as `revealPath` (`resolveWorkspacePath`
 * + `realpath` + `isWithinDir`), so a `..`/absolute target or a symlink escaping the root →
 * `{kind:'error'}` (logged, never leaking the absolute path/stack). STRICTLY read-only (no
 * write path).
 */
export interface FilesReadArgs {
  agentId: string
  relativePath: string
}

/**
 * The `filesRead` reply (#189), a discriminated union so the preview renders each outcome
 * cleanly and never shows garbage. `text` carries the utf8-decoded `content`; `binary` (a NUL
 * byte was found in the first chunk) and `tooLarge` (the file exceeds the ~1MB cap, checked
 * via `stat` BEFORE any read) render muted notices; `error` covers EVERY failure — an unknown
 * agent, a confinement refusal (out-of-tree/absolute/`..`/symlink escape), a non-regular-file
 * target, or any fs throw — and never leaks an absolute path or stack to the renderer.
 * Best-effort: any throw degrades to `{kind:'error'}`, never rejects.
 */
export type FilesReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'error' }
