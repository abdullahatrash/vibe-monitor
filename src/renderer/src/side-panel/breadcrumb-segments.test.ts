import { describe, expect, it } from 'vitest'
import { breadcrumbSegments, fileBasename } from './breadcrumb-segments'

describe('fileBasename', () => {
  it('returns the last segment', () => {
    expect(fileBasename('src/app.ts')).toBe('app.ts')
    expect(fileBasename('README.md')).toBe('README.md')
  })

  it('tolerates trailing/leading/duplicate slashes and empty input', () => {
    expect(fileBasename('src/dir/')).toBe('dir')
    expect(fileBasename('/a/b')).toBe('b')
    expect(fileBasename('a//b')).toBe('b')
    expect(fileBasename('')).toBe('')
  })
})

describe('breadcrumbSegments', () => {
  it('returns every segment as a label within the budget', () => {
    expect(breadcrumbSegments('src/app.ts')).toEqual([{ label: 'src' }, { label: 'app.ts' }])
    expect(breadcrumbSegments('a/b/c/d', 4)).toEqual([
      { label: 'a' },
      { label: 'b' },
      { label: 'c' },
      { label: 'd' },
    ])
  })

  it('truncates a deep path to first + ellipsis + last segments', () => {
    // 6 segments, budget 4 → [a, …, e, f.ts]: head + ellipsis + last 2.
    expect(breadcrumbSegments('a/b/c/d/e/f.ts', 4)).toEqual([
      { label: 'a' },
      { label: '…', ellipsis: true },
      { label: 'e' },
      { label: 'f.ts' },
    ])
  })

  it('always keeps the file name (last segment) when truncating', () => {
    const crumbs = breadcrumbSegments('one/two/three/four/five/six/seven.ts', 4)
    expect(crumbs.at(-1)).toEqual({ label: 'seven.ts' })
    expect(crumbs[0]).toEqual({ label: 'one' })
    expect(crumbs.filter((c) => c.ellipsis)).toHaveLength(1)
  })

  it('drops empty segments and handles a single segment', () => {
    expect(breadcrumbSegments('/src//app.ts')).toEqual([{ label: 'src' }, { label: 'app.ts' }])
    expect(breadcrumbSegments('app.ts')).toEqual([{ label: 'app.ts' }])
    expect(breadcrumbSegments('')).toEqual([])
  })
})
