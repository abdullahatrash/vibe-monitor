import { describe, it, expect } from 'vitest'
import { extractLinkHrefs, fileLinkLabels, isSafeExternalHref, parseFileLink } from './file-link'

/**
 * File-path chip links (#114): the pure parse behind the orange chip. A markdown
 * link destination is classified as a file path (→ chip) or not (→ plain link),
 * its `:line:col` / `#Lx` position is split off, and colliding basenames across
 * one message are disambiguated with parent dirs. All DOM-free — exercised here as
 * plain data with no renderer. Ported from t3code's `markdown-links.ts`.
 */

describe('parseFileLink — classification', () => {
  it('accepts an absolute posix file path', () => {
    expect(parseFileLink('/Users/me/project/AGENTS.md')).toMatchObject({
      path: '/Users/me/project/AGENTS.md',
      basename: 'AGENTS.md',
    })
  })

  it('accepts a relative path with directory segments', () => {
    expect(parseFileLink('src/conversation/reducer.ts')).toMatchObject({
      path: 'src/conversation/reducer.ts',
      basename: 'reducer.ts',
    })
  })

  it('accepts a bare filename with an extension', () => {
    expect(parseFileLink('AGENTS.md')).toMatchObject({ path: 'AGENTS.md', basename: 'AGENTS.md' })
  })

  it('rejects external http(s) urls', () => {
    expect(parseFileLink('https://example.com/docs')).toBeNull()
    expect(parseFileLink('http://example.com/a/b.ts')).toBeNull()
  })

  it('rejects mailto and other non-file schemes', () => {
    expect(parseFileLink('mailto:me@example.com')).toBeNull()
  })

  it('rejects bare fragment anchors', () => {
    expect(parseFileLink('#section')).toBeNull()
  })

  it('rejects an empty or whitespace destination', () => {
    expect(parseFileLink('')).toBeNull()
    expect(parseFileLink('   ')).toBeNull()
  })

  it('rejects an app route with no file extension', () => {
    expect(parseFileLink('/chat/settings')).toBeNull()
  })

  it('accepts an absolute path under a known root even without a dotted extension', () => {
    expect(parseFileLink('/tmp/scratch')).toMatchObject({ path: '/tmp/scratch', basename: 'scratch' })
  })
})

describe('parseFileLink — position suffix', () => {
  it('splits a :line suffix', () => {
    expect(parseFileLink('src/index.ts:42')).toMatchObject({
      path: 'src/index.ts',
      basename: 'index.ts',
      line: 42,
    })
  })

  it('splits a :line:col suffix', () => {
    expect(parseFileLink('src/index.ts:42:7')).toMatchObject({
      path: 'src/index.ts',
      line: 42,
      column: 7,
    })
  })

  it('does not treat a filename line reference as an external scheme', () => {
    expect(parseFileLink('script.ts:10')).toMatchObject({
      path: 'script.ts',
      line: 10,
    })
  })

  it('maps a #Lx anchor to a line', () => {
    expect(parseFileLink('/Users/me/project/src/main.ts#L42')).toMatchObject({
      path: '/Users/me/project/src/main.ts',
      line: 42,
    })
  })

  it('maps a #LxCy anchor to a line and column', () => {
    expect(parseFileLink('/Users/me/project/src/main.ts#L42C7')).toMatchObject({
      path: '/Users/me/project/src/main.ts',
      line: 42,
      column: 7,
    })
  })

  it('omits line/column when there is no position', () => {
    const link = parseFileLink('src/index.ts')
    expect(link).not.toBeNull()
    expect(link?.line).toBeUndefined()
    expect(link?.column).toBeUndefined()
  })
})

describe('parseFileLink — normalization', () => {
  it('strips a file:// uri down to its path', () => {
    expect(parseFileLink('file:///Users/me/project/src/main.ts#L42')).toMatchObject({
      path: '/Users/me/project/src/main.ts',
      line: 42,
    })
  })

  it('unwraps an angle-bracketed destination', () => {
    expect(parseFileLink('<src/index.ts:3>')).toMatchObject({ path: 'src/index.ts', line: 3 })
  })

  it('trims surrounding whitespace', () => {
    expect(parseFileLink('  src/index.ts  ')).toMatchObject({ path: 'src/index.ts' })
  })

  it('decodes a percent-encoded absolute path once', () => {
    expect(parseFileLink('/Users/me/project/my%20file.ts')).toMatchObject({
      path: '/Users/me/project/my file.ts',
      basename: 'my file.ts',
    })
  })
})

describe('extractLinkHrefs', () => {
  it('pulls every markdown link destination in order', () => {
    const text = 'See [reducer](src/reducer.ts) and [main](/tmp/main.ts:9) plus [site](https://x.com).'
    expect(extractLinkHrefs(text)).toEqual([
      'src/reducer.ts',
      '/tmp/main.ts:9',
      'https://x.com',
    ])
  })

  it('ignores a title after the destination', () => {
    expect(extractLinkHrefs('[a](src/a.ts "the a file")')).toEqual(['src/a.ts'])
  })

  it('returns an empty list when there are no links', () => {
    expect(extractLinkHrefs('plain prose with no links')).toEqual([])
  })
})

describe('fileLinkLabels — basename disambiguation', () => {
  it('labels a unique basename with just the basename', () => {
    const labels = fileLinkLabels(['src/conversation/reducer.ts', 'src/main/index.ts'])
    expect(labels.get('src/conversation/reducer.ts')).toBe('reducer.ts')
    expect(labels.get('src/main/index.ts')).toBe('index.ts')
  })

  it('disambiguates colliding basenames with the nearest distinguishing parent', () => {
    const labels = fileLinkLabels([
      'src/conversation/reducer.ts',
      'src/shell/reducer.ts',
    ])
    expect(labels.get('src/conversation/reducer.ts')).toBe('reducer.ts · conversation')
    expect(labels.get('src/shell/reducer.ts')).toBe('reducer.ts · shell')
  })

  it('leaves non-colliding paths untouched while disambiguating colliding ones', () => {
    const labels = fileLinkLabels([
      'a/b/reducer.ts',
      'a/c/reducer.ts',
      'x/y/index.ts',
    ])
    expect(labels.get('x/y/index.ts')).toBe('index.ts')
    expect(labels.get('a/b/reducer.ts')).toBe('reducer.ts · b')
    expect(labels.get('a/c/reducer.ts')).toBe('reducer.ts · c')
  })

  it('deduplicates identical paths (no false collision with itself)', () => {
    const labels = fileLinkLabels(['src/reducer.ts', 'src/reducer.ts'])
    expect(labels.get('src/reducer.ts')).toBe('reducer.ts')
  })
})

describe('isSafeExternalHref — defence-in-depth scheme allow-list', () => {
  it('allows http(s) / mailto / tel', () => {
    expect(isSafeExternalHref('https://example.com/a')).toBe(true)
    expect(isSafeExternalHref('http://example.com')).toBe(true)
    expect(isSafeExternalHref('mailto:x@y.com')).toBe(true)
    expect(isSafeExternalHref('tel:+15551234')).toBe(true)
  })

  it('allows scheme-less destinations (relative path / #anchor — inert)', () => {
    expect(isSafeExternalHref('/docs/x')).toBe(true)
    expect(isSafeExternalHref('#section')).toBe(true)
    expect(isSafeExternalHref('relative/page')).toBe(true)
  })

  it('rejects script-bearing schemes regardless of case / whitespace', () => {
    expect(isSafeExternalHref('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalHref('  JavaScript:alert(1)')).toBe(false)
    expect(isSafeExternalHref('data:text/html,<script>1</script>')).toBe(false)
    expect(isSafeExternalHref('vbscript:msgbox(1)')).toBe(false)
    expect(isSafeExternalHref('<javascript:alert(1)>')).toBe(false)
  })

  it('rejects empty / undefined', () => {
    expect(isSafeExternalHref(undefined)).toBe(false)
    expect(isSafeExternalHref('')).toBe(false)
  })
})
