/**
 * The right-hand side panel's Surface model (ADR-0013 decision 1, CONTEXT.md "Surface").
 * At most ONE Surface is expanded at a time; `null` means the collapsed launcher-card
 * stack is showing. Pure + DOM-free (the nav-reducer #48 idiom) — the JSX is a thin
 * switch over this.
 *
 * Only Review and Files are LIVE (expandable) Surfaces this slice; Terminal and Browser
 * are inert "Soon" cards with no expanded state, so they are not part of this set.
 */

/** A live, expandable Surface. */
export type Surface = 'review' | 'files'

/** Which Surface is expanded, or `null` for the collapsed card stack. */
export type ExpandedSurface = Surface | null

/** The live (expandable) Surfaces. */
export const EXPANDABLE_SURFACES: readonly Surface[] = ['review', 'files']

/**
 * Toggle a Surface: expand it, or collapse back to the card stack when it is ALREADY the
 * expanded one. Opening a Surface while a DIFFERENT one is expanded switches to it — at
 * most one is ever open. Backs both the launcher-card click and the keyboard shortcut.
 */
export function toggleSurface(current: ExpandedSurface, surface: Surface): ExpandedSurface {
  return current === surface ? null : surface
}

/** Collapse to the card stack (the expanded Surface header's collapse affordance). */
export function collapseSurface(): ExpandedSurface {
  return null
}

/**
 * Coerce an untrusted stored value into a valid `ExpandedSurface`. Anything that is not a
 * known live Surface collapses to `null`, so a corrupt / renamed / legacy blob degrades to
 * the card stack rather than a broken expanded state.
 */
export function coerceExpandedSurface(raw: unknown): ExpandedSurface {
  return raw === 'review' || raw === 'files' ? raw : null
}
