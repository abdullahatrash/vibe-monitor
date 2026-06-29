import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'

/**
 * Shell navigation state (ADR-0006 decision 2): WHICH Workspace and Thread the
 * user is looking at — decoupled from connection lifecycle (whether that
 * Workspace's agent is spawned / signed in). A pure reducer at the shell root,
 * mirroring conversation/reducer.ts (ADR-0001): no router, no UI-store library.
 *
 * Invariant: a selected Thread always belongs to the selected Workspace — every
 * `select-thread` carries its `workspaceId`, and switching Workspace drops a
 * Thread selection that no longer belongs.
 */
export interface NavState {
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
}

export type NavAction =
  | { type: 'select-workspace'; workspaceId: string }
  | { type: 'select-thread'; workspaceId: string; threadId: string }
  | { type: 'clear' }

export const initialNavState: NavState = {
  selectedWorkspaceId: null,
  selectedThreadId: null,
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'select-workspace':
      // Re-selecting the SAME Workspace is a no-op (keeps any Thread selection);
      // switching to a different one drops the now-foreign Thread selection so the
      // two can never disagree.
      if (state.selectedWorkspaceId === action.workspaceId) return state
      return { selectedWorkspaceId: action.workspaceId, selectedThreadId: null }
    case 'select-thread':
      // Selecting a Thread pins its Workspace too, so the two never disagree.
      return { selectedWorkspaceId: action.workspaceId, selectedThreadId: action.threadId }
    case 'clear':
      return initialNavState
  }
}

/**
 * The selected Thread's cold metadata, or null when nothing is selected or the
 * selection no longer exists (e.g. after a delete refreshed the list). The idle
 * outlet reopens this Thread read-only (ColdThread); a null collapses to the
 * placeholder, so a deleted/absent selection never renders a gone transcript. The
 * lookup is scoped to the selected Workspace, upholding the reducer's invariant.
 */
export function findSelectedThread(
  workspaces: ListMetadataResult,
  state: NavState,
): ThreadMeta | null {
  if (state.selectedThreadId === null) return null
  const workspace = workspaces.find((w) => w.id === state.selectedWorkspaceId)
  return workspace?.threads.find((t) => t.id === state.selectedThreadId) ?? null
}
