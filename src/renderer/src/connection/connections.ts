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
  }
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
