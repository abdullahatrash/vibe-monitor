import { describe, expect, it, vi } from 'vitest'
import { appendMention, emitComposerInsert, subscribeComposerInsert } from './composer-insert'

describe('appendMention', () => {
  it('inserts into an empty draft with a trailing space', () => {
    expect(appendMention('', 'src/app.ts')).toBe('@src/app.ts ')
  })

  it('adds a separating space when the draft does not end in whitespace', () => {
    expect(appendMention('see', 'src/app.ts')).toBe('see @src/app.ts ')
  })

  it('does not double the space when the draft already ends in whitespace', () => {
    expect(appendMention('see ', 'src/app.ts')).toBe('see @src/app.ts ')
    expect(appendMention('see\n', 'src/app.ts')).toBe('see\n@src/app.ts ')
  })
})

describe('composer-insert channel', () => {
  it('delivers an emit to the subscriber for that Thread only', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeComposerInsert('thread-a', a)
    const offB = subscribeComposerInsert('thread-b', b)
    emitComposerInsert('thread-a', 'src/app.ts')
    expect(a).toHaveBeenCalledWith('src/app.ts')
    expect(b).not.toHaveBeenCalled()
    offA()
    offB()
  })

  it('is a no-op when no composer is subscribed for the Thread', () => {
    expect(() => emitComposerInsert('nobody', 'x.ts')).not.toThrow()
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeComposerInsert('thread-a', listener)
    off()
    emitComposerInsert('thread-a', 'x.ts')
    expect(listener).not.toHaveBeenCalled()
  })
})
