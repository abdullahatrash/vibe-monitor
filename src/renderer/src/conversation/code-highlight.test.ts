import { describe, it, expect } from 'vitest'
import { code } from '@streamdown/code'
import type { BundledLanguage } from 'shiki'

/**
 * Regression guard for #159 (shiki dedup). `Response` renders assistant markdown with
 * `streamdown` + `@streamdown/code`, whose fenced-code highlighting is backed by shiki
 * (`@streamdown/code` requires `shiki: "^3.19.0"`). #159 pins ONE shiki 3.x across the app so
 * this consumer and `@pierre/diffs` share a single grammar bundle. This confirms the highlight
 * path still tokenizes on the pinned shiki. The plugin's `highlight` is callback-based (returns
 * null until grammars load), so we wrap it in a promise.
 */

const SAMPLES: Record<string, string> = {
  typescript: 'const x: number = 42',
  python: 'def f(x):\n    return x',
  css: '.a { color: red }',
}

interface HighlightLine {
  content: string
  htmlStyle?: { color?: string }
}

function highlight(language: string, source: string): Promise<{ tokens: HighlightLine[][] }> {
  return new Promise((resolve) => {
    const sync = code.highlight(
      { code: source, language: language as BundledLanguage, themes: ['github-light', 'github-dark'] },
      resolve,
    )
    if (sync) resolve(sync)
  })
}

describe('@streamdown/code highlighting on the pinned shiki 3.x (#159)', () => {
  it('reports the shiki-backed plugin', () => {
    expect(code.name).toBe('shiki')
    expect(code.supportsLanguage('typescript' as BundledLanguage)).toBe(true)
  })

  it('tokenizes fenced code with colors for each language', async () => {
    for (const language of Object.keys(SAMPLES)) {
      const result = await highlight(language, SAMPLES[language])
      const tokens = result.tokens.flat()
      expect(tokens.length).toBeGreaterThan(0)
      expect(tokens.some((t) => t.htmlStyle?.color)).toBe(true)
    }
  })
})
