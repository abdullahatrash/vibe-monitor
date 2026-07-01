import type { ThreadMeta } from '../../../shared/ipc'
import type { ThreadStatus, ThreadStatusMap } from '../conversation/thread-status'

/**
 * One row of the unified sidebar Thread list (ADR-0006, TB3 #48): a Workspace's
 * Threads — COLD (persisted, from metadata/JSONL) and LIVE (hosted on the warm
 * agent this session) — merged into ONE list, each row carrying the flags the
 * sidebar renders. There is no second list: this replaces both the cold-only
 * sidebar (TB1) and `ConnectedWorkspace`'s internal switcher (TB2).
 */
export interface UnifiedThreadRow {
  thread: ThreadMeta
  /** Hosted on the current agent this session (live conversation, not replay). */
  live: boolean
  /** A turn is in flight on this Thread (from the status registry). */
  streaming: boolean
  /** A permission request is pending an answer (from the status registry). */
  needsAttention: boolean
}

/**
 * Merge a Workspace's cold + live Threads into the unified, deduped,
 * most-recent-first row list (pure — the load-bearing core of TB3).
 *
 * `cold` is the persisted list (already most-recent-first, ADR-0005); `live`
 * carries the metas for Threads hosted this session, INCLUDING any not yet in the
 * cold list (a freshly-minted draft, or the agent's auto-opened Thread before the
 * metadata refresh lands). A live Thread already present in cold is kept ONCE
 * (deduped by id) using the persisted meta (its title/timestamps are fresher);
 * live-only Threads are the newest, so they lead. Membership in `liveThreadIds`
 * — not the mere presence of a `sessionId` — decides the `live` flag, mirroring
 * `routeThreadSelection`. Each row's `streaming`/`needsAttention` come from the
 * status registry (absent => false), so a background Workspace's blocked turn
 * still surfaces a badge.
 */
export function deriveUnifiedThreads(args: {
  cold: ThreadMeta[]
  live: ThreadMeta[]
  liveThreadIds: ReadonlySet<string>
  statuses: ThreadStatusMap
}): UnifiedThreadRow[] {
  const { cold, live, liveThreadIds, statuses } = args
  const coldIds = new Set(cold.map((t) => t.id))
  // Live-only Threads (not yet persisted) lead — they were just created/opened.
  const liveOnly = live.filter((t) => !coldIds.has(t.id))
  const ordered = [...liveOnly, ...cold]

  const seen = new Set<string>()
  const rows: UnifiedThreadRow[] = []
  for (const thread of ordered) {
    if (seen.has(thread.id)) continue // dedup defensively (e.g. a dup within `live`)
    seen.add(thread.id)
    const status: ThreadStatus | undefined = statuses[thread.id]
    rows.push({
      thread,
      live: liveThreadIds.has(thread.id),
      streaming: status?.streaming ?? false,
      needsAttention: status?.needsAttention ?? false,
    })
  }
  return rows
}

/**
 * Stable reorder that floats a Workspace's PINNED rows (#132) to the top while
 * preserving each group's incoming order — so within the pinned group and within the
 * rest, the most-recent-first order the caller passed is untouched. Pure: returns a
 * NEW array (never mutates the input), applied as post-processing over
 * `deriveUnifiedThreads` (which stays flag-agnostic).
 */
export function orderByPin(rows: UnifiedThreadRow[]): UnifiedThreadRow[] {
  const pinned: UnifiedThreadRow[] = []
  const rest: UnifiedThreadRow[] = []
  for (const row of rows) {
    if (row.thread.pinned) pinned.push(row)
    else rest.push(row)
  }
  return [...pinned, ...rest]
}

/**
 * Split a Workspace's rows into `active` (shown in the main list) and `archived`
 * (#133 — folded into a collapsible "Archived" section), keyed off `thread.archived`.
 * Both halves preserve the incoming order; pure (no mutation of the input array).
 */
export function partitionArchived(rows: UnifiedThreadRow[]): {
  active: UnifiedThreadRow[]
  archived: UnifiedThreadRow[]
} {
  const active: UnifiedThreadRow[] = []
  const archived: UnifiedThreadRow[] = []
  for (const row of rows) {
    if (row.thread.archived) archived.push(row)
    else active.push(row)
  }
  return { active, archived }
}

/**
 * Whether a unified row may be deleted (pure — the safe-delete gate, TB6 / #48 /
 * #53). The hazard is tearing a session out from under a mid-turn agent. Now that
 * main pushes real per-Thread `streaming` for ALL live Threads (#53, not just the
 * active/mounted one), the gate keys off that real flag — it no longer has to
 * restrict deletion to the active row (the TB3 stopgap, when a non-active sibling's
 * turn was unobservable so it had to stay non-deletable):
 * - a cold row is always deletable (no live session to tear out from under);
 * - the connection's primary Thread is never deletable mid-connection;
 * - any other live row is deletable when it is NOT streaming (idle), active or not.
 *
 * `primaryThreadId` is null for a Workspace with no live connection (all rows are
 * cold then). The existing delete orchestration tears down a deleted live Thread's
 * session (`bestEffortCloseFor` + `wt remove`), so deleting an idle one is safe.
 */
export function isThreadDeletable(row: UnifiedThreadRow, primaryThreadId: string | null): boolean {
  if (!row.live) return true
  if (row.thread.id === primaryThreadId) return false
  return !row.streaming
}

/**
 * A Workspace-level roll-up of its live Threads' status (pure), for the Workspace
 * switcher row: `streaming` if ANY of its live Threads has a turn in flight,
 * `needsAttention` if ANY is blocked on a permission. This is what flags a
 * BACKGROUND (hidden) Workspace whose turn is wedged on an unanswerable prompt
 * (the deferred TB2 finding) right on its switcher row, so the user can switch to
 * it even though its Thread list isn't expanded.
 */
export function workspaceFlags(
  liveThreadIds: ReadonlySet<string>,
  statuses: ThreadStatusMap,
): { streaming: boolean; needsAttention: boolean } {
  let streaming = false
  let needsAttention = false
  for (const id of liveThreadIds) {
    const status = statuses[id]
    if (!status) continue
    if (status.streaming) streaming = true
    if (status.needsAttention) needsAttention = true
  }
  return { streaming, needsAttention }
}
