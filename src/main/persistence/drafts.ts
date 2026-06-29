import type { ThreadRecord } from './metadata-store'

/**
 * The minimal store surface a draft needs: mint a Thread (ADR-0005). Kept
 * structural so the helper is unit-testable over a temp-dir MetadataStore (or a
 * fake) without dragging in the whole store.
 */
export interface DraftThreadStore {
  upsertThread(input: { workspaceId: string; sessionId: null }): Promise<ThreadRecord>
}

/**
 * Create a NEW-Thread draft (ADR-0005, TB5 #34): mint a durable Thread id under a
 * Workspace with NO ACP session (`sessionId: null`) and NO agent work, so the
 * draft appears in the list immediately while `session/new` is deferred to its
 * first prompt (see `ensureBoundSession`). This writes ONLY the metadata record —
 * never a JSONL — so a draft that is never prompted leaves no transcript residue.
 */
export function createThreadDraft(store: DraftThreadStore, workspaceId: string): Promise<ThreadRecord> {
  return store.upsertThread({ workspaceId, sessionId: null })
}
