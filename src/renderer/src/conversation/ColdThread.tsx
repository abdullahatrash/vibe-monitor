import { useEffect, useRef, useState, type JSX } from 'react'
import type { ThreadMeta } from '../../../shared/ipc'
import { Item } from './items/Item'
import { UsageBar } from './items/UsageBar'
import { initialConversationState, type ConversationState } from './reducer'
import { replayTranscript, transcriptHasImages } from './replay'
import { replayCache } from './replay-cache'

/**
 * A reopened Thread rendered READ-ONLY from its persisted JSONL (ADR-0005, TB3
 * #32) — NO `vibe-acp` spawned. On mount we fetch the Thread's logged input
 * stream over IPC (`readTranscript`) and replay it through the SAME reducer the
 * live turn used (`replayTranscript`) to rebuild exactly what the user saw.
 *
 * When `onContinue` is provided (TB4 #33), a "Continue" affordance spawns/uses the
 * Workspace agent and resumes this Thread via `session/load` (re-binding fresh if
 * the agent can't resume) — the first prompt then runs on the resumed session. The
 * caller owns that transition (it has the Workspace context); here we only invite it.
 */
export function ColdThread({
  thread,
  onClose,
  onContinue,
}: {
  thread: ThreadMeta
  onClose: () => void
  /** Continue this reopened Thread live (TB4 #33). Absent = view-only. */
  onContinue?: () => void
}): JSX.Element {
  // null = still loading; a ConversationState once the transcript has replayed.
  const [state, setState] = useState<ConversationState | null>(null)
  // Mirror for the unmount snapshot (a cleanup closes over the first render's
  // `state` otherwise). `null` (read never resolved) is never cached.
  const stateRef = useRef(state)
  stateRef.current = state

  // Fetch + replay once per Thread — cache first (take = consume), so a
  // switch-back within the LRU window skips the IPC + re-fold entirely.
  // Reads only — no agent is started here.
  useEffect(() => {
    const cached = replayCache.take(thread.id)
    if (cached) {
      // Sync the snapshot mirror NOW, not at the re-render: an unmount landing
      // before the render (StrictMode's dev double-mount) would otherwise see
      // `null` and drop the consumed entry instead of putting it back.
      stateRef.current = cached.state
      setState(cached.state)
      return
    }
    let active = true
    void window.api.readTranscript(thread.id).then(async (entries) => {
      // Resolve persisted image attachments (one batched IPC) ONLY when the
      // transcript references any — an image-less reopen costs nothing extra.
      const attachments = transcriptHasImages(entries)
        ? await window.api.readThreadAttachments(thread.id)
        : undefined
      if (active) setState(replayTranscript(entries, attachments))
    })
    return () => {
      active = false
    }
  }, [thread.id])

  // Unmount snapshot: a replayed cold view is settled by construction (no live
  // turn here — `isProcessing` is forced false by replay), so cache it for the
  // next open. A still-loading view (`null`) is never cached.
  useEffect(() => {
    return () => {
      if (stateRef.current !== null) {
        replayCache.put(thread.id, {
          state: stateRef.current,
          sessionId: thread.sessionId,
          workspaceId: thread.workspaceId,
        })
      }
    }
  }, [thread.id, thread.sessionId, thread.workspaceId])

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
        {onContinue && (
          <button className="btn" onClick={onContinue}>
            Continue
          </button>
        )}
      </div>

      <UsageBar state={view} />

      <div className="messages">
        {state === null ? (
          <p className="hint">Loading conversation…</p>
        ) : view.items.length === 0 ? (
          <p className="hint">This thread has no saved conversation yet.</p>
        ) : (
          view.items.map((item) => (
            // Read-only reopened history: no live turn, so reasoning renders collapsed.
            <Item key={item.id} item={item} streaming={false} onPermission={noPermission} />
          ))
        )}
      </div>

      <p className="hint">
        {onContinue
          ? 'Viewing saved history — replayed from disk. Continue to resume this conversation with the agent.'
          : 'Viewing saved history — replayed from disk with no agent running.'}
      </p>
    </div>
  )
}

/** Read-only view: permissions already replayed as resolved, so this never fires. */
const noPermission = (): void => {}
