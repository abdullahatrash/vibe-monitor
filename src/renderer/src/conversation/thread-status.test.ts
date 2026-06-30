import { describe, it, expect } from 'vitest'
import { clearThreadStatus, setThreadStatus, type ThreadStatusMap } from './thread-status'

/**
 * The renderer-side per-Thread status REGISTRY (TB3 #48, #53): App folds main's
 * `thread:status` pushes into this map (`streaming` / `needsAttention`, keyed by
 * threadId). The authoritative tracking lives in main (`thread-status.ts` there);
 * here we test only the render-loop-safe fold + the delete drop.
 */

describe('setThreadStatus (render-loop guard)', () => {
  it('adds a Thread status', () => {
    const next = setThreadStatus({}, 't1', { streaming: true, needsAttention: false })
    expect(next.t1).toEqual({ streaming: true, needsAttention: false })
  })

  it('returns the SAME map reference when the status is unchanged', () => {
    const map: ThreadStatusMap = { t1: { streaming: true, needsAttention: false } }
    expect(setThreadStatus(map, 't1', { streaming: true, needsAttention: false })).toBe(map)
  })

  it('returns a new map when a flag changes, leaving siblings untouched', () => {
    const map: ThreadStatusMap = {
      t1: { streaming: true, needsAttention: false },
      t2: { streaming: false, needsAttention: false },
    }
    const next = setThreadStatus(map, 't1', { streaming: false, needsAttention: true })
    expect(next).not.toBe(map)
    expect(next.t1).toEqual({ streaming: false, needsAttention: true })
    expect(next.t2).toBe(map.t2) // sibling reference preserved
  })
})

describe('clearThreadStatus (drop a deleted Thread)', () => {
  it('removes a Thread entry so it does not linger after delete', () => {
    const map: ThreadStatusMap = {
      t1: { streaming: true, needsAttention: false },
      t2: { streaming: false, needsAttention: true },
    }
    const next = clearThreadStatus(map, 't1')
    expect('t1' in next).toBe(false)
    expect(next.t2).toBe(map.t2) // sibling reference preserved
  })

  it('returns the SAME map reference when the Thread is absent', () => {
    const map: ThreadStatusMap = { t1: { streaming: false, needsAttention: false } }
    expect(clearThreadStatus(map, 'gone')).toBe(map)
  })
})
