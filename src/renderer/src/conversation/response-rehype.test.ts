import { describe, expect, it } from 'vitest'
import { defaultRehypePlugins } from 'streamdown'
import { responseRehypePlugins } from './response-rehype'

/**
 * Structural pins for the #168 chain. The end-to-end behaviour (file chips render, XSS stays
 * blocked) is exercised through the real SSR pipeline in `Response.test.ts`; these tests guard the
 * one property that review hinges on: that we reproduce streamdown's default `[raw, sanitize, harden]`
 * chain with `raw` and `sanitize` UNCHANGED, wrapping only `harden`.
 */
describe('responseRehypePlugins', () => {
  it('is the [raw, sanitize, harden] chain in order', () => {
    expect(responseRehypePlugins).toHaveLength(3)
  })

  it('re-uses streamdown\'s raw and sanitize entries by reference (unchanged)', () => {
    const defaults = defaultRehypePlugins as Record<'raw' | 'sanitize' | 'harden', unknown>
    expect(responseRehypePlugins[0]).toBe(defaults.raw)
    expect(responseRehypePlugins[1]).toBe(defaults.sanitize)
  })

  it('replaces only the harden entry with our wrapper (a fresh plugin function)', () => {
    const defaults = defaultRehypePlugins as Record<'raw' | 'sanitize' | 'harden', unknown>
    expect(responseRehypePlugins[2]).not.toBe(defaults.harden)
    expect(typeof responseRehypePlugins[2]).toBe('function')
  })
})
