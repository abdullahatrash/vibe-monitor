import { describe, expect, it } from 'vitest'
import { TranscriptBridge, type TranscriptSink } from './transcript-bridge'
import type { TranscriptEntry } from './transcript'

const ENTRY = { kind: 'turn-complete' } as unknown as TranscriptEntry

function recordingSink(): { sink: TranscriptSink; appended: Array<{ threadId: string }> } {
  const appended: Array<{ threadId: string }> = []
  return {
    appended,
    sink: {
      append: (threadId) => {
        appended.push({ threadId })
        return Promise.resolve()
      },
    },
  }
}

function bridge(overrides?: {
  sink?: TranscriptSink | null
  resolveBySession?: (sessionId: string | null) => string | null
}): TranscriptBridge {
  return new TranscriptBridge({
    sink: overrides?.sink ?? null,
    resolveBySession: overrides?.resolveBySession ?? (() => null),
  })
}

describe('TranscriptBridge.threadIdFor', () => {
  it('prefers the sessionId route over the agent map (a late sibling event routes to ITS Thread)', () => {
    const b = bridge({ resolveBySession: (sid) => (sid === 's1' ? 't-by-session' : null) })
    b.bind('agent1', 't-by-map')
    expect(b.threadIdFor('agent1', 's1')).toBe('t-by-session')
  })

  it('falls back to the agent map when the session is unknown', () => {
    const b = bridge()
    b.bind('agent1', 't-by-map')
    expect(b.threadIdFor('agent1', 'unknown')).toBe('t-by-map')
    expect(b.threadIdFor('agent1')).toBe('t-by-map')
  })

  it('returns null when neither route resolves (tee is skipped)', () => {
    expect(bridge().threadIdFor('agent1', null)).toBeNull()
  })

  it('bind is last-write-wins; evictAgent drops the entry', () => {
    const b = bridge()
    b.bind('agent1', 't1')
    b.bind('agent1', 't2')
    expect(b.threadIdFor('agent1')).toBe('t2')
    b.evictAgent('agent1')
    expect(b.threadIdFor('agent1')).toBeNull()
  })

  it('clearThread removes every agent entry pointing at that Thread', () => {
    const b = bridge()
    b.bind('agent1', 't1')
    b.bind('agent2', 't1')
    b.bind('agent3', 'other')
    b.clearThread('t1')
    expect(b.threadIdFor('agent1')).toBeNull()
    expect(b.threadIdFor('agent2')).toBeNull()
    expect(b.threadIdFor('agent3')).toBe('other')
  })
})

describe('TranscriptBridge.tee', () => {
  it('appends to the sink for a routable Thread', () => {
    const { sink, appended } = recordingSink()
    bridge({ sink }).tee('t1', ENTRY)
    expect(appended).toEqual([{ threadId: 't1' }])
  })

  it('skips a null threadId and a null sink without throwing', () => {
    const { sink, appended } = recordingSink()
    bridge({ sink }).tee(null, ENTRY)
    expect(appended).toEqual([])
    expect(() => bridge({ sink: null }).tee('t1', ENTRY)).not.toThrow()
  })

  it('suppresses every tee to a tombstoned Thread (mid-turn Remove project)', () => {
    const { sink, appended } = recordingSink()
    const b = bridge({ sink })
    b.tombstone('t1')
    b.tee('t1', ENTRY)
    expect(appended).toEqual([])
    b.tee('t2', ENTRY) // other Threads unaffected
    expect(appended).toEqual([{ threadId: 't2' }])
  })

  it('exposes the tombstone via isTombstoned so sibling persistence can skip alongside', () => {
    const b = bridge()
    expect(b.isTombstoned('t1')).toBe(false)
    b.tombstone('t1')
    expect(b.isTombstoned('t1')).toBe(true)
    expect(b.isTombstoned('t2')).toBe(false)
  })
})
