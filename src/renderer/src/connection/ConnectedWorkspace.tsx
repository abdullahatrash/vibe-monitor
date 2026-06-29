import { useState, type JSX } from 'react'
import type { AuthMethod, ThreadConnection, ThreadMeta } from '../../../shared/ipc'
import { ColdThread } from '../conversation/ColdThread'
import { Conversation } from '../conversation/Conversation'
import { routeThreadSelection } from './thread-selection'

/**
 * A connected Workspace hosting MULTIPLE Threads on one `vibe-acp` agent (TB5
 * #34). Lists the Workspace's Threads, mints new drafts (`New Thread` — a durable
 * id with NO ACP session until its first prompt), and switches between them: a
 * Thread hosted live this session renders as a live `Conversation` (binding its
 * draft session on the first prompt); one bound in a prior launch replays
 * read-only from JSONL (`ColdThread`) until TB4 adds `session/load`.
 *
 * Thread metadata comes from the cold list (`recents`); the agent context
 * (agentId, our minted ids) comes from the initial `connection`. `liveThreadIds`
 * tracks which Threads are hosted on THIS agent — the auto-opened one plus drafts
 * created since connecting — and is the source of truth for live-vs-cold routing.
 */
export function ConnectedWorkspace({
  connection,
  threads,
  refreshRecents,
  onAuthExpired,
}: {
  connection: ThreadConnection
  /** The Workspace's persisted Threads (most-recent-first) from the cold list. */
  threads: ThreadMeta[]
  /** Re-fetch the metadata list (after minting a draft) so it appears immediately. */
  refreshRecents: () => Promise<void>
  /** Mid-session expiry (-32000): route to in-place re-auth with these methods. */
  onAuthExpired: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  const [liveThreadIds, setLiveThreadIds] = useState<ReadonlySet<string>>(
    () => new Set([connection.threadId]),
  )
  const [selectedThreadId, setSelectedThreadId] = useState(connection.threadId)
  // Sessions bound this session (TB5): a draft's first prompt mints one, lifted
  // here so switching away and back re-seeds it instead of re-minting.
  const [boundSessions, setBoundSessions] = useState<Record<string, string>>(() =>
    connection.sessionId ? { [connection.threadId]: connection.sessionId } : {},
  )
  const [busy, setBusy] = useState(false)

  // The agent always hosts at least its auto-opened Thread — ensure it's listed
  // even before the metadata list refresh that includes it has landed.
  const list = withConnectionThread(threads, connection)
  const selected = list.find((t) => t.id === selectedThreadId) ?? list[0]
  const view = routeThreadSelection(selected, liveThreadIds)

  async function newThread(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.api.createDraft({ workspaceId: connection.workspaceId })
      if (!result.ok) return
      // The draft is hosted on THIS agent (its session binds on first prompt).
      setLiveThreadIds((prev) => new Set(prev).add(result.thread.id))
      await refreshRecents()
      setSelectedThreadId(result.thread.id)
    } finally {
      setBusy(false)
    }
  }

  // The session to seed the selected Thread with: the one bound this session (if
  // any) wins over the persisted cursor, so a bound draft isn't re-minted on switch.
  const seedSessionId = boundSessions[selected.id] ?? selected.sessionId

  return (
    <div className="workspace">
      <div className="workspace__bar">
        <span className="workspace__name" title={connection.workspaceDir}>
          {connection.workspaceDir}
        </span>
        <button className="btn" onClick={() => void newThread()} disabled={busy}>
          New Thread
        </button>
      </div>

      <ul className="workspace__threads">
        {list.map((t) => (
          <li key={t.id}>
            <button
              className={
                t.id === selected.id ? 'workspace__thread workspace__thread--active' : 'workspace__thread'
              }
              onClick={() => setSelectedThreadId(t.id)}
            >
              <span className="workspace__thread-label">{threadLabel(t, liveThreadIds)}</span>
              {!liveThreadIds.has(t.id) && <span className="badge">history</span>}
            </button>
          </li>
        ))}
      </ul>

      {view === 'live' ? (
        <Conversation
          key={selected.id}
          thread={{
            agentId: connection.agentId,
            threadId: selected.id,
            workspaceId: connection.workspaceId,
            sessionId: seedSessionId,
            title: selected.title,
          }}
          onAuthExpired={onAuthExpired}
          onBound={(sessionId) =>
            setBoundSessions((prev) => ({ ...prev, [selected.id]: sessionId }))
          }
        />
      ) : (
        <ColdThread
          key={selected.id}
          thread={selected}
          onClose={() => setSelectedThreadId(connection.threadId)}
        />
      )}
    </div>
  )
}

/** Ensure the agent's auto-opened Thread is present (synthesized if the list lags). */
function withConnectionThread(threads: ThreadMeta[], connection: ThreadConnection): ThreadMeta[] {
  if (threads.some((t) => t.id === connection.threadId)) return threads
  const synthesized: ThreadMeta = {
    id: connection.threadId,
    workspaceId: connection.workspaceId,
    sessionId: connection.sessionId,
    title: connection.title,
    createdAt: 0,
    lastActiveAt: 0,
  }
  return [synthesized, ...threads]
}

/** A Thread's list label — its title, or a draft/placeholder until one arrives. */
function threadLabel(thread: ThreadMeta, liveThreadIds: ReadonlySet<string>): string {
  if (thread.title) return thread.title
  // A live, session-less Thread is a fresh draft awaiting its first prompt.
  if (liveThreadIds.has(thread.id) && thread.sessionId === null) return 'New thread (draft)'
  return 'Untitled thread'
}
