import type { ConversationItem } from './reducer'

/**
 * A live Thread's status, surfaced UP from its `Conversation` to the shell so the
 * unified sidebar list (TB3 #48) can show indicators WITHOUT owning the
 * conversation reducer: `streaming` while a turn is in flight, `needsAttention`
 * while a `session/request_permission` is unanswered. The `Conversation` reducer
 * stays the source of truth; we only report these two transitions out.
 */
export interface ThreadStatus {
  /** A turn is in flight (`isProcessing`) — drives the streaming indicator. */
  streaming: boolean
  /** A permission request is pending an answer — drives the attention badge. */
  needsAttention: boolean
}

export type ThreadStatusMap = Readonly<Record<string, ThreadStatus>>

/**
 * Derive a Thread's reportable status from its conversation state (pure). A turn
 * in flight is `streaming`; a still-pending permission row (`chosenOptionId ===
 * null`) is `needsAttention` — the latter is what flags a BACKGROUND Workspace
 * whose hidden turn is blocked on an unanswerable prompt (the deferred TB2
 * finding), so the user can spot it in the sidebar and switch to it.
 */
export function deriveThreadStatus(state: {
  isProcessing: boolean
  items: ConversationItem[]
}): ThreadStatus {
  const needsAttention = state.items.some(
    (item) => item.kind === 'permission' && item.chosenOptionId === null,
  )
  return { streaming: state.isProcessing, needsAttention }
}

/**
 * Fold a Thread's reported status into the registry (pure). Returns the SAME map
 * reference when nothing changed, so a Conversation re-reporting an unchanged
 * status can't trigger a render — the guard against a status->render->report loop
 * across several keep-mounted background Conversations.
 */
export function setThreadStatus(
  map: ThreadStatusMap,
  threadId: string,
  status: ThreadStatus,
): ThreadStatusMap {
  const prev = map[threadId]
  if (prev && prev.streaming === status.streaming && prev.needsAttention === status.needsAttention) {
    return map
  }
  return { ...map, [threadId]: status }
}

/**
 * Drop a Thread's entry from the registry (pure) — used on delete so a removed
 * Thread doesn't linger as a stale `{false, false}` for the rest of the session.
 * Returns the SAME map reference when the Thread isn't present (no re-render).
 */
export function clearThreadStatus(map: ThreadStatusMap, threadId: string): ThreadStatusMap {
  if (!(threadId in map)) return map
  const next = { ...map }
  delete next[threadId]
  return next
}
