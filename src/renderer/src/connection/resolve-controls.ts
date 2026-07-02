import type { ThreadAgentControls, ThreadConnection } from '../../../shared/ipc'
import { getWorkspaceControls, workspaceControlsKey } from './workspace-controls-store'
import { configFor, draftControls, selectedFor, type WorkspaceThreadsState } from './workspace-threads'

/**
 * The agent-controls shown for a connected Workspace's ACTIVE Thread — the one place
 * the picker's fallback chain (and its localStorage read) lives, extracted from App's
 * render JSX so it's a testable pure function.
 *
 * A bound Thread sources its OWN live config (#70); a draft (no config seeded) shows
 * the connection's option lists + defaults, overlaid with any cached pre-pick (#75).
 *
 * CAVEAT: a CONTINUED (reopened, not-yet-bound) Thread also has no config, so it shows
 * the connection DEFAULTS too — honest for Mode (session/load resets it to default)
 * but the MODEL can persist across a resume (acp-capture §10), so a reopened Thread
 * may briefly show the default model until its first prompt's bind reports the real
 * one and self-corrects. We don't eagerly resume to learn it (#33 defers load to the
 * first prompt); Model isn't trust-relevant (it doesn't gate writes), so the transient
 * pre-prompt mismatch is accepted.
 *
 * A never-bound draft's connection advertises all-null controls (ADR-0011 opens no
 * session until the first prompt), so before falling back to the connection we try the
 * per-Workspace cache (#153) — the last bound session's option lists — so the picker
 * shows immediately instead of after send.
 */
export function resolveActiveControls(
  workspaceThreads: WorkspaceThreadsState,
  conn: ThreadConnection,
  activeThreadId: string,
  storage: Storage,
): ThreadAgentControls {
  return (
    configFor(workspaceThreads, conn.workspaceId, activeThreadId) ??
    draftControls(
      getWorkspaceControls(storage, workspaceControlsKey(conn.workspaceId, conn.workspaceDir)) ?? {
        // The connection's advertised connect-time option lists + DEFAULT current
        // values, never optimistically mutated (a pick lands in `workspace-threads`
        // config, not here — #70).
        modes: conn.modes,
        models: conn.models,
        reasoningEffort: conn.reasoningEffort,
      },
      selectedFor(workspaceThreads, conn.workspaceId, activeThreadId),
    )
  )
}
