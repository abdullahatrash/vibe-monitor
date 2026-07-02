import { describe, expect, it } from 'vitest'
import {
  coerceExpandedSurface,
  collapseSurface,
  EXPANDABLE_SURFACES,
  resolveSurfaceChord,
  toggleSurface,
} from './surface-model'

describe('toggleSurface', () => {
  it('expands a Surface from the collapsed stack', () => {
    expect(toggleSurface(null, 'review')).toBe('review')
    expect(toggleSurface(null, 'files')).toBe('files')
  })

  it('collapses back to the stack when re-toggling the expanded Surface', () => {
    expect(toggleSurface('review', 'review')).toBeNull()
    expect(toggleSurface('files', 'files')).toBeNull()
  })

  it('switches to the other Surface (at most one open at a time)', () => {
    expect(toggleSurface('review', 'files')).toBe('files')
    expect(toggleSurface('files', 'review')).toBe('review')
  })
})

describe('collapseSurface', () => {
  it('always returns the collapsed (null) stack state', () => {
    expect(collapseSurface()).toBeNull()
  })
})

describe('coerceExpandedSurface', () => {
  it('accepts the two live Surface ids', () => {
    expect(coerceExpandedSurface('review')).toBe('review')
    expect(coerceExpandedSurface('files')).toBe('files')
  })

  it('collapses any unknown / legacy / inert value to null', () => {
    expect(coerceExpandedSurface(null)).toBeNull()
    expect(coerceExpandedSurface(undefined)).toBeNull()
    expect(coerceExpandedSurface('terminal')).toBeNull()
    expect(coerceExpandedSurface('browser')).toBeNull()
    expect(coerceExpandedSurface('')).toBeNull()
    expect(coerceExpandedSurface(0)).toBeNull()
    expect(coerceExpandedSurface({})).toBeNull()
    expect(coerceExpandedSurface(['review'])).toBeNull()
  })
})

describe('EXPANDABLE_SURFACES', () => {
  it('is exactly the two live Surfaces', () => {
    expect([...EXPANDABLE_SURFACES]).toEqual(['review', 'files'])
  })
})

// #187 follow-up: the panel itself is header-toggled and defaults closed, so a shortcut
// resolves against the WHOLE panel state (open + expanded), not just the Surface.
describe('resolveSurfaceChord', () => {
  it('opens a closed panel with that Surface expanded', () => {
    expect(resolveSurfaceChord({ open: false, expanded: null }, 'files')).toEqual({
      open: true,
      expanded: 'files',
    })
    expect(resolveSurfaceChord({ open: false, expanded: 'review' }, 'files')).toEqual({
      open: true,
      expanded: 'files',
    })
  })

  it('closes the panel when its Surface is already expanded, keeping the choice', () => {
    expect(resolveSurfaceChord({ open: true, expanded: 'files' }, 'files')).toEqual({
      open: false,
      expanded: 'files',
    })
    expect(resolveSurfaceChord({ open: true, expanded: 'review' }, 'review')).toEqual({
      open: false,
      expanded: 'review',
    })
  })

  it('switches Surface when the panel is open on another (or none)', () => {
    expect(resolveSurfaceChord({ open: true, expanded: 'review' }, 'files')).toEqual({
      open: true,
      expanded: 'files',
    })
    expect(resolveSurfaceChord({ open: true, expanded: null }, 'review')).toEqual({
      open: true,
      expanded: 'review',
    })
  })
})
