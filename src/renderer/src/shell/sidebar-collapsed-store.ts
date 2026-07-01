/**
 * Whether the left sidebar is COLLAPSED (#127): a renderer-only, display-only boolean.
 * Collapsing the sidebar is pure UI chrome — it never spawns an agent, changes the
 * active Workspace, or touches nav/persistence — so (like the project fold state #138,
 * the sort order #129, and composer drafts #60) it lives in localStorage alone: no IPC,
 * no main, no persistence store.
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt store
 * and falls back to the default (EXPANDED = `false`) so a blocked store never traps the
 * sidebar shut. The value is the string `"true"`/`"false"`; anything else is treated as
 * absent → default.
 */

/** The single localStorage key holding the sidebar-collapsed flag. */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'vibe-mistro:sidebar-collapsed:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface SidebarCollapsedStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The persisted collapsed flag, or `false` (expanded) when absent/unknown/unavailable.
 * Never throws — a blocked/throwing/corrupt store must not trap the sidebar shut.
 */
export function getSidebarCollapsed(storage: SidebarCollapsedStorage | null | undefined): boolean {
  if (!storage) return false
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the collapsed flag best-effort; a quota/security exception is swallowed. */
export function setSidebarCollapsed(
  storage: SidebarCollapsedStorage | null | undefined,
  collapsed: boolean,
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false')
  } catch {
    // Best-effort: a full/blocked storage must never throw from a collapse toggle.
  }
}
