import { useState, type JSX, type ReactNode } from 'react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import { isThreadDeletable, type UnifiedThreadRow } from './unified-threads'

/** A Workspace's rolled-up live status, for its switcher row. */
export interface WorkspaceFlags {
  streaming: boolean
  needsAttention: boolean
}

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Navigation
 * (the pure nav reducer, decision 2) and the per-Workspace connection registry
 * (decision 3) live in App; Shell is the presentational layout.
 *
 * TB3 (#48) collapses the two competing Thread lists — the TB1 cold-only sidebar
 * and `ConnectedWorkspace`'s internal switcher — into ONE unified list per
 * Workspace. The Workspace switcher pins at top; the SELECTED Workspace expands to
 * its unified rows (cold + live merged, deduped, most-recent-first), each row
 * showing a live/history badge, a streaming indicator, a needs-attention badge, and
 * an inline (safe) delete. A New-thread control mints a draft on the live agent.
 * Selection is the nav reducer's alone, so the sidebar and outlet can never
 * disagree. A background Workspace blocked on a permission prompt surfaces a
 * needs-attention badge on its switcher row (the deferred TB2 finding).
 */
export function Shell({
  workspaces,
  sidebarTop,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  activeThreadId,
  canCreateThread,
  creatingThread,
  outlet,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  /** Persisted Workspaces (cold metadata) for the switcher rows + display names. */
  workspaces: ListMetadataResult
  /** App-owned controls pinned above the list (Open project + environment status). */
  sidebarTop: ReactNode
  /** The current navigation selection (controlled by App). */
  nav: NavState
  /** Per-Workspace rolled-up live status, keyed by Workspace id (switcher badges). */
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  /** The unified rows (cold + live) for the SELECTED Workspace. */
  rows: UnifiedThreadRow[]
  /** The connection's primary Thread (never deletable mid-connection), or null. */
  protectedThreadId: string | null
  /** The selected Workspace's active (mounted) Thread — a live row is deletable only
   *  when it IS this one (we can't observe a non-active sibling's turn; #53). */
  activeThreadId: string | null
  /** Whether New-thread is available (the selected Workspace is connected). */
  canCreateThread: boolean
  /** A draft mint is in flight — disable New-thread to avoid a double mint. */
  creatingThread: boolean
  /** The fully-computed conversation outlet (connection views / cold replay). */
  outlet: ReactNode
  /** Select a Workspace — App pins it in nav and connect-or-reuses its warm agent. */
  onSelectWorkspace: (workspaceId: string) => void
  /** Select a Thread — App pins it in nav and (if live) remembers it as active. */
  onSelectThread: (workspaceId: string, threadId: string) => void
  /** Mint a New-thread draft on the selected Workspace's live agent. */
  onNewThread: () => void
  /** Delete a Thread (TB6) — main tears down any live session, then the list refreshes. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  return (
    <div className="shell">
      <aside className="shell__sidebar">
        {sidebarTop}
        <WorkspaceNav
          workspaces={workspaces}
          nav={nav}
          workspaceFlags={workspaceFlags}
          rows={rows}
          protectedThreadId={protectedThreadId}
          activeThreadId={activeThreadId}
          canCreateThread={canCreateThread}
          creatingThread={creatingThread}
          onSelectWorkspace={onSelectWorkspace}
          onSelectThread={onSelectThread}
          onNewThread={onNewThread}
          onDeleteThread={onDeleteThread}
        />
      </aside>

      <main className="shell__outlet">{outlet}</main>
    </div>
  )
}

/**
 * The sidebar's navigation list: the Workspace switcher, with the SELECTED
 * Workspace expanded to its unified Thread list (TB3 #48). A non-selected
 * Workspace shows only its name + a rolled-up live status (a streaming dot / a
 * needs-attention badge), so a background Workspace blocked on a permission prompt
 * is visible without expanding it.
 */
function WorkspaceNav({
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  activeThreadId,
  canCreateThread,
  creatingThread,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  rows: UnifiedThreadRow[]
  protectedThreadId: string | null
  activeThreadId: string | null
  canCreateThread: boolean
  creatingThread: boolean
  onSelectWorkspace: (workspaceId: string) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread: () => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  if (workspaces.length === 0) {
    return <p className="hint">No workspaces yet. Open a project to begin.</p>
  }
  return (
    <nav className="recents">
      <div className="recents__title">Workspaces</div>
      <ul className="recents__list">
        {workspaces.map((w) => {
          const isSelected = w.id === nav.selectedWorkspaceId
          const flags = workspaceFlags[w.id]
          return (
            <li key={w.id} className="recents__workspace">
              <button
                className={
                  isSelected ? 'recents__ws-name recents__ws-name--active' : 'recents__ws-name'
                }
                title={w.dir}
                onClick={() => onSelectWorkspace(w.id)}
              >
                {w.displayName}
                {flags?.streaming && <span className="dot dot--pending ws-streaming" aria-label="streaming" />}
                {flags?.needsAttention && (
                  <span className="badge badge--attention" title="A thread needs your attention">
                    needs you
                  </span>
                )}
              </button>

              {isSelected &&
                (rows.length > 0 ? (
                  <ul className="recents__threads">
                    {rows.map((row) => (
                      <NavThread
                        key={row.thread.id}
                        row={row}
                        selected={row.thread.id === nav.selectedThreadId}
                        // Safe delete (TB6 / #48), decided by the pure gate: a cold row
                        // always; the primary never; a live row only when it's the
                        // active, idle row (a non-active live sibling's turn is
                        // unobservable, so it stays non-deletable — the TB1 hazard).
                        deletable={isThreadDeletable(row, activeThreadId, protectedThreadId)}
                        onOpen={() => onSelectThread(w.id, row.thread.id)}
                        onDelete={onDeleteThread}
                      />
                    ))}
                  </ul>
                ) : (
                  <div className="recents__empty">No threads yet</div>
                ))}

              {isSelected && canCreateThread && (
                <button className="btn btn--ghost recents__new" onClick={onNewThread} disabled={creatingThread}>
                  {creatingThread ? 'Creating…' : '+ New thread'}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * One unified Thread row: its label, a live (●) vs `history` badge, a streaming
 * indicator and a needs-attention badge driven by the status registry, and a
 * two-step inline delete (TB6) shown only when `deletable`. Clicking selects it →
 * the outlet routes live `Conversation` vs cold `ColdThread`.
 */
function NavThread({
  row,
  selected,
  deletable,
  onOpen,
  onDelete,
}: {
  row: UnifiedThreadRow
  selected: boolean
  deletable: boolean
  onOpen: () => void
  onDelete: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="recents__thread">
      <button
        className={selected ? 'recents__thread-btn recents__thread-btn--active' : 'recents__thread-btn'}
        onClick={onOpen}
      >
        <span className={row.live ? 'dot dot--ok' : 'dot dot--idle'} aria-hidden />
        <span className="recents__thread-label">{threadLabel(row)}</span>
        {row.streaming && <span className="recents__thread-streaming" title="Streaming">⟳</span>}
        {!row.live && <span className="badge badge--history">history</span>}
        {row.needsAttention && (
          <span className="badge badge--attention" title="Awaiting your response">
            !
          </span>
        )}
      </button>
      {!deletable ? null : confirming ? (
        <span className="recents__thread-confirm">
          <button
            className="btn btn--ghost btn--danger"
            onClick={() => {
              setConfirming(false)
              void onDelete(row.thread)
            }}
          >
            Delete
          </button>
          <button className="btn btn--ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="recents__thread-delete"
          aria-label="Delete thread"
          title="Delete thread"
          onClick={() => setConfirming(true)}
        >
          ✕
        </button>
      )}
    </li>
  )
}

/** A Thread's list label — its title, a draft placeholder, or a fallback. */
function threadLabel(row: UnifiedThreadRow): string {
  if (row.thread.title) return row.thread.title
  // A live, session-less Thread is a fresh draft awaiting its first prompt.
  if (row.live && row.thread.sessionId === null) return 'New thread (draft)'
  return 'Untitled thread'
}
