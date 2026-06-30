import { describe, it, expect } from 'vitest'
import {
  initialWorkspaceThreads,
  workspaceThreadsReducer,
  workspaceThreadStateFor,
  type WorkspaceThreadsState,
} from './workspace-threads'

/**
 * Per-Workspace, per-session Thread state lifted out of ConnectedWorkspace (TB3
 * #48): the live set, bound sessions, and the active (kept-mounted) Thread, keyed
 * by Workspace so several warm Workspaces coexist. Pure reducer + derivation.
 */

describe('workspaceThreadsReducer', () => {
  it('connect seeds the live set + active with the auto-opened Thread', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
    })
    expect([...s.w1.live]).toEqual(['t-open'])
    expect(s.w1.bound).toEqual({ 't-open': 's1' })
    expect(s.w1.active).toBe('t-open')
  })

  it('connect with a null session seeds no bound entry (a continued/never-bound Thread)', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-cont',
      sessionId: null,
    })
    expect(s.w1.bound).toEqual({})
    expect([...s.w1.live]).toEqual(['t-cont'])
  })

  it('connect resets a reconnecting Workspace (new agent drops prior drafts)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w1', threadId: 't-new', sessionId: 's2' })
    expect([...s.w1.live]).toEqual(['t-new']) // 'draft' gone with the old agent
    expect(s.w1.active).toBe('t-new')
  })

  it('open hosts a new Thread live and makes it active', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    expect([...s.w1.live].sort()).toEqual(['draft', 't-open'])
    expect(s.w1.active).toBe('draft')
  })

  it('open on an unconnected Workspace is a no-op (no agent to host it)', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'open',
      workspaceId: 'w1',
      threadId: 'draft',
    })
    expect(s).toBe(initialWorkspaceThreads)
  })

  it('select changes the active Thread only (no live-set change)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'select', workspaceId: 'w1', threadId: 't-open' })
    expect(s.w1.active).toBe('t-open')
    expect([...s.w1.live].sort()).toEqual(['draft', 't-open'])
  })

  it('select to the same active Thread returns the same state reference', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
    })
    expect(workspaceThreadsReducer(s, { type: 'select', workspaceId: 'w1', threadId: 't-open' })).toBe(s)
  })

  it('bind records a session bound this session', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 'draft', sessionId: 'sD' })
    expect(s.w1.bound).toEqual({ draft: 'sD' })
  })

  it('bind with an unchanged session returns the same state reference', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
    })
    expect(workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 't-open', sessionId: 's1' })).toBe(s)
  })

  it('remove drops a live Thread + its bound session (delete teardown)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 'draft', sessionId: 'sD' })
    s = workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'draft' })
    expect([...s.w1.live]).toEqual(['t-open'])
    expect(s.w1.bound).toEqual({ 't-open': 's1' })
  })

  it('remove of a non-live Thread is a no-op', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
    })
    expect(workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'cold' })).toBe(s)
  })

  it('keeps Workspaces independent (one connect does not disturb another)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't1',
      sessionId: null,
    })
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w2', threadId: 't2', sessionId: null })
    expect(Object.keys(s).sort()).toEqual(['w1', 'w2'])
    expect(s.w1.active).toBe('t1')
  })
})

describe('workspaceThreadStateFor', () => {
  const state: WorkspaceThreadsState = {
    w1: { live: new Set(['t1']), bound: {}, active: 't1' },
  }
  it('returns a Workspace live-state', () => {
    expect(workspaceThreadStateFor(state, 'w1')?.active).toBe('t1')
  })
  it('returns null for an unconnected or unselected Workspace', () => {
    expect(workspaceThreadStateFor(state, 'w2')).toBeNull()
    expect(workspaceThreadStateFor(state, null)).toBeNull()
  })
})
