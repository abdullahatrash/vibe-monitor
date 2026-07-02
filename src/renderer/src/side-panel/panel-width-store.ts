/**
 * The side panel's INLINE width in pixels (#drag-to-resize, t3code parity): a
 * renderer-only, display-only number, exactly like the sidebar's width
 * (`shell/sidebar-width-store.ts`) — pure UI chrome, so it lives in localStorage
 * alone: no IPC, no main, no persistence store. Per-window, not per-Workspace
 * (t3code persists its panel width the same way).
 *
 * Unlike the sidebar, the MAX is viewport-relative (t3code's rule): the panel may
 * take at most 70% of the window, hard-capped at 1400px, so a huge stored width
 * (or a drag on a wide monitor persisted before a window shrink) can never bury
 * the conversation. The clamp therefore takes the CURRENT viewport width; when the
 * viewport is so narrow the ceiling would dip under the floor, the floor wins
 * (below ~980px the panel presents as a Sheet anyway).
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt
 * store and falls back to the default.
 */

/** Narrowest the panel may be dragged (px) — t3code's 360. */
export const MIN_PANEL_WIDTH = 360
/** Hard ceiling regardless of viewport (px) — t3code's 1400. */
export const MAX_PANEL_WIDTH_PX = 1400
/** The panel may take at most this fraction of the viewport — t3code's 0.7. */
export const MAX_PANEL_WIDTH_FRACTION = 0.7
/** The default (and double-click reset) panel width (px) — t3code's 540. */
export const DEFAULT_PANEL_WIDTH = 540

/** The single localStorage key holding the side panel's inline width. */
export const PANEL_WIDTH_STORAGE_KEY = 'vibe-mistro:side-panel-width:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface PanelWidthStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The effective maximum for a given viewport: `min(1400, floor(viewport * 0.7))`,
 * but never below {@link MIN_PANEL_WIDTH} (a degenerate viewport must not invert
 * the clamp range). A NaN/non-finite viewport falls back to the hard ceiling.
 */
export function maxPanelWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return MAX_PANEL_WIDTH_PX
  const fromViewport = Math.floor(viewportWidth * MAX_PANEL_WIDTH_FRACTION)
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH_PX, fromViewport))
}

/**
 * Clamp a width to [MIN, maxPanelWidth(viewport)]. A NaN/non-finite width (e.g. a
 * corrupt parse) falls back to {@link DEFAULT_PANEL_WIDTH} (itself clamped, so a
 * narrow viewport still yields a fitting width). Pure — the single source of truth
 * for "a valid panel width".
 */
export function clampPanelWidth(px: number, viewportWidth: number): number {
  const max = maxPanelWidth(viewportWidth)
  if (!Number.isFinite(px)) return Math.min(DEFAULT_PANEL_WIDTH, max)
  if (px < MIN_PANEL_WIDTH) return MIN_PANEL_WIDTH
  if (px > max) return max
  return px
}

/**
 * The persisted (clamped) panel width, or {@link DEFAULT_PANEL_WIDTH} when
 * absent/unknown/unavailable. Never throws — a blocked/throwing/corrupt store must
 * not trap the panel at a bad width.
 */
export function getPanelWidth(
  storage: PanelWidthStorage | null | undefined,
  viewportWidth: number,
): number {
  const fallback = clampPanelWidth(DEFAULT_PANEL_WIDTH, viewportWidth)
  if (!storage) return fallback
  try {
    const raw = storage.getItem(PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return fallback
    return clampPanelWidth(Number(raw), viewportWidth)
  } catch {
    return fallback
  }
}

/** Persist the panel width (clamped) best-effort; a quota/security exception is swallowed. */
export function setPanelWidth(
  storage: PanelWidthStorage | null | undefined,
  px: number,
  viewportWidth: number,
): void {
  if (!storage) return
  try {
    storage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clampPanelWidth(px, viewportWidth)))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a resize drag.
  }
}
