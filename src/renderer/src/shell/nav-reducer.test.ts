import { describe, it, expect } from 'vitest'
import { findSelectedThread, initialNavState, navReducer, type NavState } from './nav-reducer'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'

/**
 * Shell navigation (ADR-0006 decision 2). A pure reducer holding WHICH Workspace
 * and Thread the user is looking at — decoupled from connection lifecycle and
 * mirroring conversation/reducer.ts (no React, no IPC, no router). The invariant
 * under test: a selected Thread always belongs to the selected Workspace.
 */

function thread(id: string, workspaceId: string): ThreadMeta {
  return { id, workspaceId, sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 }
}

describe('navReducer', () => {
  it('starts with nothing selected', () => {
    expect(initialNavState).toEqual({ selectedWorkspaceId: null, selectedThreadId: null })
  })

  it('select-thread pins both the Thread and its Workspace', () => {
    const next = navReducer(initialNavState, { type: 'select-thread', workspaceId: 'w1', threadId: 't1' })
    expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't1' })
  })

  it('switching to a different Workspace drops the now-foreign Thread selection', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1' }
    const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w2' })
    expect(next).toEqual({ selectedWorkspaceId: 'w2', selectedThreadId: null })
  })

  it('re-selecting the same Workspace is a no-op (keeps the Thread selection)', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1' }
    const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w1' })
    expect(next).toBe(start) // same reference: no spurious re-render or cleared Thread
  })

  it('clear resets to nothing selected', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1' }
    expect(navReducer(start, { type: 'clear' })).toEqual(initialNavState)
  })
})

describe('findSelectedThread (cold-outlet derivation)', () => {
  const workspaces: ListMetadataResult = [
    { id: 'w1', dir: '/a', displayName: 'A', lastOpenedAt: 2, threads: [thread('t1', 'w1'), thread('t2', 'w1')] },
    { id: 'w2', dir: '/b', displayName: 'B', lastOpenedAt: 1, threads: [thread('t3', 'w2')] },
  ]

  it('resolves the selected Thread to its cold metadata', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't2' }
    expect(findSelectedThread(workspaces, state)?.id).toBe('t2')
  })

  it('returns null when no Thread is selected', () => {
    expect(findSelectedThread(workspaces, { selectedWorkspaceId: 'w1', selectedThreadId: null })).toBeNull()
  })

  it('returns null when the selected Thread no longer exists (e.g. after a delete refreshed the list)', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 'gone' }
    expect(findSelectedThread(workspaces, state)).toBeNull()
  })

  it('scopes the lookup to the selected Workspace (a Thread id under another Workspace is not matched)', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't3' }
    expect(findSelectedThread(workspaces, state)).toBeNull()
  })
})
