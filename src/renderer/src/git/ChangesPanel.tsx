import { useEffect, useState, type JSX } from 'react'
import { Check, ChevronDown, ChevronRight, GitBranch, RefreshCw } from 'lucide-react'
import type { GitBranch as GitBranchInfo, GitStatus } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { buildChangesView, reconcileUnchecked, type GitFileView } from './status-view'
import { DiffWorkerProvider } from './DiffWorkerProvider'
import { DiffView } from './DiffView'

/**
 * The right "Changes" panel for a connected Workspace (#84, ADR-0008). It subscribes to
 * the Workspace's STREAMED git status while it is the ACTIVE one (`isActive`), holds the
 * latest snapshot, and renders the branch header + changed-files list. Clicking a file
 * opens its working-tree diff (#85): the panel has two modes —
 *  - LIST: the narrow (`w-72`) file list + branch header (the #84 view).
 *  - DIFF: a WIDER (`flex-1`) view of the selected file's diff (`DiffView`), with a
 *    "← Changes" back button. A diff needs width, so the panel widens rather than
 *    cramming a side-by-side into 72px.
 * The status subscription runs in BOTH modes (the effect is render-mode-independent), so
 * the panel keeps streaming while a diff is open — and if the selected file drops out of
 * the changed set (reverted / committed), the panel falls back to the list.
 *
 * Subscription lifecycle (active-Workspace-only, ADR-0008): the effect runs only when
 * active, registering `onGitStatus` (filtered by `workspaceDir`) and calling
 * `gitSubscribeStatus`; its cleanup removes the listener and `gitUnsubscribeStatus`.
 * ConnectedWorkspace stays MOUNTED (hidden) for background Workspaces, so gating on
 * `isActive` — not mere mount — is what bounds streaming to one watcher + one fetch.
 *
 * Degrades to nothing for a non-repo Workspace (`isRepo:false`) or before the first
 * snapshot — "a Workspace need not be a git repo" (CONTEXT.md): no panel, not an error.
 */
export function ChangesPanel({
  workspaceDir,
  isActive,
  busy,
}: {
  workspaceDir: string
  isActive: boolean
  /**
   * Whether this Workspace has a streaming turn (#86 concurrency guard). The agent can
   * run `git commit` itself as a tool-call mid-turn, so the v1 guard simply DISABLES the
   * commit affordance while a turn is in flight — there is no concurrent user+agent
   * commit (no locks/queues). Status re-reads after the turn (#84 turn-end refresh), so
   * the panel reflects whatever the agent committed before the user can commit again.
   */
  busy: boolean
}): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Commit-time file selection (#86), tracked as the paths the user DESELECTED — default
  // empty = all selected, so a new file is selected by default. `message` is the commit
  // message; `committing` blocks a double-submit; `commitError` surfaces git's reason.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set())
  const [message, setMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)

  useEffect(() => {
    if (!isActive) return
    const off = window.api.onGitStatus((event) => {
      if (event.workspaceDir === workspaceDir) setStatus(event.status)
    })
    void window.api.gitSubscribeStatus({ workspaceDir })
    return () => {
      off()
      void window.api.gitUnsubscribeStatus({ workspaceDir })
    }
  }, [workspaceDir, isActive])

  // Reconcile the deselection set on every status snapshot: drop a path that's vanished
  // (committed / reverted), keep new files selected by default. `reconcileUnchecked`
  // returns the same ref when nothing changed, so an unrelated tick is a no-op setState.
  useEffect(() => {
    const paths = status?.isRepo ? status.files.map((f) => f.path) : []
    setUnchecked((prev) => reconcileUnchecked(prev, paths))
  }, [status])

  // Manual refresh: a subscribe/unsubscribe pair re-emits a fresh snapshot without
  // changing the net ref-count (the panel keeps its own hold across this).
  function refresh(): void {
    void window.api
      .gitSubscribeStatus({ workspaceDir })
      .then(() => window.api.gitUnsubscribeStatus({ workspaceDir }))
  }

  // No panel before the first snapshot, or for a non-repo Workspace (degrade quietly).
  if (!status || !status.isRepo) return null

  const view = buildChangesView(status)

  // The selected files = everything not explicitly deselected (#86). These are the exact
  // paths handed to `gitCommit`; main stages precisely this selection then commits.
  const selectedPaths = view.files.filter((f) => !unchecked.has(f.path)).map((f) => f.path)
  const canCommit = message.trim().length > 0 && selectedPaths.length > 0 && !busy && !committing

  async function commit(): Promise<void> {
    if (!canCommit) return
    setCommitting(true)
    setCommitError(null)
    try {
      const result = await window.api.gitCommit({ workspaceDir, message: message.trim(), paths: selectedPaths })
      if (result.ok) {
        // The committed files drop off via the status refresh main triggers; clear the
        // message so the next commit starts fresh. The deselection set reconciles itself
        // as the now-committed paths vanish from the next snapshot.
        setMessage('')
      } else {
        // Recoverable: surface git's actual reason inline; the user can edit + retry.
        setCommitError(result.error)
      }
    } finally {
      // Always re-enable the button — even if the IPC unexpectedly rejects, it can't
      // stick on "Committing…".
      setCommitting(false)
    }
  }

  // DIFF mode, gated on `isActive` so a backgrounded (mounted-hidden) Workspace left
  // in DIFF doesn't keep the `@pierre/diffs` worker pool alive while off-screen — and
  // only while the selected file is STILL in the changed set, so a streamed status
  // update that drops it (revert / commit) falls the panel back to the list. `selected`
  // is re-derived from the LIVE view each render, so its `untracked` + churn stay
  // current — and feeding the churn to `DiffView` re-fetches the open diff on an edit.
  const selected = isActive && selectedPath ? view.files.find((f) => f.path === selectedPath) : undefined
  if (selected) {
    return (
      <aside className="flex min-h-0 flex-1 shrink-0 flex-col self-stretch border-l border-border bg-panel text-text">
        <DiffWorkerProvider>
          <DiffView
            workspaceDir={workspaceDir}
            file={{
              path: selected.path,
              untracked: selected.untracked,
              insertions: selected.insertions,
              deletions: selected.deletions,
            }}
            onBack={() => setSelectedPath(null)}
          />
        </DiffWorkerProvider>
      </aside>
    )
  }

  return (
    <aside className="w-72 shrink-0 border-l border-border bg-panel text-text">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
        >
          {collapsed ? (
            <ChevronRight size={14} aria-hidden className="shrink-0 text-muted" />
          ) : (
            <ChevronDown size={14} aria-hidden className="shrink-0 text-muted" />
          )}
          <span>Changes</span>
          {view.fileCount > 0 && <span className="text-muted">{view.fileCount}</span>}
        </button>
        <button
          type="button"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh git status"
          className="shrink-0 text-muted hover:text-accent-text"
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {!collapsed && (
        <>
          <BranchMenu
            workspaceDir={workspaceDir}
            branch={view.branch}
            ahead={view.ahead}
            behind={view.behind}
            busy={busy}
          />

          {view.files.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted">No changes — working tree clean.</p>
          ) : (
            <>
              <ul className="flex flex-col py-1">
                {view.files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    checked={!unchecked.has(file.path)}
                    onToggle={() =>
                      setUnchecked((prev) => {
                        const next = new Set(prev)
                        if (next.has(file.path)) next.delete(file.path)
                        else next.add(file.path)
                        return next
                      })
                    }
                    onSelect={() => setSelectedPath(file.path)}
                  />
                ))}
              </ul>

              {/* Commit area (#86): message + "Commit N". Disabled on an empty message,
                  no selection, or `busy` (the v1 concurrency guard — no concurrent
                  user+agent commit). git's reason surfaces inline + recoverable. */}
              <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Commit message"
                  rows={2}
                  className="w-full resize-y border border-border bg-panel px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
                  // Ctrl/Cmd+Enter commits, matching the prompt composer's submit chord.
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault()
                      void commit()
                    }
                  }}
                />
                {commitError && (
                  <p className="text-[11px] text-bad" role="alert">
                    {commitError}
                  </p>
                )}
                {busy && <p className="text-[11px] text-muted">Agent is working…</p>}
                <button
                  type="button"
                  onClick={() => void commit()}
                  disabled={!canCommit}
                  className="bg-accent px-2 py-1 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {committing ? 'Committing…' : `Commit ${selectedPaths.length}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </aside>
  )
}

/**
 * The branch header dropdown (#87): the current branch name as a base-ui Menu trigger
 * that, ON OPEN, fetches the Workspace's branches (`gitBranches`) and lists them for a
 * one-click checkout (`gitCheckout`); a "Create branch…" item reveals an inline input
 * (`gitCreateBranch`). The ahead/behind indicator stays beside the trigger (unchanged).
 *
 * Disabled while `busy` (a turn streams) — the same guard as commit: we don't switch
 * branches under the agent mid-turn (a switch rewrites the working tree). A checkout /
 * create error surfaces inline + recoverable (the common one is git's dirty-tree
 * refusal — NO data loss, git protects). The status STREAM updates the header on a
 * successful switch (main re-reads after the op), so this holds no branch-name state.
 */
function BranchMenu({
  workspaceDir,
  branch,
  ahead,
  behind,
  busy,
}: {
  workspaceDir: string
  branch: string
  ahead: number
  behind: number
  busy: boolean
}): JSX.Element {
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // The recoverable error from a checkout / create (dirty-tree refusal, name collision).
  const [opError, setOpError] = useState<string | null>(null)
  // The inline "Create branch…" affordance: revealed by the menu item, below the header.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busyOp, setBusyOp] = useState(false)

  // Fetch the branch list each time the menu opens, so it reflects branches created out
  // of band (a terminal `git branch`, the agent) without a panel-wide subscription.
  async function loadBranches(): Promise<void> {
    setLoading(true)
    setListError(null)
    try {
      const result = await window.api.gitBranches({ workspaceDir })
      if (result.ok) setBranches(result.branches)
      else {
        setBranches([])
        setListError(result.error)
      }
    } finally {
      setLoading(false)
    }
  }

  async function checkout(name: string): Promise<void> {
    if (busy || busyOp) return
    setBusyOp(true)
    setOpError(null)
    try {
      // Pass the branch's FULL name + `track`: a remote-only `<remote>/<branch>` goes
      // through `git switch --track` (an unambiguous tracking-local create — robust even
      // with two remotes sharing a trailing name); a local name (which may contain `/`,
      // e.g. `feat/x`) switches verbatim. `info.isRemote` decides.
      const info = branches?.find((b) => b.name === name)
      const result = await window.api.gitCheckout({ workspaceDir, name, track: info?.isRemote ?? false })
      // On success the streamed status refresh updates the header to the new branch.
      if (!result.ok) setOpError(result.error)
    } finally {
      setBusyOp(false)
    }
  }

  async function createBranch(): Promise<void> {
    const name = newName.trim()
    if (!name || busy || busyOp) return
    setBusyOp(true)
    setOpError(null)
    try {
      const result = await window.api.gitCreateBranch({ workspaceDir, name })
      if (result.ok) {
        // The header updates via the streamed status refresh; clear + close the input.
        setNewName('')
        setCreating(false)
      } else {
        setOpError(result.error)
      }
    } finally {
      setBusyOp(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs text-muted">
        <Menu
          onOpenChange={(open) => {
            if (open) void loadBranches()
          }}
        >
          <MenuTrigger
            disabled={busy}
            title={busy ? 'Agent is working…' : branch}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 text-left',
              'hover:text-accent-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted',
            )}
          >
            <GitBranch size={13} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium text-text">{branch}</span>
            <ChevronDown size={12} aria-hidden className="shrink-0" />
          </MenuTrigger>
          <MenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-1.5 text-xs text-muted">Loading…</div>
            ) : listError ? (
              <div className="px-3 py-1.5 text-xs text-bad">{listError}</div>
            ) : branches && branches.length > 0 ? (
              branches.map((b) => (
                <MenuItem key={b.name} onClick={() => void checkout(b.name)} disabled={b.current}>
                  <Check size={12} aria-hidden className={cn('shrink-0', b.current ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.isRemote && <span className="shrink-0 text-[10px] uppercase text-muted">remote</span>}
                </MenuItem>
              ))
            ) : (
              <div className="px-3 py-1.5 text-xs text-muted">No branches.</div>
            )}
            <MenuSeparator className="my-1 h-px bg-border" />
            <MenuItem onClick={() => setCreating(true)}>
              <span className="w-3 shrink-0" aria-hidden />
              Create branch…
            </MenuItem>
          </MenuContent>
        </Menu>
        {(ahead > 0 || behind > 0) && (
          <span className="shrink-0 tabular-nums" title={`${ahead} ahead, ${behind} behind`}>
            {ahead > 0 && <>↑{ahead}</>}
            {ahead > 0 && behind > 0 && ' '}
            {behind > 0 && <>↓{behind}</>}
          </span>
        )}
      </div>

      {creating && (
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
          <input
            autoFocus
            aria-label="New branch name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New branch name"
            disabled={busy || busyOp}
            className="min-w-0 flex-1 border border-border bg-panel px-2 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void createBranch()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setCreating(false)
                setNewName('')
                setOpError(null)
              }
            }}
          />
          <button
            type="button"
            onClick={() => void createBranch()}
            disabled={busy || busyOp || newName.trim().length === 0}
            className="shrink-0 bg-accent px-2 py-1 text-xs font-medium text-on-accent hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create
          </button>
        </div>
      )}

      {opError && (
        <p className="border-b border-border px-3 py-2 text-[11px] text-bad" role="alert">
          {opError}
        </p>
      )}
    </>
  )
}

/** A glyph's accent: added/untracked read positive, deleted negative, else neutral. */
function glyphClass(glyph: string): string {
  if (glyph === 'A' || glyph === 'U') return 'text-ok'
  if (glyph === 'D') return 'text-bad'
  return 'text-accent-text'
}

/**
 * One changed-file row. A leading checkbox toggles the file's commit selection (#86)
 * WITHOUT opening the diff (it's a separate control, not nested in the row button);
 * clicking the rest of the row opens the file's working-tree diff (#85, DIFF mode).
 */
function FileRow({
  file,
  checked,
  onToggle,
  onSelect,
}: {
  file: GitFileView
  checked: boolean
  onToggle: () => void
  onSelect: () => void
}): JSX.Element {
  return (
    <li className="flex items-center hover:bg-accent/10">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${file.path} in commit`}
        title="Include in commit"
        className="ml-3 shrink-0 accent-accent"
      />
      <button
        type="button"
        onClick={onSelect}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left text-xs"
      >
        <span
          className={cn('w-3 shrink-0 text-center font-semibold tabular-nums', glyphClass(file.glyph))}
          title={file.glyphLabel}
          aria-label={file.glyphLabel}
        >
          {file.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate" dir="rtl">
          {file.path}
        </span>
        {(file.insertions > 0 || file.deletions > 0) && (
          <span className="shrink-0 tabular-nums text-[11px]">
            {file.insertions > 0 && <span className="text-ok">+{file.insertions}</span>}
            {file.insertions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-bad">−{file.deletions}</span>}
          </span>
        )}
      </button>
    </li>
  )
}
