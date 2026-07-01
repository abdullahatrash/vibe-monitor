import { describe, expect, it } from 'vitest'
import { heroHeadline } from './hero-headline'

describe('heroHeadline', () => {
  it('emphasizes the workspace name when present', () => {
    expect(heroHeadline('chatjs')).toEqual({
      lead: 'What should we build in ',
      name: 'chatjs',
      tail: '?',
    })
  })

  it('trims surrounding whitespace on the name', () => {
    expect(heroHeadline('  my-app  ')).toEqual({
      lead: 'What should we build in ',
      name: 'my-app',
      tail: '?',
    })
  })

  it('collapses to a nameless headline when absent or blank', () => {
    const nameless = { lead: 'What should we build?', name: null, tail: '' }
    expect(heroHeadline(null)).toEqual(nameless)
    expect(heroHeadline(undefined)).toEqual(nameless)
    expect(heroHeadline('   ')).toEqual(nameless)
  })
})
