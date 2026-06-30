/**
 * A live Thread's status for the unified sidebar list (TB3 #48, #53): `streaming`
 * while a turn is in flight, `needsAttention` while a `session/request_permission`
 * is unanswered. The authoritative source is MAIN's `thread:status` push (#53) —
 * main owns the turn + permission lifecycle, so it surfaces these flags for ALL
 * live Threads (active or not). This module is the renderer-side REGISTRY: the
 * fold that App keeps the pushed flags in, keyed by `threadId`.
 */
export interface ThreadStatus {
  /** A turn is in flight — drives the streaming indicator. */
  streaming: boolean
  /** A permission request is pending an answer — drives the attention badge. */
  needsAttention: boolean
}

export type ThreadStatusMap = Readonly<Record<string, ThreadStatus>>

/**
 * Fold a Thread's pushed status into the registry (pure). Returns the SAME map
 * reference when nothing changed, so a redundant push (#53) can't trigger a
 * render — the guard against a status->render loop.
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
