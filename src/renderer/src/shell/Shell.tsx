import { useState, type JSX, type ReactNode } from 'react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Navigation
 * (the pure nav reducer, decision 2) and the per-Workspace connection registry
 * (decision 3) live in App now; Shell is the presentational layout — it renders the
 * always-there sidebar (the Workspace switcher + each Workspace's Threads) and the
 * App-computed `outlet`. The sidebar element is fixed, so navigating never unmounts
 * it — the whole point of the shell.
 *
 * Two TB1-review findings are resolved by this split (TB2 #47): the outlet is
 * routed off the nav SELECTION (App), so a cold click on a never-connected
 * Workspace replays correctly even after another connected (finding 2); and a
 * connected Workspace's per-Thread highlight is SUPPRESSED here, since its live view
 * (in the outlet) owns Thread selection — the sidebar and outlet can't disagree
 * (finding 1). The unified live/cold Thread list is TB3 (#48).
 */
export function Shell({
  workspaces,
  sidebarTop,
  nav,
  connectedWorkspaceIds,
  outlet,
  onSelectWorkspace,
  onSelectThread,
  onDeleteThread,
}: {
  /** Persisted Workspaces + Threads for the sidebar list (cold metadata). */
  workspaces: ListMetadataResult
  /** App-owned controls pinned above the list (Open project + environment status). */
  sidebarTop: ReactNode
  /** The current navigation selection (controlled by App). */
  nav: NavState
  /** Workspace ids with a live agent — suppress their Thread highlight + delete. */
  connectedWorkspaceIds: string[]
  /** The fully-computed conversation outlet (connection views / cold replay). */
  outlet: ReactNode
  /** Select a Workspace — App pins it in nav and connect-or-reuses its warm agent. */
  onSelectWorkspace: (workspaceId: string) => void
  /** Select a Thread — App pins it in nav (the idle outlet then replays it). */
  onSelectThread: (workspaceId: string, threadId: string) => void
  /** Delete a Thread (TB6) — removes its metadata + JSONL, then refreshes the list. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const connected = new Set(connectedWorkspaceIds)

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        {sidebarTop}
        <WorkspaceNav
          workspaces={workspaces}
          nav={nav}
          connected={connected}
          onSelectWorkspace={onSelectWorkspace}
          onSelectThread={onSelectThread}
          onDeleteThread={onDeleteThread}
        />
      </aside>

      <main className="shell__outlet">{outlet}</main>
    </div>
  )
}

/**
 * The sidebar's navigation list: persisted Workspaces with their Threads, most-
 * recent-first, rendered from cold metadata alone — NO `vibe-acp` spawned. The
 * selected Workspace is highlighted; clicking one selects it (App connect-or-reuses
 * its warm agent). A Thread row highlights only when its Workspace is NOT connected
 * (a connected Workspace's live view owns Thread selection — finding 1). Delete
 * (TB6) is offered only for a non-connected Workspace's Threads, so we never remove
 * a Thread a warm agent is hosting.
 */
function WorkspaceNav({
  workspaces,
  nav,
  connected,
  onSelectWorkspace,
  onSelectThread,
  onDeleteThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  /** Workspace ids with a live agent (suppress Thread highlight + delete). */
  connected: ReadonlySet<string>
  onSelectWorkspace: (workspaceId: string) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
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
          const isConnected = connected.has(w.id)
          return (
            <li key={w.id} className="recents__workspace">
              <button
                className={
                  w.id === nav.selectedWorkspaceId
                    ? 'recents__ws-name recents__ws-name--active'
                    : 'recents__ws-name'
                }
                title={w.dir}
                onClick={() => onSelectWorkspace(w.id)}
              >
                {w.displayName}
              </button>
              {w.threads.length > 0 ? (
                <ul className="recents__threads">
                  {w.threads.map((t) => (
                    <NavThread
                      key={t.id}
                      thread={t}
                      // Suppress the per-Thread highlight for a connected Workspace —
                      // its live outlet owns Thread selection (finding 1).
                      selected={!isConnected && t.id === nav.selectedThreadId}
                      // No delete while the Workspace's agent is live (it may host it).
                      deletable={!isConnected}
                      onOpen={() => onSelectThread(w.id, t.id)}
                      onDelete={onDeleteThread}
                    />
                  ))}
                </ul>
              ) : (
                <div className="recents__empty">No threads yet</div>
              )}
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/**
 * One Thread row in the sidebar: selecting it on click (the outlet reopens it
 * read-only — TB3), highlighted when selected, with a delete control (TB6) shown
 * only when `deletable` (i.e. its Workspace has no live connection — see Shell).
 * Delete is two-step — a first click arms an INLINE confirm (Delete / Cancel)
 * rather than a native `confirm()` (which would block the renderer), so a single
 * misclick can't nuke a Thread's history.
 */
function NavThread({
  thread,
  selected,
  deletable,
  onOpen,
  onDelete,
}: {
  thread: ThreadMeta
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
        {threadLabel(thread)}
      </button>
      {!deletable ? null : confirming ? (
        <span className="recents__thread-confirm">
          <button
            className="btn btn--ghost btn--danger"
            onClick={() => {
              setConfirming(false)
              void onDelete(thread)
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

/** A Thread's list label — its title, or a placeholder until one arrives. */
function threadLabel(thread: ThreadMeta): string {
  return thread.title ?? 'Untitled thread'
}
