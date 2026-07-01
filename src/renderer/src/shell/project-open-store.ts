/**
 * Which projects are UNFOLDED in the sidebar's collapsible project list (#138):
 * a renderer-only, display-only set of Workspace ids. Folding/unfolding a project
 * is peek-only — it never spawns an agent or changes the active project — so which
 * rows are open is pure UI state, and (like the sort order #129 and composer drafts
 * #60) it lives in localStorage alone: no IPC, no main, no persistence store.
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt store
 * and falls back to "nothing persisted" so a blocked store never breaks the sidebar.
 * The value is a JSON array of ids; anything non-array or with non-string members is
 * treated as absent.
 */

/** The single localStorage key holding the set of open (unfolded) project ids. */
export const OPEN_PROJECTS_STORAGE_KEY = 'vibe-mistro:open-projects:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface OpenProjectsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The persisted open-project ids, or `[]` when absent/unknown/unavailable. Never
 * throws — a blocked/throwing/corrupt store must not break the sidebar's render.
 */
export function getOpenProjects(storage: OpenProjectsStorage | null | undefined): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(OPEN_PROJECTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

/** Persist the set of open project ids best-effort; a quota/security exception is swallowed. */
export function setOpenProjects(
  storage: OpenProjectsStorage | null | undefined,
  ids: readonly string[],
): void {
  if (!storage) return
  try {
    storage.setItem(OPEN_PROJECTS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a fold toggle.
  }
}
