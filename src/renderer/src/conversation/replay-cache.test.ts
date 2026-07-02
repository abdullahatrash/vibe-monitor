import { describe, it, expect, vi } from 'vitest'
import { initialConversationState, type ConversationState } from './reducer'
import {
  createReplayCache,
  wireReplayCacheInvalidation,
  MAX_CACHED_THREADS,
  type CachedThreadView,
  type ReplayCacheSignals,
} from './replay-cache'

/**
 * The renderer-side folded-view cache: take-on-mount / put-on-unmount so a
 * Thread switch skips the full JSONL re-read + re-fold, invalidated over the
 * EXISTING channels when main tees to an unmounted Thread's transcript. Pure
 * module — no React, no preload; signals are driven by stubs.
 */

function view(overrides?: Partial<CachedThreadView>): CachedThreadView {
  return {
    state: initialConversationState,
    sessionId: 's1',
    workspaceId: 'w1',
    ...overrides,
  }
}

describe('createReplayCache take/put', () => {
  it('roundtrips a settled view, and take CONSUMES the entry (mount takes ownership)', () => {
    const cache = createReplayCache()
    const v = view()
    cache.put('t1', v)

    expect(cache.take('t1')).toBe(v)
    // Consumed: the mounted view owns the state now; a second mount must re-replay.
    expect(cache.take('t1')).toBeNull()
  })

  it('refuses a mid-turn (isProcessing) snapshot — stale by construction', () => {
    const cache = createReplayCache()
    const midTurn: ConversationState = { ...initialConversationState, isProcessing: true }
    cache.put('t1', view({ state: midTurn }))

    expect(cache.take('t1')).toBeNull()
  })

  it('LRU-evicts the least-recently-put past the cap; a re-put refreshes recency', () => {
    const cache = createReplayCache(2)
    cache.put('t1', view())
    cache.put('t2', view())
    cache.put('t1', view()) // refresh t1 — t2 is now the oldest
    cache.put('t3', view()) // over cap: evicts t2, not t1

    expect(cache.take('t2')).toBeNull()
    expect(cache.take('t1')).not.toBeNull()
    expect(cache.take('t3')).not.toBeNull()
  })

  it('defaults to MAX_CACHED_THREADS entries', () => {
    const cache = createReplayCache()
    for (let i = 0; i <= MAX_CACHED_THREADS; i++) cache.put(`t${i}`, view())

    expect(cache.take('t0')).toBeNull() // the one over the cap evicted the oldest
    expect(cache.take(`t${MAX_CACHED_THREADS}`)).not.toBeNull()
  })
})

describe('createReplayCache invalidation', () => {
  it('invalidate drops one Thread; clear drops everything', () => {
    const cache = createReplayCache()
    cache.put('t1', view())
    cache.put('t2', view())

    cache.invalidate('t1')
    expect(cache.take('t1')).toBeNull()
    expect(cache.take('t2')).not.toBeNull()

    cache.put('t3', view())
    cache.clear()
    expect(cache.take('t3')).toBeNull()
  })

  it('invalidateBySession drops only entries folded up to that session — null never matches', () => {
    const cache = createReplayCache()
    cache.put('t1', view({ sessionId: 's1' }))
    cache.put('t2', view({ sessionId: 's2' }))
    cache.put('t3', view({ sessionId: null })) // unbound draft / cold Thread

    cache.invalidateBySession('s1')
    expect(cache.take('t1')).toBeNull()
    expect(cache.take('t2')).not.toBeNull()
    expect(cache.take('t3')).not.toBeNull()
  })

  it('invalidateByWorkspace drops every entry under the removed Workspace', () => {
    const cache = createReplayCache()
    cache.put('t1', view({ workspaceId: 'w1' }))
    cache.put('t2', view({ workspaceId: 'w1' }))
    cache.put('t3', view({ workspaceId: 'w2' }))

    cache.invalidateByWorkspace('w1')
    expect(cache.take('t1')).toBeNull()
    expect(cache.take('t2')).toBeNull()
    expect(cache.take('t3')).not.toBeNull()
  })
})

describe('wireReplayCacheInvalidation', () => {
  /** Stub signals capturing the listeners so tests can fire events by hand. */
  function stubSignals(): {
    signals: ReplayCacheSignals
    fireEvent: (payload: unknown) => void
    fireTitle: (threadId: string) => void
    offEvent: ReturnType<typeof vi.fn>
    offTitle: ReturnType<typeof vi.fn>
  } {
    let eventListener: ((e: { agentId: string; payload: unknown }) => void) | null = null
    let titleListener: ((e: { threadId: string; title: string }) => void) | null = null
    const offEvent = vi.fn()
    const offTitle = vi.fn()
    return {
      signals: {
        onAcpEvent: (l) => {
          eventListener = l
          return offEvent
        },
        onThreadTitle: (l) => {
          titleListener = l
          return offTitle
        },
      },
      fireEvent: (payload) => eventListener?.({ agentId: 'a1', payload }),
      fireTitle: (threadId) => titleListener?.({ threadId, title: 'renamed' }),
      offEvent,
      offTitle,
    }
  }

  it('a session-tagged acp:event dirties the matching cached entry (background tee)', () => {
    const cache = createReplayCache()
    const { signals, fireEvent } = stubSignals()
    wireReplayCacheInvalidation(cache, signals)
    cache.put('t1', view({ sessionId: 's1' }))
    cache.put('t2', view({ sessionId: 's2' }))

    fireEvent({ method: 'session/update', params: { sessionId: 's1', update: {} } })

    expect(cache.take('t1')).toBeNull()
    expect(cache.take('t2')).not.toBeNull()
  })

  it('a session-less lifecycle payload touches nothing (cache ≡ replay for those)', () => {
    const cache = createReplayCache()
    const { signals, fireEvent } = stubSignals()
    wireReplayCacheInvalidation(cache, signals)
    cache.put('t1', view({ sessionId: 's1' }))

    fireEvent({ type: 'exit', code: 0 })

    expect(cache.take('t1')).not.toBeNull()
  })

  it('a thread:title push dirties the renamed Thread (cold store-only rename)', () => {
    const cache = createReplayCache()
    const { signals, fireTitle } = stubSignals()
    wireReplayCacheInvalidation(cache, signals)
    cache.put('t1', view())

    fireTitle('t1')

    expect(cache.take('t1')).toBeNull()
  })

  it('the returned disposer unsubscribes both signals', () => {
    const cache = createReplayCache()
    const { signals, offEvent, offTitle } = stubSignals()
    const dispose = wireReplayCacheInvalidation(cache, signals)

    dispose()

    expect(offEvent).toHaveBeenCalledOnce()
    expect(offTitle).toHaveBeenCalledOnce()
  })
})
