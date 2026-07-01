import { describe, it, expect } from 'vitest'
import { normalizeRename } from './rename'

describe('normalizeRename (sidebar rename commit rule)', () => {
  it('commits the trimmed input when it is a real change', () => {
    expect(normalizeRename('  New name  ', 'Old')).toBe('New name')
    expect(normalizeRename('First title', null)).toBe('First title') // renaming an untitled Thread
  })

  it('no-ops (null) on empty/whitespace — blanking is a cancel, never a persisted ""', () => {
    expect(normalizeRename('', 'Old')).toBeNull()
    expect(normalizeRename('   ', 'Old')).toBeNull()
    expect(normalizeRename('', null)).toBeNull()
  })

  it('no-ops (null) when the trimmed input equals the current title', () => {
    expect(normalizeRename('Old', 'Old')).toBeNull()
    expect(normalizeRename('  Old  ', 'Old')).toBeNull()
  })
})
