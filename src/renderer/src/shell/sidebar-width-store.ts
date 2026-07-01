/**
 * The left sidebar's EXPANDED width in pixels (#drag-to-resize): a renderer-only,
 * display-only number. Resizing the sidebar is pure UI chrome — it never spawns an
 * agent, changes the active Workspace, or touches nav/persistence — so (like the
 * collapsed flag #127, the project fold state #138, and the sort order #129) it lives
 * in localStorage alone: no IPC, no main, no persistence store.
 *
 * The width is always CLAMPED to [MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH] so a corrupt
 * or out-of-range stored value (or a drag past the bounds) can never wedge the sidebar
 * too narrow to use or too wide to fit. A missing/NaN/non-finite value falls back to
 * DEFAULT_SIDEBAR_WIDTH.
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt store and
 * falls back to the default so a blocked store never traps the sidebar at a bad width.
 */

/** Narrowest the sidebar may be dragged (px). */
export const MIN_SIDEBAR_WIDTH = 240
/** Widest the sidebar may be dragged (px). */
export const MAX_SIDEBAR_WIDTH = 480
/** The default (and double-click reset) sidebar width (px) — the historical `w-[338px]`. */
export const DEFAULT_SIDEBAR_WIDTH = 338

/** The single localStorage key holding the sidebar's expanded width. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'vibe-mistro:sidebar-width:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface SidebarWidthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Clamp a width to [MIN, MAX]. A NaN/non-finite input (e.g. a corrupt parse) falls back
 * to {@link DEFAULT_SIDEBAR_WIDTH}. Pure — the single source of truth for "a valid width".
 */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_WIDTH
  if (px < MIN_SIDEBAR_WIDTH) return MIN_SIDEBAR_WIDTH
  if (px > MAX_SIDEBAR_WIDTH) return MAX_SIDEBAR_WIDTH
  return px
}

/**
 * The persisted (clamped) sidebar width, or {@link DEFAULT_SIDEBAR_WIDTH} when
 * absent/unknown/unavailable. Never throws — a blocked/throwing/corrupt store must not
 * trap the sidebar at a bad width.
 */
export function getSidebarWidth(storage: SidebarWidthStorage | null | undefined): number {
  if (!storage) return DEFAULT_SIDEBAR_WIDTH
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    if (!raw) return DEFAULT_SIDEBAR_WIDTH
    return clampSidebarWidth(Number(raw))
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

/** Persist the sidebar width (clamped) best-effort; a quota/security exception is swallowed. */
export function setSidebarWidth(
  storage: SidebarWidthStorage | null | undefined,
  px: number,
): void {
  if (!storage) return
  try {
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(px)))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a resize drag.
  }
}
