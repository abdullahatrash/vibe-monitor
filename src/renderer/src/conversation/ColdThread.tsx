import { useEffect, useState, type JSX } from 'react'
import type { ThreadMeta } from '../../../shared/ipc'
import { Item, UsageBar } from './Conversation'
import { initialConversationState, type ConversationState } from './reducer'
import { replayTranscript } from './replay'

/**
 * A reopened Thread rendered READ-ONLY from its persisted JSONL (ADR-0005, TB3
 * #32) — NO `vibe-acp` spawned. On mount we fetch the Thread's logged input
 * stream over IPC (`readTranscript`) and replay it through the SAME reducer the
 * live turn used (`replayTranscript`) to rebuild exactly what the user saw.
 *
 * The composer stays disabled: actually CONTINUING the conversation (spawn +
 * `session/load`) is a later slice (TB4, #33), so this view only displays the
 * history and points there.
 */
export function ColdThread({
  thread,
  onClose,
}: {
  thread: ThreadMeta
  onClose: () => void
}): JSX.Element {
  // null = still loading; a ConversationState once the transcript has replayed.
  const [state, setState] = useState<ConversationState | null>(null)

  // Fetch + replay once per Thread. Reads only — no agent is started here.
  useEffect(() => {
    let active = true
    void window.api.readTranscript(thread.id).then((entries) => {
      if (active) setState(replayTranscript(entries))
    })
    return () => {
      active = false
    }
  }, [thread.id])

  const view = state ?? initialConversationState
  const title = view.title ?? thread.title ?? 'Untitled thread'

  return (
    <div className="conv conv--cold">
      <div className="conv__head">
        <button className="btn btn--ghost" onClick={onClose}>
          ← Back
        </button>
        <span className="conv__title">{title}</span>
        <span className="badge">history</span>
      </div>

      <UsageBar state={view} />

      <div className="messages">
        {state === null ? (
          <p className="hint">Loading conversation…</p>
        ) : view.items.length === 0 ? (
          <p className="hint">This thread has no saved conversation yet.</p>
        ) : (
          view.items.map((item) => <Item key={item.id} item={item} onPermission={noPermission} />)
        )}
      </div>

      <p className="hint">
        Viewing saved history — replayed from disk with no agent running. Continuing this conversation
        is coming soon.
      </p>
    </div>
  )
}

/** Read-only view: permissions already replayed as resolved, so this never fires. */
const noPermission = (): void => {}
