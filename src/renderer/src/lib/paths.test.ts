import { describe, expect, it } from 'vitest'
import { basename } from './paths'

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basename('src/app.ts')).toBe('app.ts')
    expect(basename('README.md')).toBe('README.md')
    expect(basename('/a/b')).toBe('b')
  })

  it('handles backslash separators (and mixed)', () => {
    expect(basename('src\\dir\\reducer.ts')).toBe('reducer.ts')
    expect(basename('C:\\foo\\bar.ts')).toBe('bar.ts')
    expect(basename('a/b\\c')).toBe('c')
  })

  it('tolerates trailing/leading/duplicate separators and empty input', () => {
    expect(basename('src/dir/')).toBe('dir')
    expect(basename('a//b')).toBe('b')
    expect(basename('')).toBe('')
  })
})
