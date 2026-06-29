import type { ThreadMeta } from '../../../shared/ipc'

/** How a selected Thread is rendered: live on the agent, or cold from JSONL. */
export type ThreadView = 'live' | 'cold'

/**
 * Route a selected Thread to its view (ADR-0005, TB5 #34). Several Threads
 * coexist under one Workspace agent; `liveThreadIds` is the set hosted on the
 * CURRENT agent this session — the auto-opened Thread plus any drafts created
 * since connecting.
 *
 * A member routes `live` (it has, or on its first prompt will mint, a session on
 * the running agent — see `ensureBoundSession`). A non-member routes `cold`: it
 * was bound in a prior launch, so its ACP session lives on a now-dead process and
 * it replays read-only from JSONL until TB4 (#33) adds `session/load`. Membership
 * is the source of truth — a `sessionId` from a prior launch does NOT make it live.
 */
export function routeThreadSelection(
  thread: ThreadMeta,
  liveThreadIds: ReadonlySet<string>,
): ThreadView {
  return liveThreadIds.has(thread.id) ? 'live' : 'cold'
}
