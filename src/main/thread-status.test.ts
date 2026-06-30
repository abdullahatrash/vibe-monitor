import { describe, it, expect } from 'vitest'
import { permissionRequestIdOf, ThreadStatusTracker } from './thread-status'

/**
 * Per-Thread status tracked in MAIN (#53, option 2): main owns the authoritative
 * turn + permission lifecycle, so it — not a mounted renderer Conversation — is the
 * single source of truth for the sidebar's `streaming` / `needsAttention`
 * indicators, even for NON-active live Threads. The tracker is the pure core: each
 * mutation returns the affected Thread's NEW status only when it actually changed
 * (so main pushes nothing redundant), and every terminal transition — turn end,
 * permission answered, agent evicted — clears the flag so none can leak.
 */

describe('ThreadStatusTracker — streaming (a turn in flight)', () => {
  it('sets streaming on the first turn and reports the change', () => {
    const t = new ThreadStatusTracker()
    expect(t.beginTurn('a1', 't1')).toEqual({ threadId: 't1', streaming: true, needsAttention: false })
    expect(t.statusFor('t1')).toEqual({ streaming: true, needsAttention: false })
  })

  it('reports NO change for an overlapping second turn on the same Thread', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    expect(t.beginTurn('a1', 't1')).toBeNull() // already streaming
  })

  it('keeps streaming until the LAST overlapping turn ends (count, not flag)', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.beginTurn('a1', 't1')
    expect(t.endTurn('a1', 't1')).toBeNull() // still one turn open
    expect(t.statusFor('t1').streaming).toBe(true)
    expect(t.endTurn('a1', 't1')).toEqual({ threadId: 't1', streaming: false, needsAttention: false })
    expect(t.statusFor('t1').streaming).toBe(false)
  })

  it('ignores an endTurn for a Thread that was never streaming', () => {
    const t = new ThreadStatusTracker()
    expect(t.endTurn('a1', 't1')).toBeNull()
  })
})

describe('ThreadStatusTracker — needsAttention (a pending permission)', () => {
  it('sets needsAttention when a permission request is outstanding', () => {
    const t = new ThreadStatusTracker()
    expect(t.addPermission('a1', 't1', 7)).toEqual({ threadId: 't1', streaming: false, needsAttention: true })
    expect(t.statusFor('t1').needsAttention).toBe(true)
  })

  it('clears needsAttention when the permission is answered', () => {
    const t = new ThreadStatusTracker()
    t.addPermission('a1', 't1', 7)
    expect(t.resolvePermission('a1', 7)).toEqual({ threadId: 't1', streaming: false, needsAttention: false })
    expect(t.statusFor('t1').needsAttention).toBe(false)
  })

  it('stays in attention until EVERY outstanding permission is answered', () => {
    const t = new ThreadStatusTracker()
    t.addPermission('a1', 't1', 7)
    expect(t.addPermission('a1', 't1', 8)).toBeNull() // already in attention — no change
    expect(t.resolvePermission('a1', 7)).toBeNull() // still one pending
    expect(t.statusFor('t1').needsAttention).toBe(true)
    expect(t.resolvePermission('a1', 8)).toEqual({ threadId: 't1', streaming: false, needsAttention: false })
  })

  it('ignores a duplicate request id and an answer for an unknown request', () => {
    const t = new ThreadStatusTracker()
    t.addPermission('a1', 't1', 7)
    expect(t.addPermission('a1', 't1', 7)).toBeNull() // duplicate request — no double count
    t.resolvePermission('a1', 7)
    expect(t.resolvePermission('a1', 7)).toBeNull() // already resolved
    expect(t.resolvePermission('a1', 999)).toBeNull() // never seen
  })

  it('keys a request by agent so same-numbered ids on two agents do not collide', () => {
    const t = new ThreadStatusTracker()
    t.addPermission('a1', 't1', 1)
    t.addPermission('a2', 't2', 1)
    t.resolvePermission('a1', 1)
    expect(t.statusFor('t1').needsAttention).toBe(false)
    expect(t.statusFor('t2').needsAttention).toBe(true) // a2's request untouched
  })
})

describe('ThreadStatusTracker — flags are independent', () => {
  it('clears streaming on turn end while a still-pending permission keeps attention', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.addPermission('a1', 't1', 7)
    expect(t.endTurn('a1', 't1')).toEqual({ threadId: 't1', streaming: false, needsAttention: true })
    expect(t.statusFor('t1')).toEqual({ streaming: false, needsAttention: true })
  })
})

describe('ThreadStatusTracker — clearThread (turn-end safety net)', () => {
  it('drops a Thread lingering pending permission and reports the change', () => {
    const t = new ThreadStatusTracker()
    t.addPermission('a1', 't1', 7)
    expect(t.clearThread('t1')).toEqual({ threadId: 't1', streaming: false, needsAttention: false })
    expect(t.statusFor('t1').needsAttention).toBe(false)
    // The orphaned request id is gone, so a late answer is a no-op (no resurrection).
    expect(t.resolvePermission('a1', 7)).toBeNull()
  })

  it('reports no change when a Thread had nothing pending', () => {
    const t = new ThreadStatusTracker()
    expect(t.clearThread('t1')).toBeNull()
  })
})

describe('ThreadStatusTracker — evictAgent (no leaks on stop/evict)', () => {
  it('clears streaming AND pending for the evicted agent only, reporting each change', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.addPermission('a1', 't1', 7)
    t.beginTurn('a2', 't2') // a different agent — must survive
    const changes = t.evictAgent('a1')
    expect(changes).toEqual([{ threadId: 't1', streaming: false, needsAttention: false }])
    expect(t.statusFor('t1')).toEqual({ streaming: false, needsAttention: false })
    expect(t.statusFor('t2').streaming).toBe(true) // untouched
  })

  it('returns no changes for an agent with nothing tracked', () => {
    const t = new ThreadStatusTracker()
    expect(t.evictAgent('ghost')).toEqual([])
  })

  it('reports one change per affected Thread', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.addPermission('a1', 't2', 5)
    const changes = t.evictAgent('a1')
    expect(changes).toHaveLength(2)
    expect(changes.map((c) => c.threadId).sort()).toEqual(['t1', 't2'])
  })
})

describe('ThreadStatusTracker — statusFor (the main-side delete-streaming guard)', () => {
  it('reports streaming for a Thread mid-turn and idle once it ends', () => {
    // The `deleteThread` handler refuses a delete while `statusFor(id).streaming` is
    // true (#53), so a click-race can't tear down a mid-turn session; once the turn
    // ends the Thread is idle and deletes cleanly.
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    expect(t.statusFor('t1').streaming).toBe(true) // delete refused
    t.endTurn('a1', 't1')
    expect(t.statusFor('t1').streaming).toBe(false) // delete allowed
  })

  it('reports a never-touched (genuinely idle live) Thread as not streaming', () => {
    expect(new ThreadStatusTracker().statusFor('t1').streaming).toBe(false)
  })
})

describe('ThreadStatusTracker — snapshot (mount re-seed)', () => {
  it('returns only the Threads with a non-default status', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.addPermission('a1', 't2', 7)
    t.beginTurn('a1', 't3')
    t.endTurn('a1', 't3') // t3 back to idle — must be omitted
    expect(t.snapshot().sort((x, y) => x.threadId.localeCompare(y.threadId))).toEqual([
      { threadId: 't1', streaming: true, needsAttention: false },
      { threadId: 't2', streaming: false, needsAttention: true },
    ])
  })

  it('is empty when nothing is in flight', () => {
    expect(new ThreadStatusTracker().snapshot()).toEqual([])
  })

  it('reports a Thread that is BOTH streaming and pending once', () => {
    const t = new ThreadStatusTracker()
    t.beginTurn('a1', 't1')
    t.addPermission('a1', 't1', 7)
    expect(t.snapshot()).toEqual([{ threadId: 't1', streaming: true, needsAttention: true }])
  })
})

describe('permissionRequestIdOf', () => {
  it('extracts the request id of a session/request_permission server request', () => {
    expect(
      permissionRequestIdOf({ id: 42, method: 'session/request_permission', params: { sessionId: 's1' } }),
    ).toBe(42)
  })

  it('accepts a request id of 0 (the realistic first JSON-RPC id, acp-capture §6)', () => {
    // `0` is falsy but a valid id — the probe must key off `id !== undefined`, not
    // truthiness, or the first permission of a session would never raise attention.
    expect(
      permissionRequestIdOf({ id: 0, method: 'session/request_permission', params: { sessionId: 's1' } }),
    ).toBe(0)
  })

  it('returns null for a notification (no id) or any other method', () => {
    expect(permissionRequestIdOf({ method: 'session/request_permission' })).toBeNull() // no id
    expect(permissionRequestIdOf({ id: 1, method: 'session/update', params: {} })).toBeNull()
    expect(permissionRequestIdOf({ type: 'exit' })).toBeNull()
    expect(permissionRequestIdOf(null)).toBeNull()
  })
})
