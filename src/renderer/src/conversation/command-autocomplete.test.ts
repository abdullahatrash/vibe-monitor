import { describe, it, expect } from 'vitest'
import {
  applyCommand,
  filterCommands,
  getCommandQuery,
  moveSelection,
} from './command-autocomplete'
import type { AcpCommand } from './reducer'

/**
 * `/` slash-command autocomplete (#95): the pure derivation behind the composer
 * popover — trigger detection, prefix-then-substring filtering, the insertion
 * transform, and wrapping selection. All DOM-free, so these exercise the logic as
 * plain data with no renderer.
 */

const COMMANDS: AcpCommand[] = [
  { name: 'init', description: 'Initialise' },
  { name: 'review', description: 'Review the diff' },
  { name: 'rewind' },
  { name: 'clear' },
]

describe('getCommandQuery — trigger detection', () => {
  it('activates on a `/`-token at input start with the caret after the slash', () => {
    expect(getCommandQuery('/re', 3)).toEqual({ active: true, query: 're', start: 0 })
  })

  it('reports an empty query right after a bare slash', () => {
    expect(getCommandQuery('/', 1)).toEqual({ active: true, query: '', start: 0 })
  })

  it('does NOT activate when the token is not at the start of the input', () => {
    expect(getCommandQuery('hello /re', 9).active).toBe(false)
  })

  it('does NOT activate once the token is closed by a trailing space', () => {
    expect(getCommandQuery('/init ', 6).active).toBe(false)
  })

  it('does NOT activate when the caret sits before the word after a closed token', () => {
    // `/init arg` with the caret inside `arg` — the token closed at the space.
    expect(getCommandQuery('/init arg', 9).active).toBe(false)
  })

  it('does NOT activate when the caret rests on the slash itself', () => {
    expect(getCommandQuery('/re', 0).active).toBe(false)
  })

  it('activates for a `/`-token at the start of a later line', () => {
    // "hello\n/re" — the slash opens the second line (index 6), caret at end.
    expect(getCommandQuery('hello\n/re', 9)).toEqual({ active: true, query: 're', start: 6 })
  })

  it('does NOT activate for a non-slash line', () => {
    expect(getCommandQuery('hello world', 5).active).toBe(false)
  })

  it('uses the caret, not the end of value, for the query', () => {
    // Caret sits after `rev`, before the trailing `iew`.
    expect(getCommandQuery('/review', 4)).toEqual({ active: true, query: 'rev', start: 0 })
  })

  it('clamps an out-of-range caret rather than throwing', () => {
    expect(getCommandQuery('/re', 99)).toEqual({ active: true, query: 're', start: 0 })
    expect(getCommandQuery('/re', -5).active).toBe(false)
  })
})

describe('filterCommands — prefix then substring, case-insensitive', () => {
  it('keeps every command for an empty query', () => {
    expect(filterCommands(COMMANDS, '')).toEqual(COMMANDS)
  })

  it('orders prefix matches before substring matches', () => {
    // `re` prefixes `review`/`rewind`; it is a substring of nothing else here.
    expect(filterCommands(COMMANDS, 're').map((c) => c.name)).toEqual(['review', 'rewind'])
  })

  it('includes substring matches after prefix matches', () => {
    // `i` prefixes `init`; it is a substring of `review` and `rewind`.
    expect(filterCommands(COMMANDS, 'i').map((c) => c.name)).toEqual([
      'init',
      'review',
      'rewind',
    ])
  })

  it('is case-insensitive on both sides', () => {
    expect(filterCommands([{ name: 'Init' }], 'IN').map((c) => c.name)).toEqual(['Init'])
  })

  it('drops non-matches', () => {
    expect(filterCommands(COMMANDS, 'zzz')).toEqual([])
  })

  it('preserves original order within each group', () => {
    const cmds: AcpCommand[] = [{ name: 'ab' }, { name: 'ba' }, { name: 'aa' }]
    // Query `a`: prefix group is ab, aa (original order); substring group is ba.
    expect(filterCommands(cmds, 'a').map((c) => c.name)).toEqual(['ab', 'aa', 'ba'])
  })
})

describe('applyCommand — insertion transform', () => {
  it('replaces the `/query` token with `/<name> ` and places the caret after', () => {
    expect(applyCommand('/re', 0, 3, 'rewind')).toEqual({ value: '/rewind ', caret: 8 })
  })

  it('expands a bare slash', () => {
    expect(applyCommand('/', 0, 1, 'init')).toEqual({ value: '/init ', caret: 6 })
  })

  it('keeps text after the caret intact', () => {
    // Accepting at the start line of a two-line draft keeps the second line.
    const out = applyCommand('/re\nkeep', 0, 3, 'review')
    expect(out.value).toBe('/review \nkeep')
    expect(out.caret).toBe(8)
  })

  it('applies to a token that starts mid-value (a later line)', () => {
    const out = applyCommand('hi\n/re', 3, 6, 'rewind')
    expect(out.value).toBe('hi\n/rewind ')
    expect(out.caret).toBe(11)
  })
})

describe('moveSelection — wrapping', () => {
  it('advances within range', () => {
    expect(moveSelection(0, 3, 1)).toBe(1)
  })

  it('wraps past the end', () => {
    expect(moveSelection(2, 3, 1)).toBe(0)
  })

  it('wraps past the start', () => {
    expect(moveSelection(0, 3, -1)).toBe(2)
  })

  it('clamps to 0 for an empty list', () => {
    expect(moveSelection(0, 0, 1)).toBe(0)
  })
})
