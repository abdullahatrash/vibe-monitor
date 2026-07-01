/**
 * The Projects switcher's sort order (#129): a renderer-only, display-only choice
 * for how the project-switcher dropdown lists Workspaces. It NEVER changes which
 * Workspace is active or the Thread list — it only reorders the switcher rows.
 *
 * `'recent'` (the default) preserves the incoming order — App already hands the
 * list most-recent-first (`lastOpenedAt`), so recency is the identity ordering.
 * `'name'` sorts by `displayName`, case-insensitively and STABLY (equal names keep
 * their incoming relative order). The sort is PURE and returns a NEW array; the
 * caller's `workspaces` prop is never mutated.
 *
 * The chosen order is EPHEMERAL UI state, so — like composer drafts (#60) — it
 * lives in localStorage only (no IPC, no main). The storage seam is INJECTED so
 * tests pass a fake and render code passes `window.localStorage`; every path
 * tolerates an unavailable/throwing/corrupt store and falls back to the default.
 */

/** How the project-switcher dropdown orders its Workspace rows. */
export type WorkspaceSortOrder = 'recent' | 'name'

/** The order applied when nothing is stored (or the store is unreadable). */
export const DEFAULT_SORT_ORDER: WorkspaceSortOrder = 'recent'

/** The single localStorage key holding the chosen sort order. */
export const WORKSPACE_SORT_STORAGE_KEY = 'vibe-mistro:workspace-sort:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface SortOrderStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A Workspace as far as sorting cares — just its display label. */
interface Sortable {
  displayName: string
}

/**
 * Return a NEW array of Workspaces in the chosen order — the input is never
 * mutated. `'recent'` is the identity ordering (App already provides recency);
 * `'name'` sorts by `displayName` case-insensitively and stably (`Array.sort` is
 * stable, and equal case-folded names compare 0, so their incoming order holds).
 */
export function sortWorkspaces<T extends Sortable>(
  workspaces: readonly T[],
  order: WorkspaceSortOrder,
): T[] {
  const copy = workspaces.slice()
  if (order !== 'name') return copy
  return copy.sort((a, b) => {
    const an = a.displayName.toLowerCase()
    const bn = b.displayName.toLowerCase()
    if (an < bn) return -1
    if (an > bn) return 1
    return 0
  })
}

/** Narrow an arbitrary stored value to a known order (else the default). */
function coerce(value: string | null): WorkspaceSortOrder {
  return value === 'name' || value === 'recent' ? value : DEFAULT_SORT_ORDER
}

/**
 * The stored sort order, or the default when absent/unknown/unavailable. Never
 * throws — a blocked/throwing store must not break the sidebar's render.
 */
export function getSortOrder(storage: SortOrderStorage | null | undefined): WorkspaceSortOrder {
  if (!storage) return DEFAULT_SORT_ORDER
  try {
    return coerce(storage.getItem(WORKSPACE_SORT_STORAGE_KEY))
  } catch {
    return DEFAULT_SORT_ORDER
  }
}

/** Persist the chosen order best-effort; a quota/security exception is swallowed. */
export function setSortOrder(
  storage: SortOrderStorage | null | undefined,
  order: WorkspaceSortOrder,
): void {
  if (!storage) return
  try {
    storage.setItem(WORKSPACE_SORT_STORAGE_KEY, order)
  } catch {
    // Best-effort: a full/blocked storage must never throw from a click.
  }
}
