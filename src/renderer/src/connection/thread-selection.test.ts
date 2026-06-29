import { describe, it, expect } from 'vitest'
import { routeThreadSelection } from './thread-selection'
import type { ThreadMeta } from '../../../shared/ipc'

/**
 * Switching between a Workspace's Threads (ADR-0005, TB5 #34). A Thread opened
 * or drafted in THIS session is hosted live on the running agent; one bound in a
 * PRIOR launch (its session lives on a now-dead process) replays read-only from
 * JSONL until TB4 adds `session/load`. Pure routing — no React, no IPC.
 */

function thread(id: string, sessionId: string | null): ThreadMeta {
  return { id, workspaceId: 'w1', sessionId, title: null, createdAt: 1, lastActiveAt: 1 }
}

describe('routeThreadSelection', () => {
  it('routes a Thread live when it is hosted on the current agent this session', () => {
    const live = new Set(['t-open', 't-draft'])
    // The auto-opened Thread (already bound this session) and a fresh draft.
    expect(routeThreadSelection(thread('t-open', 'sess-1'), live)).toBe('live')
    expect(routeThreadSelection(thread('t-draft', null), live)).toBe('live')
  })

  it('routes a prior-session Thread cold (read-only replay), even though it has a sessionId', () => {
    const live = new Set(['t-open'])
    // Bound in a previous launch; not hosted on the current agent.
    expect(routeThreadSelection(thread('t-old', 'sess-from-yesterday'), live)).toBe('cold')
  })

  it('routes a draft that is not (yet) tracked live as cold — membership is the source of truth', () => {
    expect(routeThreadSelection(thread('t-unknown', null), new Set())).toBe('cold')
  })
})
