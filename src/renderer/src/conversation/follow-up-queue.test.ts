import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetQueueStore,
  beginSend,
  dequeueHead,
  dequeueThreadHead,
  endSend,
  enqueue,
  enqueueMessage,
  getThreadQueue,
  isSending,
  nextQueueId,
  peekHead,
  removeById,
  removeQueued,
  subscribe,
  type QueueMap,
  type QueuedMessage,
} from './follow-up-queue'

/**
 * Follow-up queue (#105): the load-bearing core is the PURE immutable ops over a
 * `Record<threadId, QueuedMessage[]>` — append, dequeue-head-with-prune, remove,
 * peek, multi-thread isolation, no input mutation — plus the module store's
 * stable-reference snapshot contract that keeps `useSyncExternalStore` from looping.
 */

function msg(id: string, text = id): QueuedMessage {
  return { id, text, images: [] }
}

describe('pure ops', () => {
  it('enqueue appends without mutating the input map or array', () => {
    const a = msg('a')
    const b = msg('b')
    const m0: QueueMap = {}
    const m1 = enqueue(m0, 't1', a)
    const m2 = enqueue(m1, 't1', b)
    expect(m0).toEqual({})
    expect(m1['t1']).toEqual([a])
    expect(m1['t1']).not.toBe(m2['t1'])
    expect(m2['t1']).toEqual([a, b])
  })

  it('dequeueHead returns + removes the head, keeping the tail', () => {
    const m = enqueue(enqueue({}, 't1', msg('a')), 't1', msg('b'))
    const { map, head } = dequeueHead(m, 't1')
    expect(head).toEqual(msg('a'))
    expect(map['t1']).toEqual([msg('b')])
    // input untouched
    expect(m['t1']).toHaveLength(2)
  })

  it('dequeueHead prunes the per-thread key when the queue empties', () => {
    const m = enqueue({}, 't1', msg('only'))
    const { map, head } = dequeueHead(m, 't1')
    expect(head).toEqual(msg('only'))
    expect('t1' in map).toBe(false)
  })

  it('dequeueHead on an empty thread returns the same map + null head', () => {
    const m: QueueMap = {}
    const { map, head } = dequeueHead(m, 'missing')
    expect(head).toBeNull()
    expect(map).toBe(m)
  })

  it('removeById drops the matching message and prunes when emptied', () => {
    const m = enqueue(enqueue({}, 't1', msg('a')), 't1', msg('b'))
    const afterB = removeById(m, 't1', 'b')
    expect(afterB['t1']).toEqual([msg('a')])
    const afterA = removeById(afterB, 't1', 'a')
    expect('t1' in afterA).toBe(false)
  })

  it('removeById is a no-op (same reference) when the id is absent', () => {
    const m = enqueue({}, 't1', msg('a'))
    expect(removeById(m, 't1', 'nope')).toBe(m)
    expect(removeById(m, 'other', 'a')).toBe(m)
  })

  it('peekHead returns the head or null without removing it', () => {
    expect(peekHead({}, 't1')).toBeNull()
    const m = enqueue(enqueue({}, 't1', msg('a')), 't1', msg('b'))
    expect(peekHead(m, 't1')).toEqual(msg('a'))
    expect(m['t1']).toHaveLength(2)
  })

  it('keeps threads isolated', () => {
    const m = enqueue(enqueue({}, 't1', msg('a')), 't2', msg('x'))
    const { map } = dequeueHead(m, 't1')
    expect('t1' in map).toBe(false)
    expect(map['t2']).toEqual([msg('x')])
  })
})

describe('store', () => {
  afterEach(() => _resetQueueStore())

  it('nextQueueId mints unique incrementing ids', () => {
    expect(nextQueueId()).not.toBe(nextQueueId())
  })

  it('enqueueMessage makes getThreadQueue reflect the append + notifies', () => {
    let notified = 0
    const unsub = subscribe(() => notified++)
    enqueueMessage('t1', msg('a'))
    expect(getThreadQueue('t1')).toEqual([msg('a')])
    expect(notified).toBe(1)
    unsub()
  })

  it('getThreadQueue keeps a STABLE reference until that thread changes', () => {
    const empty1 = getThreadQueue('t1')
    // Same shared empty across calls and across an UNRELATED thread's change.
    expect(getThreadQueue('t1')).toBe(empty1)
    enqueueMessage('t2', msg('x'))
    expect(getThreadQueue('t1')).toBe(empty1)
    const snap = getThreadQueue('t2')
    expect(getThreadQueue('t2')).toBe(snap)
    // A change to t2 mints a new reference for t2 only.
    enqueueMessage('t2', msg('y'))
    expect(getThreadQueue('t2')).not.toBe(snap)
  })

  it('dequeueThreadHead removes the head and notifies; empty is a silent null', () => {
    let notified = 0
    const unsub = subscribe(() => notified++)
    enqueueMessage('t1', msg('a'))
    enqueueMessage('t1', msg('b'))
    notified = 0
    expect(dequeueThreadHead('t1')).toEqual(msg('a'))
    expect(getThreadQueue('t1')).toEqual([msg('b')])
    expect(notified).toBe(1)
    // Drain the rest, then an empty dequeue must NOT notify.
    dequeueThreadHead('t1')
    notified = 0
    expect(dequeueThreadHead('t1')).toBeNull()
    expect(notified).toBe(0)
    unsub()
  })

  it('removeQueued drops a message + notifies; absent is silent', () => {
    let notified = 0
    const unsub = subscribe(() => notified++)
    enqueueMessage('t1', msg('a'))
    notified = 0
    removeQueued('t1', 'a')
    expect(getThreadQueue('t1')).toEqual([])
    expect(notified).toBe(1)
    removeQueued('t1', 'gone')
    expect(notified).toBe(1)
    unsub()
  })

  it('sending latch is per-Thread, idempotent, and notifies on real transitions', () => {
    let notified = 0
    const unsub = subscribe(() => notified++)
    expect(isSending('t1')).toBe(false)
    beginSend('t1')
    expect(isSending('t1')).toBe(true)
    expect(isSending('t2')).toBe(false) // isolated per Thread
    expect(notified).toBe(1)
    beginSend('t1') // already set — no-op, no notify
    expect(notified).toBe(1)
    endSend('t1')
    expect(isSending('t1')).toBe(false)
    expect(notified).toBe(2)
    endSend('t1') // already clear — no-op, no notify
    expect(notified).toBe(2)
    unsub()
  })

  it('_resetQueueStore clears the sending latch too', () => {
    beginSend('t1')
    expect(isSending('t1')).toBe(true)
    _resetQueueStore()
    expect(isSending('t1')).toBe(false)
  })
})
