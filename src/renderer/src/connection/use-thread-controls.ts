import { useRef, type Dispatch } from 'react'
import type { ThreadAgentControls, ThreadConfigAxis } from '../../../shared/ipc'
import {
  boundConfigValue,
  currentConfigValue,
  reassertions,
  selectedFor,
  type WorkspaceThreadsAction,
  type WorkspaceThreadsState,
} from './workspace-threads'

/**
 * The per-Thread agent-controls choreography (#66/#70/#72/#75, ADR-0007) — the
 * optimistic-apply / revert-on-failure / cache-confirmed-pick idiom, extracted from
 * App so the shared revert loop exists once and the stale-closure mirror ref lives
 * HERE instead of leaking into App.
 */
export interface ThreadControls {
  /**
   * Change an agent control for ONE Thread (#66/#70): reflect the pick OPTIMISTICALLY
   * on THAT Thread's per-Thread config (a change emits no notification, so the `{}`
   * result is the only signal), fire the IPC, and on an `{ok:false}` REVERT to the
   * value shown before — leaving the control displaying the agent's real state — and
   * surface the error. On success cache the CONFIRMED pick (#72) so a later resume
   * re-asserts it. A sibling Thread's controls are never touched.
   */
  changeThreadConfig(
    workspaceId: string,
    agentId: string,
    threadId: string,
    axis: ThreadConfigAxis,
    value: string,
    sessionId: string,
  ): void
  /**
   * Re-assert a Thread's cached selection after a resume (#72). Vibe resets Mode to
   * `default` on `session/load`, so a Thread whose session was lost (idle-evicted +
   * re-warmed per TB5, or a cold continue) and resumed reports its DEFAULT controls on
   * `thread:bound`. For each axis whose cached `selected` differs from the resumed
   * value, optimistically reflect it AND fire the IPC to put the live session back to
   * the user's choice — reverting (to the resumed value) + logging on failure. Reads
   * the cache from the ref so an async resume sees the latest, not its stale
   * render-time closure. No-ops for a fresh mint (no cache) and when the resumed value
   * already matches.
   */
  reassertAfterResume(
    workspaceId: string,
    agentId: string,
    threadId: string,
    sessionId: string,
    controls: ThreadAgentControls,
  ): void
  /**
   * Pre-select an agent control on a New-thread DRAFT (#75), before its first prompt
   * binds a session. A draft has no live session, so there's NO IPC — we only cache
   * the pick into the in-memory `selected` map (keyed by `threadId`). Because this
   * writes the SAME cache `changeThreadConfig` writes on a bound Thread, the EXISTING
   * `reassertAfterResume` applies the pre-pick to the session the instant the first
   * prompt mints it — no second apply path, and no residue (the cache evaporates with
   * the draft / on restart, ADR-0007).
   */
  preselectDraftConfig(workspaceId: string, threadId: string, axis: ThreadConfigAxis, value: string): void
}

export function useThreadControls(
  workspaceThreads: WorkspaceThreadsState,
  wtDispatch: Dispatch<WorkspaceThreadsAction>,
): ThreadControls {
  // Latest workspace-threads, mirrored into a ref so the async `reassertAfterResume`
  // (#72) reads the CURRENT selection cache — its render-time closure is stale by the
  // time a resume's `thread:bound` fires.
  const workspaceThreadsRef = useRef(workspaceThreads)
  workspaceThreadsRef.current = workspaceThreads

  /**
   * The shared optimistic-apply/revert step: reflect `value` on the displayed config,
   * fire the IPC, and on failure log + revert to `prev` (when one exists). `onOk` runs
   * only on a confirmed apply.
   */
  function applyConfig(
    label: string,
    workspaceId: string,
    agentId: string,
    threadId: string,
    sessionId: string,
    axis: ThreadConfigAxis,
    value: string,
    prev: string | null,
    onOk?: () => void,
  ): void {
    wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value })
    void window.api.setThreadConfig({ agentId, sessionId, axis, value }).then((res) => {
      if (res.ok) {
        onOk?.()
        return
      }
      console.error(`Failed to ${label} ${axis} to "${value}": ${res.error}`)
      if (prev !== null) wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value: prev })
    })
  }

  return {
    changeThreadConfig(workspaceId, agentId, threadId, axis, value, sessionId) {
      // Reads the prior value up front so the revert is exact.
      const prev = currentConfigValue(workspaceThreads, workspaceId, threadId, axis)
      if (prev === value) return // already current — no optimistic churn, no IPC round-trip
      applyConfig('set', workspaceId, agentId, threadId, sessionId, axis, value, prev, () => {
        // Remember the CONFIRMED pick (#72) so a later resume (re-warm / cold continue)
        // re-asserts it — Vibe resets Mode to `default` on `session/load`. Cached only
        // here, never on the optimistic update or the revert.
        wtDispatch({ type: 'cache-selection', workspaceId, threadId, axis, value })
      })
    },

    reassertAfterResume(workspaceId, agentId, threadId, sessionId, controls) {
      const selected = selectedFor(workspaceThreadsRef.current, workspaceId, threadId)
      for (const { axis, value } of reassertions(selected, controls)) {
        const prev = boundConfigValue(controls, axis) // the resumed value to revert to
        applyConfig('re-assert', workspaceId, agentId, threadId, sessionId, axis, value, prev)
      }
    },

    preselectDraftConfig(workspaceId, threadId, axis, value) {
      wtDispatch({ type: 'cache-selection', workspaceId, threadId, axis, value })
    },
  }
}
