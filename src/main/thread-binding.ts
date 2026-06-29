import type { ThreadInfo } from '../shared/ipc'
import type { ThreadRecord } from './persistence/metadata-store'

/**
 * The minimal agent surface for binding: open a new ACP session (`session/new`).
 * One `vibe-acp` agent can host many sessions, so each call mints a distinct one —
 * letting several Threads coexist under a single Workspace agent (ADR-0005).
 */
export interface SessionOpener {
  openThread(): Promise<ThreadInfo>
}

/** The minimal store surface for binding: re-target a Thread by id (upsert). */
export interface ThreadBindStore {
  upsertThread(input: {
    id: string
    workspaceId: string
    sessionId: string
  }): Promise<ThreadRecord>
}

export interface BoundSession {
  /** The ACP session this Thread is now bound to. */
  sessionId: string
  /** True when THIS call minted the session (`session/new` ran), false when reused. */
  minted: boolean
  /** The title `session/new` returned, when binding (null on reuse). */
  title: string | null
}

/**
 * Ensure a Thread has a bound ACP session before prompting (ADR-0005, TB5 #34).
 *
 * A draft (`sessionId === null`) triggers exactly ONE `session/new` on the
 * Workspace's agent, binds the returned sessionId onto the SAME Thread id
 * (`upsertThread` by id, preserving `createdAt`), and reports it `minted`. An
 * already-bound Thread (the caller passes its sessionId) returns that session
 * untouched with NO `session/new` — so the first prompt mints the session and
 * every subsequent prompt reuses it.
 *
 * The caller is responsible for passing the bound sessionId back on later prompts
 * (it flows to the renderer in the prompt result); a stale `null` would re-mint.
 */
export async function ensureBoundSession(args: {
  agent: SessionOpener
  store: ThreadBindStore
  threadId: string
  workspaceId: string
  sessionId: string | null
}): Promise<BoundSession> {
  if (args.sessionId) {
    return { sessionId: args.sessionId, minted: false, title: null }
  }
  const thread = await args.agent.openThread()
  await args.store.upsertThread({
    id: args.threadId,
    workspaceId: args.workspaceId,
    sessionId: thread.sessionId,
  })
  return { sessionId: thread.sessionId, minted: true, title: thread.title }
}
