import { useReducer, useState, type JSX, type ReactNode } from 'react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import { ColdThread } from '../conversation/ColdThread'
import { findSelectedThread, initialNavState, navReducer, type NavState } from './nav-reducer'

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Selection is
 * a pure nav reducer at this root (decision 2) — no router, no UI store.
 *
 * The sidebar lists the persisted Workspaces + Threads (cold metadata) and is the
 * always-there navigation surface. The outlet shows EITHER the connection-active
 * view App routes in (`connectionOutlet` — connecting / sign-in / error / the live
 * `ConnectedWorkspace`; TB4 #49 moves these inline), OR, on the idle path, the
 * nav-selected cold Thread replayed read-only (`ColdThread`). Both render INTO the
 * same outlet element while the sidebar element is fixed, so navigating never
 * unmounts the sidebar — that's the whole point of the shell.
 *
 * The warm-agent pool (decision 3) and a unified live/cold Thread list are TB2
 * (#47); here the sidebar is the cold list and live Threads surface only inside
 * the `connectionOutlet`.
 */
export function Shell({
  workspaces,
  sidebarTop,
  connectionOutlet,
  onContinueColdThread,
  onDeleteThread,
}: {
  /** Persisted Workspaces + Threads for the sidebar list (cold metadata). */
  workspaces: ListMetadataResult
  /** App-owned controls pinned above the list (Open project + environment status). */
  sidebarTop: ReactNode
  /** The connection-active outlet (non-idle connect states), or null on the idle path. */
  connectionOutlet: ReactNode | null
  /** Continue a selected cold Thread live (TB4 #33) — App drives the connect flow. */
  onContinueColdThread: (thread: ThreadMeta) => void
  /** Delete a Thread (TB6) — removes its metadata + JSONL, then refreshes the list. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const [nav, dispatch] = useReducer(navReducer, initialNavState)
  const selectedThread = findSelectedThread(workspaces, nav)

  return (
    <div className="shell">
      <aside className="shell__sidebar">
        {sidebarTop}
        <WorkspaceNav
          workspaces={workspaces}
          nav={nav}
          onSelectWorkspace={(workspaceId) => dispatch({ type: 'select-workspace', workspaceId })}
          onSelectThread={(workspaceId, threadId) =>
            dispatch({ type: 'select-thread', workspaceId, threadId })
          }
          onDeleteThread={onDeleteThread}
        />
      </aside>

      <main className="shell__outlet">
        {connectionOutlet ??
          (selectedThread ? (
            // Idle path: reopen the selected Thread read-only from its JSONL (TB3),
            // with a Continue affordance that hands back to App's connect flow (TB4).
            <ColdThread
              key={selectedThread.id}
              thread={selectedThread}
              onClose={() => dispatch({ type: 'clear' })}
              onContinue={() => onContinueColdThread(selectedThread)}
            />
          ) : (
            <div className="shell__empty">
              <p className="hint">
                Select a thread from the sidebar to view it, or open a project to start a live agent.
              </p>
            </div>
          ))}
      </main>
    </div>
  )
}

/**
 * The sidebar's navigation list: persisted Workspaces with their Threads, most-
 * recent-first, rendered from cold metadata alone — NO `vibe-acp` spawned. The
 * selected Workspace / Thread are highlighted; clicking a Thread selects it (the
 * outlet then reopens it read-only). Delete (TB6) is preserved per row.
 */
function WorkspaceNav({
  workspaces,
  nav,
  onSelectWorkspace,
  onSelectThread,
  onDeleteThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
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
        {workspaces.map((w) => (
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
                    selected={t.id === nav.selectedThreadId}
                    onOpen={() => onSelectThread(w.id, t.id)}
                    onDelete={onDeleteThread}
                  />
                ))}
              </ul>
            ) : (
              <div className="recents__empty">No threads yet</div>
            )}
          </li>
        ))}
      </ul>
    </nav>
  )
}

/**
 * One Thread row in the sidebar: selecting it on click (the outlet reopens it
 * read-only — TB3), highlighted when selected, with a delete control (TB6). Delete
 * is two-step — a first click arms an INLINE confirm (Delete / Cancel) rather than
 * a native `confirm()` (which would block the renderer), so a single misclick can't
 * nuke a Thread's history.
 */
function NavThread({
  thread,
  selected,
  onOpen,
  onDelete,
}: {
  thread: ThreadMeta
  selected: boolean
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
      {confirming ? (
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
