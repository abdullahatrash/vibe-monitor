/**
 * Whether the right SIDE PANEL is OPEN (#187 follow-up): a renderer-only, display-only,
 * app-global boolean — the mirror of the left sidebar's collapsed flag (#127). The
 * user's design opens the panel from the window header's PanelRight icon (or a Surface
 * shortcut); it is CLOSED by default, so the conversation gets the full width until
 * asked. Which Surface is expanded INSIDE the panel stays per-Workspace in
 * `surface-state-store` — this flag only says whether the panel is showing at all.
 *
 * Storage seam injected (tests pass a fake, render code passes `window.localStorage`);
 * every path tolerates an unavailable/throwing/corrupt store and falls back to the
 * default (CLOSED = `false`) so a blocked store never wedges the panel open.
 */

/** The single localStorage key holding the side-panel-open flag. */
export const SIDE_PANEL_OPEN_STORAGE_KEY = 'vibe-mistro:side-panel-open:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface SidePanelOpenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The persisted open flag, or `false` (closed) when absent/unknown/unavailable. */
export function getSidePanelOpen(storage: SidePanelOpenStorage | null | undefined): boolean {
  if (!storage) return false
  try {
    return storage.getItem(SIDE_PANEL_OPEN_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the open flag best-effort; a quota/security exception is swallowed. */
export function setSidePanelOpen(
  storage: SidePanelOpenStorage | null | undefined,
  open: boolean,
): void {
  if (!storage) return
  try {
    storage.setItem(SIDE_PANEL_OPEN_STORAGE_KEY, open ? 'true' : 'false')
  } catch {
    // Best-effort: a full/blocked storage must never throw from a panel toggle.
  }
}
