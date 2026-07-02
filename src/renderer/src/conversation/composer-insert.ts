/**
 * A tiny module-level channel for the Files preview's "Insert @path into composer" action (#189,
 * ADR-0013 decision 2). The preview lives in the side panel — a SIBLING of the conversation, not
 * a parent — so it can't reach the composer through props/context. Instead it EMITS an insert for
 * a Thread id here; the mounted `Conversation` for that Thread SUBSCRIBES (keyed by its own
 * `threadId`) and appends the plain-text `@path` to its draft (which stays in lockstep with the
 * #60 composer-draft store). Renderer-only, no IPC: the wire format is untouched — the agent
 * expands the plain-text `@path` itself server-side (ADR-0002; we add no client-side expansion).
 *
 * If no composer is mounted for the target Thread (e.g. the active Thread is a cold replay), the
 * emit is a harmless no-op — there is no subscriber to receive it. Reveal-in-Finder does not go
 * through here and works regardless.
 */

/** A subscriber receiving the plain-text fragment to append to its Thread's composer draft. */
type InsertListener = (mention: string) => void

const listenersByThread = new Map<string, Set<InsertListener>>()

/**
 * Append a plain-text `@path` reference to `draft`, keeping it space-separated: a trailing space
 * is added after the mention (so the next token starts clean), and a separating space is inserted
 * before it unless the draft is empty or already ends in whitespace. Pure — the composer computes
 * the next value with this, then writes state + persisted draft together.
 */
export function appendMention(draft: string, relativePath: string): string {
  const mention = `@${relativePath}`
  if (draft.length === 0) return `${mention} `
  const separator = /\s$/.test(draft) ? '' : ' '
  return `${draft}${separator}${mention} `
}

/** Subscribe a Thread's composer to insert requests; returns an unsubscribe. */
export function subscribeComposerInsert(threadId: string, listener: InsertListener): () => void {
  let set = listenersByThread.get(threadId)
  if (!set) {
    set = new Set()
    listenersByThread.set(threadId, set)
  }
  set.add(listener)
  return () => {
    const current = listenersByThread.get(threadId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByThread.delete(threadId)
  }
}

/** Request the given Thread's composer append `@<relativePath>`; a no-op if none is mounted. */
export function emitComposerInsert(threadId: string, relativePath: string): void {
  const set = listenersByThread.get(threadId)
  if (!set) return
  for (const listener of set) listener(relativePath)
}
