import type { Dispatch, SetStateAction } from 'react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavAction, NavState } from '../shell/nav-reducer'
import { clearThreadStatus, type ThreadStatusMap } from '../conversation/thread-status'
import { clearDraft } from '../conversation/composer-draft-store'
import { replayCache } from '../conversation/replay-cache'
import { removeWorkspacePanel } from '../side-panel/side-panel-store'
import { agentIdOf, type ConnectionAction, type ConnectionMap } from './connections'
import {
  workspaceThreadStateFor,
  type WorkspaceThreadsAction,
  type WorkspaceThreadsState,
} from './workspace-threads'

/**
 * The Workspace/Thread lifecycle mutations (delete / remove-project / flags / rename),
 * extracted from App: each one reconciles SEVERAL stores in a specific order, and
 * behind this seam the choreography is drivable with fake dispatchers instead of being
 * closed over App's hooks. Every mutation calls main first and reconciles local state
 * only on an ok result, so the UI never drops something main still holds.
 */
export interface WorkspaceActionsDeps {
  recents: ListMetadataResult
  nav: NavState
  connections: ConnectionMap
  workspaceThreads: WorkspaceThreadsState
  navDispatch: Dispatch<NavAction>
  connDispatch: Dispatch<ConnectionAction>
  wtDispatch: Dispatch<WorkspaceThreadsAction>
  setStatuses: Dispatch<SetStateAction<ThreadStatusMap>>
  refreshRecents: () => Promise<void>
  selectThreadInWorkspace: (workspaceId: string, threadId: string) => void
  storage: Storage
}

export interface WorkspaceActions {
  deleteThread(thread: ThreadMeta): Promise<void>
  removeWorkspace(workspaceId: string): Promise<void>
  setThreadFlags(threadId: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void>
  renameThread(thread: ThreadMeta, title: string): Promise<void>
}

export function useWorkspaceActions(deps: WorkspaceActionsDeps): WorkspaceActions {
  return {
    /**
     * Delete a Thread from the unified list (TB6 + #48 safe-delete). Main removes its
     * metadata + JSONL and best-effort closes any live session. The sidebar only
     * offers delete for a row `isThreadDeletable` proves safe (a cold row, or any
     * idle non-primary live row — its real per-Thread streaming is now observable for
     * ALL live Threads via main's push, #53), so we never tear a Thread out mid-stream.
     *
     * Reselection is gated on SELECTION, not liveness: `active`/`nav.selectedThreadId`
     * can legitimately point at a COLD (history) row, and dropping it from `recents`
     * would leave the outlet/sidebar pinned to a now-gone Thread. So whenever the
     * deleted Thread is the active/selected one of a CONNECTED Workspace, reselect the
     * connection's (always-live) primary Thread. The `wt remove` (drop from live-state)
     * runs ONLY when it was live; its stale status entry is cleared either way.
     *
     * Main re-validates streaming authoritatively and can REFUSE a delete that raced a
     * just-started turn (`{ok:false, reason:'streaming'}`, #53); we bail and leave the
     * row in place so the UI never drops a Thread main still hosts mid-stream.
     */
    async deleteThread(thread) {
      const result = await window.api.deleteThread(thread.id)
      if (!result.ok) return
      const wts = workspaceThreadStateFor(deps.workspaceThreads, thread.workspaceId)
      if (wts?.live.has(thread.id)) {
        deps.wtDispatch({ type: 'remove', workspaceId: thread.workspaceId, threadId: thread.id })
      }
      const conn = deps.connections[thread.workspaceId]
      const wasSelected = wts?.active === thread.id || deps.nav.selectedThreadId === thread.id
      if (conn?.status === 'connected' && wasSelected) {
        deps.selectThreadInWorkspace(thread.workspaceId, conn.thread.threadId)
      }
      deps.setStatuses((prev) => clearThreadStatus(prev, thread.id))
      // Drop the deleted Thread's persisted composer draft (#60) — no orphaned text.
      clearDraft(deps.storage, thread.id)
      // And its cached replay view — a re-created Thread id must never see it.
      replayCache.invalidate(thread.id)
      await deps.refreshRecents()
    },

    /**
     * Remove a Workspace from the sidebar ("Remove project", Codex-style). Main stops
     * its warm agent (if any — allowed even mid-turn) and removes OUR records (the
     * Workspace + Thread metadata + JSONL); it NEVER deletes files on disk. Here we
     * reconcile local state so the project disappears cleanly:
     *  - If it was the selected Workspace, clear the nav selection (lands on the empty
     *    state); leave the selection untouched when removing a non-selected project.
     *  - Drop its connection and per-Workspace live-state. Both are idempotent: for a
     *    CONNECTED project main disposed the agent and pushed `agent:evicted`, whose
     *    handler already dropped the connection by agentId — so `clear` is a no-op then
     *    (no double-removal), and it covers the cold/unconnected case that evict misses.
     *  - Drop each removed Thread's persisted composer draft + renderer status, mirroring
     *    `deleteThread` — so a removed project leaves no orphaned localStorage/status keys.
     *  - `refreshRecents()` LAST, dropping it from the persisted list the sidebar renders.
     */
    async removeWorkspace(workspaceId) {
      await window.api.removeWorkspace(workspaceId)
      // Snapshot the removed Workspace's Thread ids from the CURRENT list, before the
      // refresh drops it, so we can clear their renderer-local residue below.
      const removedThreadIds =
        deps.recents.find((w) => w.id === workspaceId)?.threads.map((t) => t.id) ?? []
      if (deps.nav.selectedWorkspaceId === workspaceId) deps.navDispatch({ type: 'clear' })
      deps.connDispatch({ type: 'clear', workspaceId })
      deps.wtDispatch({ type: 'remove-workspace', workspaceId })
      if (removedThreadIds.length > 0) {
        deps.setStatuses((prev) => removedThreadIds.reduce((acc, id) => clearThreadStatus(acc, id), prev))
        for (const id of removedThreadIds) clearDraft(deps.storage, id)
      }
      // Drop the side-panel entry too (#193): workspaceIds are fresh UUIDs, so a removed
      // Workspace's open-tabs blob would otherwise sit unreachable in localStorage forever.
      removeWorkspacePanel(workspaceId)
      // And every removed Thread's cached replay view.
      replayCache.invalidateByWorkspace(workspaceId)
      await deps.refreshRecents()
    },

    /**
     * Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive). A SAFE
     * metadata op — no session teardown — so it runs on any row (active or cold-peek).
     * Best-effort in main (ADR-0005); we refresh the recents list so the new flag
     * reflects in the sidebar's derivation (`orderByPin` / `partitionArchived`). A
     * `{ok:false}` (store failure) leaves the list as-is — the toggle is a no-op.
     */
    async setThreadFlags(threadId, flags) {
      const result = await window.api.setThreadFlags({ threadId, ...flags })
      if (!result.ok) return
      await deps.refreshRecents()
    },

    /**
     * Rename a Thread. Main owns the title in OUR store, and additionally syncs the
     * vibe-acp side when the Thread is live — so we pass the hosting `agentId` (when its
     * Workspace is connected) and the Thread's bound `sessionId`; main no-ops the ACP
     * call for a cold Thread. Refresh the cold list on success so the sidebar re-labels
     * (the setter holds list position, so the Thread doesn't jump). A `{ok:false}`
     * (empty title / store failure) leaves the label unchanged.
     */
    async renameThread(thread, title) {
      const conn = deps.connections[thread.workspaceId]
      const agentId = conn ? agentIdOf(conn) : null
      const result = await window.api.setThreadTitle({
        threadId: thread.id,
        title,
        agentId: agentId ?? undefined,
        sessionId: thread.sessionId,
      })
      if (!result.ok) return
      // A cached replay view carries the OLD title in `state.title`, which would
      // beat the fresh metadata title on the next mount — drop it. (The
      // `thread:title` wire also covers pushes main initiates; this covers the
      // rename WE initiated without depending on an echo.)
      replayCache.invalidate(thread.id)
      await deps.refreshRecents()
    },
  }
}
