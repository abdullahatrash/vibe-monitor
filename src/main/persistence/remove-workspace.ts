/**
 * Remove a Workspace end-to-end ("Remove project", Codex-style; ADR-0005). Vibe owns
 * agent context; WE own the visible history, so removing a Workspace tears down OUR
 * records — its metadata entry, every Thread metadata entry under it, and each of
 * those Threads' JSONL transcripts — and, when the Workspace has a LIVE warm agent,
 * stops that agent cleanly FIRST. It NEVER deletes files on disk: the project
 * directory is untouched; only our index + transcripts come down.
 *
 * Best-effort is the whole point (mirrors `deleteThread`): a stop failure, a cold
 * Workspace with no warm agent, or a store/transcript unlink failure must NEVER block
 * the removal or surface as a hard error. EVERY step is guarded so the orchestration
 * always RESOLVES: the agent stop is swallowed (belt-and-suspenders — the stop seam
 * is itself best-effort), the metadata removal is swallowed (its `persist()` rejects
 * on a full / read-only `userData`, and an unguarded reject would bubble out the
 * `workspace:remove` IPC to the renderer's `.catch`-less onClick), and EACH transcript
 * removal is attempted independently so one failing unlink can't skip the rest. This
 * mirrors `recordWorkspaceOpen`'s guard — a failing persist never rejects the UI flow.
 */

/** The store surface needed to drop a Workspace + its Threads (returns removed Thread ids). */
export interface RemoveWorkspaceStore {
  removeWorkspace(id: string): Promise<string[]>
}

/** The transcript surface needed to drop one Thread's JSONL (missing = no-op). */
export interface RemoveWorkspaceTranscript {
  delete(threadId: string): Promise<void>
}

export interface RemoveWorkspaceArgs {
  workspaceId: string
  store: RemoveWorkspaceStore
  transcript: RemoveWorkspaceTranscript
  /**
   * Best-effort clean stop of the Workspace's LIVE warm agent, when one is warm.
   * Omitted for a cold Workspace (nothing to stop). Any rejection is swallowed — a
   * Vibe-side teardown failure must not block the record removal below.
   */
  stopAgent?: () => void | Promise<void>
}

export async function removeWorkspace(args: RemoveWorkspaceArgs): Promise<void> {
  // 1. Best-effort stop FIRST, while the warm agent handle is still resolvable.
  //    Swallow any failure (or absence) — Vibe-side cleanup never gates ours.
  if (args.stopAgent) {
    try {
      await args.stopAgent()
    } catch {
      // A failed/unavailable stop is non-fatal — proceed to remove our records.
    }
  }
  // 2. Remove our metadata records (the Workspace + all its Threads), guarded so a
  //    persist failure (full / read-only userData) can't reject the orchestration.
  //    A throw is treated as "nothing removed" so the transcript loop below no-ops.
  let removedThreadIds: string[] = []
  try {
    removedThreadIds = await args.store.removeWorkspace(args.workspaceId)
  } catch {
    // A metadata persist failure is non-fatal — leave the transcript cleanup to no-op.
  }
  // 3. Drop each removed Thread's JSONL, EACH guarded independently so one failing
  //    unlink can't skip the others (the store already swallows ENOENT; this guards
  //    the injected/no-op seam and any unexpected reject too).
  for (const threadId of removedThreadIds) {
    try {
      await args.transcript.delete(threadId)
    } catch {
      // A transcript unlink failure is non-fatal — continue with the rest.
    }
  }
}
