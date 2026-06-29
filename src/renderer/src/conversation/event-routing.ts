/**
 * Live event routing for multiple Threads hosted by ONE agent (ADR-0005, TB5).
 * A single `vibe-acp` agent hosts many ACP sessions, and main streams every
 * session's `session/update` (and `session/request_permission`) over the one
 * `acp:event` channel tagged only by `agentId`. So agentId alone can't tell two
 * Threads apart — these helpers route each payload by its OWN `params.sessionId`,
 * mirroring main's transcript tee. Pure (no React, no IPC) so it's unit-tested.
 */

/**
 * The ACP `sessionId` a payload is FOR (`session/update` and
 * `session/request_permission` both carry `params.sessionId`). Child lifecycle
 * payloads (`{type:'exit'|'error'|'stderr'}`) carry none -> `null`.
 */
export function sessionIdOfEvent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const params = (payload as { params?: unknown }).params
  if (!params || typeof params !== 'object') return null
  const sessionId = (params as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : null
}

/**
 * Whether an `acp:event` payload belongs to a Thread's live view, given the
 * session that Thread is bound to (`null` while a draft is still unbound).
 *
 * A session-tagged event routes ONLY to the Thread bound to that session. A
 * session-less lifecycle event (exit/error/stderr) is agent-wide and always
 * passes through. An UNBOUND draft (`boundSessionId === null`) REJECTS every
 * session-tagged event — siblings stay live on the shared agent, so adopting an
 * arbitrary event's session would splice a sibling's turn into the draft. Main
 * emits a `thread:bound` signal the instant `session/new` returns and BEFORE that
 * session streams any event (see `sendPrompt`), so a draft is bound before its
 * own first event arrives — rejecting-while-unbound drops nothing of its own.
 */
export function eventBelongsToThread(payload: unknown, boundSessionId: string | null): boolean {
  const sid = sessionIdOfEvent(payload)
  if (sid === null) return true
  if (boundSessionId === null) return false
  return sid === boundSessionId
}
