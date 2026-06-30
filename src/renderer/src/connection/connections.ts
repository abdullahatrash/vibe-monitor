import type { ThreadConfigAxis, ThreadConnection } from '../../../shared/ipc'
import type { ConnectState } from './routing'

/**
 * Per-Workspace connection registry (ADR-0006 decision 3, TB2 #47). The warm pool
 * keeps MANY agents alive at once, so the renderer tracks a `ConnectState` PER
 * Workspace (keyed by our minted `workspaceId`) instead of TB1's single `connect`.
 * Switching between two warm Workspaces is then instant — each keeps its own
 * connected view (and its background turn keeps streaming) while the user looks at
 * the other. A pure reducer + derivations (no React, no IPC), mirroring the nav
 * reducer (ADR-0001 / decision 2).
 */
export type ConnectionMap = Readonly<Record<string, ConnectState>>

export type ConnectionAction =
  | { type: 'set'; workspaceId: string; state: ConnectState }
  | { type: 'clear'; workspaceId: string }
  | { type: 'evict'; agentIds: ReadonlySet<string> }
  // Optimistically reflect an agent-control change (#66, ADR-0007): a change emits
  // no notification, so the renderer updates the displayed current value the instant
  // the user picks, then reverts (re-dispatching the prior value) on an IPC failure.
  | { type: 'set-config'; workspaceId: string; axis: ThreadConfigAxis; value: string }

export const initialConnections: ConnectionMap = {}

export function connectionsReducer(state: ConnectionMap, action: ConnectionAction): ConnectionMap {
  switch (action.type) {
    case 'set':
      return { ...state, [action.workspaceId]: action.state }
    case 'clear': {
      if (!(action.workspaceId in state)) return state
      const next = { ...state }
      delete next[action.workspaceId]
      return next
    }
    case 'evict': {
      // The pool evicted these agents (TB5 #50): drop the Workspaces holding them
      // so the next select re-warms lazily (a re-connect, history from the store).
      // Returns the SAME ref when no connection referenced an evicted agent, so a
      // sweep that evicted nothing the renderer tracks drives no re-render.
      const doomed = Object.keys(state).filter((id) => {
        const agentId = agentIdOf(state[id])
        return agentId !== null && action.agentIds.has(agentId)
      })
      if (doomed.length === 0) return state
      const next = { ...state }
      for (const id of doomed) delete next[id]
      return next
    }
    case 'set-config': {
      // Only a connected Workspace carries the live current values; a transient
      // (connecting / not-signed-in / error / absent) one has no controls to update,
      // so the action is inert (same ref). `applyConfig` also returns the SAME thread
      // ref when the axis has no options or the value is unchanged — so a redundant
      // pick (or a revert to the value already shown) drives no re-render.
      const current = state[action.workspaceId]
      if (!current || current.status !== 'connected') return state
      const nextThread = applyConfig(current.thread, action.axis, action.value)
      if (nextThread === current.thread) return state
      return { ...state, [action.workspaceId]: { status: 'connected', thread: nextThread } }
    }
  }
}

/**
 * Return a connection's CURRENT value for an agent-control axis (#66), or null when
 * the axis isn't advertised. App reads this BEFORE an optimistic `set-config` so it
 * can revert to the prior value if the IPC change fails (ADR-0007).
 */
export function currentConfigValue(thread: ThreadConnection, axis: ThreadConfigAxis): string | null {
  switch (axis) {
    case 'mode':
      return thread.modes?.currentModeId ?? null
    case 'model':
      return thread.models?.currentModelId ?? null
    case 'reasoningEffort':
      return thread.reasoningEffort?.current ?? null
  }
}

/**
 * Apply an agent-control change to a connection's current value (#66), returning a
 * NEW `ThreadConnection` with only the targeted nested current updated — or the SAME
 * ref when the axis isn't advertised (null) or the value is already current, so a
 * no-op pick can't churn the reducer.
 */
function applyConfig(thread: ThreadConnection, axis: ThreadConfigAxis, value: string): ThreadConnection {
  switch (axis) {
    case 'mode':
      if (!thread.modes || thread.modes.currentModeId === value) return thread
      return { ...thread, modes: { ...thread.modes, currentModeId: value } }
    case 'model':
      if (!thread.models || thread.models.currentModelId === value) return thread
      return { ...thread, models: { ...thread.models, currentModelId: value } }
    case 'reasoningEffort':
      if (!thread.reasoningEffort || thread.reasoningEffort.current === value) return thread
      return { ...thread, reasoningEffort: { ...thread.reasoningEffort, current: value } }
  }
}

/**
 * The pool agentId a ConnectState holds, when any (TB5 #50): a connected state
 * carries it on its `thread`, a not-signed-in state inline; the transient
 * idle/connecting/error states have no agent yet. Used to map a pool eviction
 * (by agentId) back to the Workspace connection to drop.
 */
export function agentIdOf(state: ConnectState): string | null {
  if (state.status === 'connected') return state.thread.agentId
  if (state.status === 'not-signed-in') return state.agentId
  return null
}

/**
 * The connection for the selected Workspace, or `idle` when none is selected or
 * that Workspace was never connected. The outlet routes off THIS (not a single
 * global `connect`), so a cold click on a never-connected Workspace correctly
 * yields `idle` even after another Workspace connected — the TB1 finding (2)
 * ("cold clicks dead once connected") can't recur.
 */
export function selectedConnection(
  connections: ConnectionMap,
  workspaceId: string | null,
): ConnectState {
  if (!workspaceId) return { status: 'idle' }
  return connections[workspaceId] ?? { status: 'idle' }
}

/**
 * The Workspaces with a live (connected) agent. Their connection views stay
 * MOUNTED (hidden when not selected) so a background turn keeps streaming and the
 * agent is never torn down on a switch — switching back is instant with no
 * re-handshake.
 */
export function connectedWorkspaceIds(connections: ConnectionMap): string[] {
  return Object.keys(connections).filter((id) => connections[id].status === 'connected')
}

/**
 * Whether selecting a Workspace should kick off a connect (lazy spawn) vs. REUSE
 * what's already there. A never-connected (`idle`/absent) Workspace connects; a
 * prior `error` re-tries; a `connecting` / `not-signed-in` / `connected` Workspace
 * is reused as-is — so reselecting a warm-but-unauthed Workspace shows its sign-in
 * panel on the SAME warm agent rather than respawning it.
 */
export function shouldConnect(state: ConnectState | undefined): boolean {
  if (!state) return true
  return state.status === 'idle' || state.status === 'error'
}
