/**
 * Per-Workspace, per-session Thread state (ADR-0006, TB3 #48) — lifted OUT of
 * `ConnectedWorkspace` so the sidebar (and the nav reducer) is the single source
 * of truth for selection and live-state, and `ConnectedWorkspace` becomes a
 * controlled outlet. The warm pool keeps several Workspaces live at once, so this
 * is keyed by `workspaceId`, mirroring the connection registry.
 *
 * Per Workspace we track exactly what `ConnectedWorkspace` used to own internally:
 * - `live`: which Threads are hosted on THIS session's agent (the auto-opened
 *   Thread + drafts/continued Threads) — the source of truth for live-vs-cold
 *   routing (mirrors `routeThreadSelection`), NOT a stale persisted `sessionId`.
 * - `bound`: sessions minted this session (threadId -> sessionId), so switching
 *   away from a just-bound draft and back re-seeds it instead of re-minting.
 * - `active`: the Thread this Workspace is currently showing. Lifted so a
 *   BACKGROUND (hidden) Workspace keeps its in-flight Thread mounted/streaming
 *   while the user looks elsewhere — the keep-mounted outlet renders `active`.
 *
 * A pure reducer + derivation (no React, no IPC), like the nav/connection reducers.
 */
export interface WorkspaceThreadState {
  live: ReadonlySet<string>
  bound: Readonly<Record<string, string>>
  active: string
}

export type WorkspaceThreadsState = Readonly<Record<string, WorkspaceThreadState>>

export type WorkspaceThreadsAction =
  // A Workspace (re)connected: reset its live-state to the agent's auto-opened
  // Thread. Fired once per connection — a reconnect (new agent) deliberately drops
  // the prior session's drafts (their sessions died with the old process).
  | { type: 'connect'; workspaceId: string; threadId: string; sessionId: string | null }
  // A draft was minted or a cold Thread continued: host it live and make it active.
  | { type: 'open'; workspaceId: string; threadId: string }
  // Switch which Thread the Workspace is showing (kept mounted when backgrounded).
  | { type: 'select'; workspaceId: string; threadId: string }
  // A draft's first prompt bound its session (`thread:bound`) — record it.
  | { type: 'bind'; workspaceId: string; threadId: string; sessionId: string }
  // A live Thread was deleted (TB6): drop it from the live set + its bound session.
  | { type: 'remove'; workspaceId: string; threadId: string }

export const initialWorkspaceThreads: WorkspaceThreadsState = {}

export function workspaceThreadsReducer(
  state: WorkspaceThreadsState,
  action: WorkspaceThreadsAction,
): WorkspaceThreadsState {
  switch (action.type) {
    case 'connect':
      return {
        ...state,
        [action.workspaceId]: {
          live: new Set([action.threadId]),
          bound: action.sessionId ? { [action.threadId]: action.sessionId } : {},
          active: action.threadId,
        },
      }
    case 'open': {
      const cur = state[action.workspaceId]
      if (!cur) return state
      const live = new Set(cur.live)
      live.add(action.threadId)
      return { ...state, [action.workspaceId]: { ...cur, live, active: action.threadId } }
    }
    case 'select': {
      const cur = state[action.workspaceId]
      if (!cur || cur.active === action.threadId) return state
      return { ...state, [action.workspaceId]: { ...cur, active: action.threadId } }
    }
    case 'bind': {
      const cur = state[action.workspaceId]
      if (!cur || cur.bound[action.threadId] === action.sessionId) return state
      return {
        ...state,
        [action.workspaceId]: {
          ...cur,
          bound: { ...cur.bound, [action.threadId]: action.sessionId },
        },
      }
    }
    case 'remove': {
      const cur = state[action.workspaceId]
      if (!cur || !cur.live.has(action.threadId)) return state
      const live = new Set(cur.live)
      live.delete(action.threadId)
      const bound = { ...cur.bound }
      delete bound[action.threadId]
      // `active` is left to the caller: deleting the active Thread is paired with a
      // `select` back to the connection's primary Thread (which is never deletable).
      return { ...state, [action.workspaceId]: { ...cur, live, bound } }
    }
  }
}

/** A Workspace's live-state, or null when it has never connected this session. */
export function workspaceThreadStateFor(
  state: WorkspaceThreadsState,
  workspaceId: string | null,
): WorkspaceThreadState | null {
  if (!workspaceId) return null
  return state[workspaceId] ?? null
}
