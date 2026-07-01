import { describe, it, expect } from 'vitest'
import {
  codeToHtml,
  getSharedHighlighter,
  ShikiStreamTokenizer,
  processFile,
  renderDiffWithHighlighter,
} from '@pierre/diffs'

/**
 * Regression guard for #159 (shiki dedup). `DiffView` renders the working-tree diff with
 * `@pierre/diffs`, whose highlighting is backed by shiki. #159 pins ONE shiki 3.x (via a
 * package.json `overrides`) to collapse the streamdown-3.x / @pierre/diffs-4.x duplication.
 * `@pierre/diffs` declares `shiki: "^3.0.0 || ^4.0.0"`, so pinning 3.x is only safe if its
 * highlight path still tokenizes on shiki 3.x. This exercises that path headlessly — the same
 * library entry points the diff worker uses — so a future dep bump that breaks the pin fails here
 * instead of silently shipping an unhighlighted diff panel. (unified vs split is a downstream
 * layout option over these same tokens, not a separate shiki call.)
 */

const SAMPLES: Record<string, { file: string; code: string }> = {
  typescript: { file: 'f.ts', code: 'const greet = (name: string): string => `hi ${name}`' },
  python: { file: 'f.py', code: 'def greet(name: str) -> str:\n    return f"hi {name}"' },
  css: { file: 'f.css', code: '.foo { color: #ff0000; margin: 0 auto; }' },
}
const LANGS = Object.keys(SAMPLES)
const THEME = 'github-light'

describe('@pierre/diffs highlighting on the pinned shiki 3.x (#159)', () => {
  it('re-exports shiki codeToHtml and produces styled spans', async () => {
    for (const lang of LANGS) {
      const html = await codeToHtml(SAMPLES[lang].code, { lang, theme: THEME })
      expect(html).toContain('<span')
      expect(html).toContain('style=')
    }
  })

  it('tokenizes via the shared highlighter + stream tokenizer (the worker path)', async () => {
    const highlighter = await getSharedHighlighter({ themes: [THEME], langs: LANGS })
    expect(highlighter).toBeTruthy()
    for (const lang of LANGS) {
      const tokenizer = new ShikiStreamTokenizer({ highlighter, lang, theme: THEME })
      await tokenizer.enqueue(SAMPLES[lang].code)
      const { stable } = tokenizer.close()
      const colored = stable.filter((t) => t.color && t.content.trim().length > 0)
      expect(stable.length).toBeGreaterThan(0)
      expect(colored.length).toBeGreaterThan(0)
    }
  })

  it('renders a parsed file diff end-to-end (processFile -> renderDiffWithHighlighter)', async () => {
    const highlighter = await getSharedHighlighter({ themes: [THEME], langs: LANGS })
    for (const lang of LANGS) {
      const { file } = SAMPLES[lang]
      const patch = [
        `diff --git a/${file} b/${file}`,
        'index 000..111 100644',
        `--- a/${file}`,
        `+++ b/${file}`,
        '@@ -1,2 +1,2 @@',
        '-const x = 1',
        '+const x = 2',
        ' const y = x',
      ].join('\n')
      const fileDiff = processFile(patch, { isGitDiff: true, throwOnError: true })
      expect(fileDiff).toBeTruthy()
      const result = renderDiffWithHighlighter(fileDiff!, highlighter, {
        theme: THEME,
        useTokenTransformer: false,
        tokenizeMaxLineLength: 100_000,
        lineDiffType: 'word',
        maxLineDiffLength: 1_000,
      })
      expect(result.code).toBeTruthy()
      expect(result.themeStyles.length).toBeGreaterThan(0)
    }
  })
})
