import { useEffect, useState, type JSX } from 'react'
import { Boxes, GitCommitHorizontal, Monitor, PanelRightClose, RefreshCw } from 'lucide-react'
import type { GitStatus } from '../../../shared/ipc'
import { Badge, Button, IconButton, Textarea } from '../ui'
import { getCommitDraft, setCommitDraft } from './commit-draft-store'
import { buildChangesView, reconcileUnchecked } from './status-view'
import { BranchMenu } from './BranchMenu'
import { PrSection } from './PrSection'
import { FileRow } from './FileRow'
import { DiffWorkerProvider } from './DiffWorkerProvider'
import { DiffView } from './DiffView'

/**
 * The right "Changes" panel for a connected Workspace (#84, ADR-0008). It subscribes to
 * the Workspace's STREAMED git status while it is the ACTIVE one (`isActive`), holds the
 * latest snapshot, and renders the branch header + changed-files list. Clicking a file
 * opens its working-tree diff (#85): the panel has two modes —
 *  - LIST: the file list + branch header (the #84 view), filling the SurfacePanel shell.
 *  - DIFF: a WIDER (`flex-1`) view of the selected file's diff (`DiffView`), with a
 *    "← Changes" back button. A diff needs width, so the panel widens rather than
 *    cramming a side-by-side into 80px.
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
 *
 * Visuals (#119, ADR-0010): the panel is on the design-system primitives + the warm,
 * rounded "Environment / Review" aesthetic — Button / Input / Textarea / Badge and the
 * soft `--border-muted` dividers. The git BEHAVIOUR is untouched (ADR-0008): only the
 * chrome changed.
 *
 * Re-homed as the Review Surface (#187, ADR-0013): this is now rendered by `SurfacePanel`
 * only when the Review Surface is expanded. Its former standalone collapse toggle is
 * FOLDED into the Surface model — the header collapse affordance calls `onCollapse`, which
 * returns to the launcher-card stack. The git behaviour above is unchanged.
 */
export function ChangesPanel({
  workspaceDir,
  isActive,
  busy,
  onCollapse,
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
  /** Collapse the Review Surface back to the card stack (#187) — the header affordance. */
  onCollapse: () => void
}): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Commit-time file selection (#86), tracked as the paths the user DESELECTED — default
  // empty = all selected, so a new file is selected by default. `message` is the commit
  // message; `committing` blocks a double-submit; `commitError` surfaces git's reason.
  // Both seed from the module-level draft store: Surface collapse now UNMOUNTS this panel
  // (#187) where the old collapse merely hid it, so without the store a half-typed commit
  // message would be one accidental ⌃⇧G away from vanishing.
  const [unchecked, setUnchecked] = useState<Set<string>>(
    () => new Set(getCommitDraft(workspaceDir)?.unchecked ?? []),
  )
  const [message, setMessage] = useState(() => getCommitDraft(workspaceDir)?.message ?? '')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  // Bumped by the header refresh button so the PR section re-fetches `ghCurrentPr` on a
  // manual refresh too (its own effect otherwise only fires on a branch change — a PR is a
  // network call we don't tie to every status tick).
  const [prRefreshKey, setPrRefreshKey] = useState(0)

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

  // Mirror the live draft into the store on every change (#187): a successful commit
  // clears `message`, which empties (deletes) the entry via setCommitDraft's residue rule.
  useEffect(() => {
    setCommitDraft(workspaceDir, { message, unchecked })
  }, [workspaceDir, message, unchecked])

  // Manual refresh: a subscribe/unsubscribe pair re-emits a fresh snapshot without
  // changing the net ref-count (the panel keeps its own hold across this).
  function refresh(): void {
    void window.api
      .gitSubscribeStatus({ workspaceDir })
      .then(() => window.api.gitUnsubscribeStatus({ workspaceDir }))
    // Also re-check the current branch's PR (a network call the PR section keys on this).
    setPrRefreshKey((k) => k + 1)
  }

  // Before the first snapshot, or for a non-repo Workspace: the git surface degrades to a
  // quiet empty state (#84 "a Workspace need not be a git repo"). As a Surface it still
  // renders its header so the collapse affordance is always reachable (#187) — a Surface
  // must never strand the user with no way back to the card stack.
  if (!status || !status.isRepo) {
    return (
      <aside className="flex min-h-0 flex-1 flex-col text-text">
        <ReviewHeader onCollapse={onCollapse} onRefresh={refresh} />
        <p className="px-3 py-3 text-[13px] text-muted">
          {!status ? 'Loading changes…' : 'Not a Git repository.'}
        </p>
      </aside>
    )
  }

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
      <aside className="flex min-h-0 flex-1 flex-col text-text">
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
    // The SHELL (SurfacePanel) owns the panel's width + border-l chrome now; this fills
    // it and scrolls internally — the shell column is viewport-height, not <main>-scrolled.
    <aside className="flex min-h-0 flex-1 flex-col overflow-y-auto text-text">
      <ReviewHeader count={view.fileCount} onCollapse={onCollapse} onRefresh={refresh} />

      {/* Environment (#119) — a STATIC placeholder gesturing at the mockup's fuller
          "Environment / Local / Sources" side-panel (styled chrome, non-functional,
          like the sidebar's Search/Scheduled/Plugins "Soon" rows). Not wired to
          anything; the live git surface begins at the branch header below. */}
      <div className="border-b border-border-muted px-3 py-2.5">
        <p className="mb-1 px-1 text-[11px] font-medium text-faint">Environment</p>
        <div className="flex flex-col gap-0.5">
          <EnvPlaceholder icon={<Monitor className="size-4" aria-hidden />}>Local</EnvPlaceholder>
          <EnvPlaceholder icon={<Boxes className="size-4" aria-hidden />}>Sources</EnvPlaceholder>
        </div>
      </div>

      <BranchMenu
        workspaceDir={workspaceDir}
        branch={view.branch}
        ahead={view.ahead}
        behind={view.behind}
        busy={busy}
      />

      <PrSection
        workspaceDir={workspaceDir}
        branch={view.branch}
        detached={view.detached}
        hasUpstream={status.upstream !== null}
        busy={busy}
        refreshKey={prRefreshKey}
      />

      {view.files.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-muted">No changes — working tree clean.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-0.5 py-1.5">
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
          <div className="flex flex-col gap-2 border-t border-border-muted px-3 py-2.5">
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              rows={2}
              className="min-h-16 resize-y text-[13px]"
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
            <Button type="button" size="sm" className="w-full" onClick={() => void commit()} disabled={!canCommit}>
              <GitCommitHorizontal className="size-4" aria-hidden />
              {committing ? 'Committing…' : `Commit ${selectedPaths.length}`}
            </Button>
          </div>
        </>
      )}
    </aside>
  )
}

/**
 * The Review Surface header (#187): the "Changes" title + optional changed-file count, a
 * collapse-to-stack affordance (folds the panel's former standalone collapse into the
 * Surface model, ADR-0013), and the manual git-status Refresh. Shared by the live list
 * and the non-repo/pre-snapshot empty state so the collapse control is always present.
 */
function ReviewHeader({
  count,
  onCollapse,
  onRefresh,
}: {
  count?: number
  onCollapse: () => void
  onRefresh: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2.5">
      <button
        type="button"
        onClick={onCollapse}
        title="Collapse"
        aria-label="Collapse Review panel"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm font-semibold text-text-strong"
      >
        <PanelRightClose size={15} aria-hidden className="shrink-0 text-muted" />
        <span>Changes</span>
        {count !== undefined && count > 0 && (
          <Badge variant="outline" className="ml-0.5 rounded-full px-1.5 py-0 text-[11px] tabular-nums text-muted">
            {count}
          </Badge>
        )}
      </button>
      <IconButton size="icon-sm" onClick={onRefresh} title="Refresh" aria-label="Refresh git status" className="text-muted">
        <RefreshCw className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  )
}

/**
 * A static, non-functional "Environment" row (#119): the mockup's Local / Sources
 * concepts as styled-but-inert chrome, mirroring the sidebar's disabled "Soon"
 * placeholders. Purely decorative — no handler, `cursor-default`, muted + tagged.
 */
function EnvPlaceholder({ icon, children }: { icon: JSX.Element; children: string }): JSX.Element {
  return (
    <div
      title="Coming soon"
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted opacity-70"
    >
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-[10px] font-medium text-faint">Soon</span>
    </div>
  )
}
