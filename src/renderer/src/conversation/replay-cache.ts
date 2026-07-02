import type { ConversationState } from './reducer'
import { sessionIdOfEvent } from './event-routing'

/**
 * A renderer-side cache of folded conversation views, so switching Threads
 * doesn't re-read + re-fold the whole JSONL on every remount (the transcript
 * grows with the conversation; the fold is O(entries) and Conversation/ColdThread
 * are remount-keyed by Thread id).
 *
 * TAKE-ON-MOUNT / PUT-ON-UNMOUNT: the mounting view CONSUMES its entry
 * (`take` = get + delete), so the live fold owns the state while on screen and
 * no invalidation can race the mounted Thread. On unmount the settled state is
 * `put` back. `put` REFUSES a mid-turn (`isProcessing`) snapshot: a turn spans
 * the unmount (the in-flight `sendPrompt` keeps teeing to the transcript in the
 * background), so that snapshot is stale by construction — the next mount does
 * the full replay instead. Turns only START from a mounted Conversation today
 * (submit + follow-up drain are per-mounted-instance), so every cached entry is
 * a turn-quiet view; if a future slice adds background turn-starting, the
 * `acp:event` invalidation below still dirties the entry within one event of the
 * turn's first stream.
 *
 * INVALIDATION rides existing channels only (no new main-process bookkeeping):
 *  - `acp:event`: any payload session-tagged to a cached entry's `sessionId`
 *    means main teed something to that Thread's transcript behind our back
 *    (e.g. the lazy `session_info_update` title echo) — drop the entry.
 *    Session-less lifecycle payloads (exit/error) fold into state only while
 *    `isProcessing` — never true for a cached entry — and their teed replay is
 *    equally a no-op, so ignoring them keeps cache ≡ replay.
 *  - `thread:title`: covers the COLD store-only rename (no ACP echo), where a
 *    stale cached `state.title` would beat the fresh `ThreadMeta.title`.
 *  - Thread delete / Workspace remove: the caller invalidates explicitly
 *    (`use-workspace-actions`). Agent EVICTION is deliberately NOT a signal —
 *    it changes no transcript (re-warm transparency, ADR-0006).
 *
 * Data URLs from replayed image attachments are cached as-is: they're GC'd with
 * the entry (object URLs would need a revoke lifecycle threaded through
 * reducer-owned state), and the per-image persistence cap bounds the worst case
 * across `MAX_CACHED_THREADS` entries.
 */

/** LRU capacity — ConversationState holds full item arrays, so keep this small. */
export const MAX_CACHED_THREADS = 8

/** A settled (never mid-turn) folded view, cached across the per-Thread remount. */
export interface CachedThreadView {
  state: ConversationState
  /**
   * The ACP session the view was folded up to — the `acp:event` invalidation
   * key (`null` for an unbound draft / a cold Thread with no session).
   */
  sessionId: string | null
  /** Owning Workspace — the remove-Workspace invalidation key. */
  workspaceId: string
}

export interface ReplayCache {
  /** Consume the Thread's cached view (get + delete) — the mount takes ownership. */
  take(threadId: string): CachedThreadView | null
  /** Cache a settled view; refuses `isProcessing` states; LRU-evicts past the cap. */
  put(threadId: string, view: CachedThreadView): void
  invalidate(threadId: string): void
  invalidateBySession(sessionId: string): void
  invalidateByWorkspace(workspaceId: string): void
  clear(): void
}

/** Pure Map-based LRU factory — the app uses the {@link replayCache} singleton. */
export function createReplayCache(max: number = MAX_CACHED_THREADS): ReplayCache {
  // Map iteration order is insertion order; re-putting deletes first, so the
  // FIRST key is always the least-recently-put — the LRU eviction victim.
  const entries = new Map<string, CachedThreadView>()
  return {
    take(threadId) {
      const view = entries.get(threadId) ?? null
      entries.delete(threadId)
      return view
    },
    put(threadId, view) {
      if (view.state.isProcessing) return // mid-turn snapshot — stale by construction
      entries.delete(threadId)
      entries.set(threadId, view)
      if (entries.size > max) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    invalidate(threadId) {
      entries.delete(threadId)
    },
    invalidateBySession(sessionId) {
      for (const [threadId, view] of entries) {
        if (view.sessionId === sessionId) entries.delete(threadId)
      }
    },
    invalidateByWorkspace(workspaceId) {
      for (const [threadId, view] of entries) {
        if (view.workspaceId === workspaceId) entries.delete(threadId)
      }
    },
    clear() {
      entries.clear()
    },
  }
}

/** The app singleton (module state resets with the window — single-window app). */
export const replayCache = createReplayCache()

/**
 * The structural slice of the preload api the invalidation wiring needs — keeps
 * this module preload-import-free and lets tests drive it with stub listeners.
 */
export interface ReplayCacheSignals {
  onAcpEvent(listener: (e: { agentId: string; payload: unknown }) => void): () => void
  onThreadTitle(listener: (e: { threadId: string; title: string }) => void): () => void
}

/**
 * Subscribe ONCE (App mount) to the signals that dirty cached entries behind an
 * unmounted Thread's back. A non-matching event is one cheap Map scan; the
 * mounted Thread's own stream can't evict anything because its entry was taken.
 * Returns a disposer that unsubscribes both.
 */
export function wireReplayCacheInvalidation(cache: ReplayCache, api: ReplayCacheSignals): () => void {
  const offEvent = api.onAcpEvent((e) => {
    const sessionId = sessionIdOfEvent(e.payload)
    if (sessionId) cache.invalidateBySession(sessionId)
  })
  const offTitle = api.onThreadTitle((e) => {
    cache.invalidate(e.threadId)
  })
  return () => {
    offEvent()
    offTitle()
  }
}
