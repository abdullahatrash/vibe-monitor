import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Response } from './Response'

/**
 * End-to-end tests for the #168 fix, driven through the REAL streamdown render pipeline.
 * `renderToStaticMarkup(<Response/>)` runs the full markdown → remark → rehype (raw → sanitize →
 * guarded-harden) → React chain in the vitest node env, so these assert on the actual emitted HTML —
 * not on isolated parse logic. This is the true adversarial surface: what a user's DOM would receive.
 *
 * (No `openFile` context is provided here, so `FileChip` renders its non-navigating `<span>` variant;
 * the `data-file-chip` marker is present either way.)
 */
function render(text: string): string {
  return renderToStaticMarkup(createElement(Response, { text }))
}

describe('Response — file-path links render as chips (#168)', () => {
  const fileLinkCases: ReadonlyArray<[string, string]> = [
    ['bare filename', '[label](test.txt)'],
    ['dot-relative path', '[label](./src/x.ts)'],
    ['absolute path', '[label](/Users/me/project/x.ts)'],
    ['relative path with line ref', '[label](src/x.ts:42)'],
  ]

  for (const [name, input] of fileLinkCases) {
    it(`renders a FileChip for a ${name}, not [blocked]`, () => {
      const html = render(input)
      expect(html).toContain('data-file-chip')
      expect(html).not.toContain('[blocked]')
      expect(html).not.toContain('Blocked URL')
    })
  }

  it('renders the chip with the parsed line ref (L42) for a positioned path', () => {
    const html = render('[label](src/x.ts:42)')
    expect(html).toContain('data-file-chip')
    expect(html).toContain('L42')
  })
})

describe('Response — external links stay real, safe anchors', () => {
  it('keeps an https link as an anchor with href, target=_blank and rel', () => {
    const html = render('[ext](https://example.com/page)')
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('data-file-chip')
    expect(html).not.toContain('[blocked]')
  })
})

describe('Response — dangerous link schemes are neutralized end-to-end', () => {
  const dangerous: ReadonlyArray<[string, string, string]> = [
    ['javascript:', '[x](javascript:alert(1))', 'javascript:'],
    ['data:text/html', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', 'data:text/html'],
    ['vbscript:', '[x](vbscript:msgbox(1))', 'vbscript:'],
  ]

  for (const [name, input, needle] of dangerous) {
    it(`strips a ${name} link entirely (no scheme, no clickable anchor)`, () => {
      const html = render(input)
      // The dangerous scheme string must not survive anywhere in the output (not in an href,
      // not in a title attribute) — sanitize removes the href before it can render.
      expect(html).not.toContain(needle)
      expect(html).not.toContain('href="javascript:')
      expect(html).not.toContain('href="data:')
      expect(html).not.toContain('href="vbscript:')
      // Never rendered as a file chip either.
      expect(html).not.toContain('data-file-chip')
    })
  }
})

describe('Response — raw HTML stays dropped (skipHtml + sanitize)', () => {
  it('drops a raw <script> tag', () => {
    const html = render('Hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('drops an onerror handler and the blocked <img>', () => {
    const html = render('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })
})
