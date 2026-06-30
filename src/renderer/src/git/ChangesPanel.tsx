import { useEffect, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from 'lucide-react'
import type { GitStatus } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { buildChangesView, type GitFileView } from './status-view'

/**
 * The collapsible right "Changes" panel for a connected Workspace (#84, ADR-0008).
 * It subscribes to the Workspace's STREAMED git status while it is the ACTIVE one
 * (`isActive`), holds the latest snapshot, and renders the branch header + the
 * changed-files list. v1 is purely observational — a file row is a no-op stub (the
 * diff view is slice #85).
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
}: {
  workspaceDir: string
  isActive: boolean
}): JSX.Element | null {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [collapsed, setCollapsed] = useState(false)

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
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs text-muted">
            <GitBranch size={13} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium text-text" title={view.branch}>
              {view.branch}
            </span>
            {(view.ahead > 0 || view.behind > 0) && (
              <span className="shrink-0 tabular-nums" title={`${view.ahead} ahead, ${view.behind} behind`}>
                {view.ahead > 0 && <>↑{view.ahead}</>}
                {view.ahead > 0 && view.behind > 0 && ' '}
                {view.behind > 0 && <>↓{view.behind}</>}
              </span>
            )}
          </div>

          {view.files.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted">No changes — working tree clean.</p>
          ) : (
            <ul className="flex flex-col py-1">
              {view.files.map((file) => (
                <FileRow key={file.path} file={file} />
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  )
}

/** A glyph's accent: added/untracked read positive, deleted negative, else neutral. */
function glyphClass(glyph: string): string {
  if (glyph === 'A' || glyph === 'U') return 'text-ok'
  if (glyph === 'D') return 'text-bad'
  return 'text-accent-text'
}

/** One changed-file row. Clicking is a no-op stub — the diff view is slice #85. */
function FileRow({ file }: { file: GitFileView }): JSX.Element {
  return (
    <li>
      <button
        type="button"
        // diff view — slice #85 (no-op for now).
        onClick={() => {}}
        title={file.path}
        className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent/10"
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
