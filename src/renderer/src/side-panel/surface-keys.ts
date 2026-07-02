import type { Surface } from './surface-model'

/** The subset of a `KeyboardEvent` the shortcut matcher reads (DOM-free for testing). */
export interface KeyChord {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Which Surface a keydown toggles, or `null` when the chord is unbound. Renderer-level
 * shortcuts (NO Electron menu accelerators, ADR-0013 decision 1):
 *   - ⌘P  → Files   (the tree-search focus part lands in slice 2)
 *   - ⌃⇧G → Review
 * Browser's ⌘T hint is aspirational chrome — deliberately UNBOUND (the card is inert).
 *
 * Both bound chords carry a modifier, so plain typing never matches: a focused text input
 * can be left to type normally EXCEPT these two combos (neither is a typing combo), which
 * stay live even while a textarea has focus.
 */
export function surfaceForChord(chord: KeyChord): Surface | null {
  const key = chord.key.toLowerCase()
  // ⌘P → Files. Meta only (no ctrl/alt/shift) so ⌘⇧P and ⌃P stay free.
  if (key === 'p' && chord.metaKey && !chord.ctrlKey && !chord.altKey && !chord.shiftKey) {
    return 'files'
  }
  // ⌃⇧G → Review. Ctrl+Shift only (no meta/alt).
  if (key === 'g' && chord.ctrlKey && chord.shiftKey && !chord.metaKey && !chord.altKey) {
    return 'review'
  }
  return null
}
