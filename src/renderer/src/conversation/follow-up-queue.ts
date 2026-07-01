/**
 * Follow-up queue (#105, ADR-0009): when the user submits a message WHILE a
 * Thread's turn is streaming, we can't send it (vibe-acp rejects a concurrent
 * `session/prompt` with -32602, acp-capture §12), so we QUEUE it renderer-side and
 * auto-flush one message per turn-end. The queue is per-Thread, multi-message, and
 * EPHEMERAL — renderer-only, never persisted (ADR-0009 keeps follow-ups transient
 * intent, unlike the durable transcript). It must SURVIVE the `Conversation`
 * remount (that view is keyed by `threadId`), so it lives in a MODULE-LEVEL store
 * above the component, addressed by `threadId`.
 *
 * Split like the app's other load-bearing renderer logic: PURE immutable ops over
 * a `Record<threadId, QueuedMessage[]>` (unit-tested here), plus a thin module
 * singleton wiring them to a `useSyncExternalStore` subscription. The subscription
 * demands a STABLE snapshot reference — `getThreadQueue` returns the same array
 * identity until THAT thread's queue changes (and a shared frozen empty otherwise),
 * so React never loops.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** A staged image carried on a queued message (mirrors the composer's PendingImage,
 *  minus the `name`/`id` the composer strip needs). `data` is bare base64 for send;
 *  `previewUrl` is the full data URL for the echoed user turn / any row thumbnail. */
export interface QueuedImage {
  data: string
  mimeType: string
  previewUrl: string
}

/** One queued follow-up: the composer's text + any staged images, plus a stable id
 *  so a row can be removed by identity (not index). */
export interface QueuedMessage {
  id: string
  text: string
  images: QueuedImage[]
}

/** The per-Thread queue map: threadId -> ordered pending messages (head = next). */
export type QueueMap = Record<string, QueuedMessage[]>

/** Shared frozen empty array so an absent thread's snapshot has a STABLE identity
 *  (a fresh `[]` per call would loop `useSyncExternalStore`). */
const EMPTY: readonly QueuedMessage[] = Object.freeze([])

// --- Pure immutable ops (never mutate inputs; prune empty per-thread arrays) ---

/** Append `msg` to a Thread's queue, returning a NEW map (inputs untouched). */
export function enqueue(map: QueueMap, threadId: string, msg: QueuedMessage): QueueMap {
  const current = map[threadId] ?? []
  return { ...map, [threadId]: [...current, msg] }
}

/**
 * Remove + return a Thread's HEAD. When the queue empties, the per-thread key is
 * PRUNED (no `[]` litter left behind for a switched-away Thread). Returns the same
 * map + `head: null` when the Thread has nothing queued.
 */
export function dequeueHead(
  map: QueueMap,
  threadId: string,
): { map: QueueMap; head: QueuedMessage | null } {
  const current = map[threadId]
  if (!current || current.length === 0) return { map, head: null }
  const [head, ...rest] = current
  const next: QueueMap = { ...map }
  if (rest.length === 0) delete next[threadId]
  else next[threadId] = rest
  return { map: next, head }
}

/** Drop the message with `id` from a Thread's queue, pruning the key if emptied. */
export function removeById(map: QueueMap, threadId: string, id: string): QueueMap {
  const current = map[threadId]
  if (!current) return map
  const rest = current.filter((m) => m.id !== id)
  if (rest.length === current.length) return map
  const next: QueueMap = { ...map }
  if (rest.length === 0) delete next[threadId]
  else next[threadId] = rest
  return next
}

/** The Thread's next message without removing it, or null when empty. */
export function peekHead(map: QueueMap, threadId: string): QueuedMessage | null {
  const current = map[threadId]
  return current && current.length > 0 ? current[0] : null
}

// --- The module singleton store (state + listeners) ---

let queues: QueueMap = {}
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Module-local incrementing id source (NOT Math.random/Date) — unique per queued
 *  message so a row's ✕ removes exactly it. */
let queueSeq = 0

/** Mint the next stable queue-message id. */
export function nextQueueId(): string {
  return `queued:${queueSeq++}`
}

/** Subscribe to any queue change; returns an unsubscribe. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A Thread's queue as a STABLE reference: the SAME array identity until that
 * thread's queue changes (the pure ops only replace the mutated thread's array),
 * and a shared frozen empty otherwise. Safe as a `useSyncExternalStore` snapshot.
 */
export function getThreadQueue(threadId: string): QueuedMessage[] {
  return queues[threadId] ?? (EMPTY as QueuedMessage[])
}

/** Append a message to a Thread's queue and notify. */
export function enqueueMessage(threadId: string, msg: QueuedMessage): void {
  queues = enqueue(queues, threadId, msg)
  notify()
}

/** Remove + return a Thread's head, notifying when something was dequeued. */
export function dequeueThreadHead(threadId: string): QueuedMessage | null {
  const { map, head } = dequeueHead(queues, threadId)
  if (head) {
    queues = map
    notify()
  }
  return head
}

/** Remove a queued message by id and notify (no-op + no notify when absent). */
export function removeQueued(threadId: string, id: string): void {
  const next = removeById(queues, threadId, id)
  if (next !== queues) {
    queues = next
    notify()
  }
}

// --- per-Thread in-flight latch (serialization ACROSS component instances) ---
//
// The queue + a Thread's turn lifecycle both outlive the `Conversation` remount, but
// a `useRef` latch is per-instance — so a remounted instance (or a dead instance's
// `finally`) could start a second `session/prompt` while the first is still open on the
// agent (→ -32602, and a lost follow-up). This module-level set is the SINGLE authority
// for "Thread X has a prompt in flight": set synchronously by whoever starts a turn,
// checked by every flush. It notifies so the mounted composer re-renders (button label)
// and its flush effect re-fires when a turn ends — including one driven by a now-unmounted
// instance, so the CURRENTLY-mounted instance drains the next message (correct echo).
const sending = new Set<string>()

/** Whether a `session/prompt` is currently in flight for `threadId` (live, synchronous). */
export function isSending(threadId: string): boolean {
  return sending.has(threadId)
}

/** Mark a Thread's turn as started (before the IPC) — notifies subscribers. */
export function beginSend(threadId: string): void {
  if (!sending.has(threadId)) {
    sending.add(threadId)
    notify()
  }
}

/** Mark a Thread's turn as ended (in the send's `finally`) — notifies subscribers. */
export function endSend(threadId: string): void {
  if (sending.delete(threadId)) notify()
}

/** Test-only reset so the module singleton doesn't leak state across tests. */
export function _resetQueueStore(): void {
  queues = {}
  listeners.clear()
  sending.clear()
  queueSeq = 0
}

/** The handle a Thread's composer holds. */
export interface FollowUpQueue {
  queued: QueuedMessage[]
  /** Reactive: a `session/prompt` is in flight for this Thread (across instances). */
  sending: boolean
  enqueue: (msg: QueuedMessage) => void
  dequeueHead: () => QueuedMessage | null
  remove: (id: string) => void
  beginSend: () => void
  endSend: () => void
}

/**
 * Bind the module store to one Thread for the composer: a live, stable-reference
 * `queued` snapshot via `useSyncExternalStore`, plus mutators pre-bound to
 * `threadId`. The snapshot's identity is stable across unrelated notifications
 * (getThreadQueue returns the same array until THIS thread changes), so the
 * subscription doesn't loop.
 */
export function useFollowUpQueue(threadId: string): FollowUpQueue {
  const queued = useSyncExternalStore(subscribe, () => getThreadQueue(threadId))
  // A separate primitive snapshot — booleans are inherently stable, so no loop.
  const sendingNow = useSyncExternalStore(subscribe, () => isSending(threadId))
  const enqueue = useCallback((msg: QueuedMessage) => enqueueMessage(threadId, msg), [threadId])
  const dequeueHeadBound = useCallback(() => dequeueThreadHead(threadId), [threadId])
  const remove = useCallback((id: string) => removeQueued(threadId, id), [threadId])
  const beginSendBound = useCallback(() => beginSend(threadId), [threadId])
  const endSendBound = useCallback(() => endSend(threadId), [threadId])
  return {
    queued,
    sending: sendingNow,
    enqueue,
    dequeueHead: dequeueHeadBound,
    remove,
    beginSend: beginSendBound,
    endSend: endSendBound,
  }
}
