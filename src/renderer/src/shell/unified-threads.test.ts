import { describe, it, expect } from 'vitest'
import {
  deriveUnifiedThreads,
  isThreadDeletable,
  orderByPin,
  partitionArchived,
  workspaceFlags,
  type UnifiedThreadRow,
} from './unified-threads'
import type { ThreadStatusMap } from '../conversation/thread-status'
import type { ThreadMeta } from '../../../shared/ipc'

/**
 * The unified cold+live Thread list (ADR-0006, TB3 #48): a Workspace's persisted
 * Threads and its live (this-session) Threads merged into ONE deduped,
 * most-recent-first list with per-row live/streaming/needsAttention flags. Pure —
 * no React, no IPC. This replaces the TB1 cold-only sidebar AND the TB2
 * `ConnectedWorkspace` internal switcher (single source of truth).
 */

function thread(id: string, sessionId: string | null = null): ThreadMeta {
  return { id, workspaceId: 'w1', sessionId, title: id, createdAt: 1, lastActiveAt: 1 }
}

const noStatus: ThreadStatusMap = {}

describe('deriveUnifiedThreads', () => {
  it('lists cold Threads in order with live=false when nothing is hosted', () => {
    const cold = [thread('a'), thread('b')]
    const rows = deriveUnifiedThreads({ cold, live: [], liveThreadIds: new Set(), statuses: noStatus })
    expect(rows.map((r) => r.thread.id)).toEqual(['a', 'b'])
    expect(rows.every((r) => !r.live)).toBe(true)
  })

  it('flags a cold Thread that is also hosted live (no duplicate row)', () => {
    const cold = [thread('a', 's-a'), thread('b')]
    const rows = deriveUnifiedThreads({
      cold,
      live: [thread('a', 's-a')],
      liveThreadIds: new Set(['a']),
      statuses: noStatus,
    })
    expect(rows.map((r) => r.thread.id)).toEqual(['a', 'b']) // deduped — 'a' once
    expect(rows.find((r) => r.thread.id === 'a')?.live).toBe(true)
    expect(rows.find((r) => r.thread.id === 'b')?.live).toBe(false)
  })

  it('prepends a live-only Thread (a fresh draft not yet persisted) as the newest', () => {
    const cold = [thread('a'), thread('b')]
    const draft = thread('draft', null)
    const rows = deriveUnifiedThreads({
      cold,
      live: [draft],
      liveThreadIds: new Set(['draft']),
      statuses: noStatus,
    })
    expect(rows.map((r) => r.thread.id)).toEqual(['draft', 'a', 'b'])
    expect(rows[0].live).toBe(true)
  })

  it('dedupes a live Thread that appears twice in the live input', () => {
    const rows = deriveUnifiedThreads({
      cold: [],
      live: [thread('x'), thread('x')],
      liveThreadIds: new Set(['x']),
      statuses: noStatus,
    })
    expect(rows.map((r) => r.thread.id)).toEqual(['x'])
  })

  it('surfaces streaming + needsAttention per row from the status registry', () => {
    const cold = [thread('a'), thread('b'), thread('c')]
    const statuses: ThreadStatusMap = {
      a: { streaming: true, needsAttention: false },
      b: { streaming: false, needsAttention: true },
    }
    const rows = deriveUnifiedThreads({
      cold,
      live: [],
      liveThreadIds: new Set(['a', 'b', 'c']),
      statuses,
    })
    expect(rows.find((r) => r.thread.id === 'a')).toMatchObject({ streaming: true, needsAttention: false })
    expect(rows.find((r) => r.thread.id === 'b')).toMatchObject({ streaming: false, needsAttention: true })
    // No status entry => both flags default false.
    expect(rows.find((r) => r.thread.id === 'c')).toMatchObject({ streaming: false, needsAttention: false })
  })

  it('uses the persisted cold meta (fresher title) for a Thread present in both', () => {
    const coldMeta = { ...thread('a'), title: 'Renamed' }
    const liveMeta = { ...thread('a'), title: null }
    const rows = deriveUnifiedThreads({
      cold: [coldMeta],
      live: [liveMeta],
      liveThreadIds: new Set(['a']),
      statuses: noStatus,
    })
    expect(rows[0].thread.title).toBe('Renamed')
  })
})

describe('workspaceFlags (background Workspace roll-up)', () => {
  it('is clear when no live Thread has a status', () => {
    expect(workspaceFlags(new Set(['a', 'b']), {})).toEqual({ streaming: false, needsAttention: false })
  })

  it('rolls up streaming/needsAttention across a Workspace live Threads', () => {
    const statuses: ThreadStatusMap = {
      a: { streaming: false, needsAttention: true }, // a hidden Workspace blocked on a prompt
      b: { streaming: true, needsAttention: false },
    }
    expect(workspaceFlags(new Set(['a', 'b']), statuses)).toEqual({ streaming: true, needsAttention: true })
  })

  it('ignores statuses of Threads not in this Workspace live set', () => {
    const statuses: ThreadStatusMap = { other: { streaming: true, needsAttention: true } }
    expect(workspaceFlags(new Set(['a']), statuses)).toEqual({ streaming: false, needsAttention: false })
  })
})

describe('orderByPin (#132 pinned-first, stable)', () => {
  function row(id: string, pinned?: boolean): UnifiedThreadRow {
    return {
      thread: { ...thread(id), pinned },
      live: false,
      streaming: false,
      needsAttention: false,
    }
  }

  it('returns the same order when nothing is pinned', () => {
    const rows = [row('a'), row('b'), row('c')]
    expect(orderByPin(rows).map((r) => r.thread.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps order when every row is pinned', () => {
    const rows = [row('a', true), row('b', true), row('c', true)]
    expect(orderByPin(rows).map((r) => r.thread.id)).toEqual(['a', 'b', 'c'])
  })

  it('floats pinned rows to the top, preserving each group order (stable)', () => {
    // Incoming most-recent-first: a, b(pin), c, d(pin), e. Pinned keep b,d order;
    // rest keep a,c,e order — appended after.
    const rows = [row('a'), row('b', true), row('c'), row('d', true), row('e')]
    expect(orderByPin(rows).map((r) => r.thread.id)).toEqual(['b', 'd', 'a', 'c', 'e'])
  })

  it('does not mutate its input', () => {
    const rows = [row('a'), row('b', true)]
    const snapshot = rows.map((r) => r.thread.id)
    orderByPin(rows)
    expect(rows.map((r) => r.thread.id)).toEqual(snapshot)
  })

  it('handles an empty list', () => {
    expect(orderByPin([])).toEqual([])
  })
})

describe('partitionArchived (#133 split, order-preserving)', () => {
  function row(id: string, archived?: boolean): UnifiedThreadRow {
    return {
      thread: { ...thread(id), archived },
      live: false,
      streaming: false,
      needsAttention: false,
    }
  }

  it('puts everything in active when nothing is archived', () => {
    const { active, archived } = partitionArchived([row('a'), row('b')])
    expect(active.map((r) => r.thread.id)).toEqual(['a', 'b'])
    expect(archived).toEqual([])
  })

  it('splits archived out, preserving both groups order', () => {
    const rows = [row('a'), row('b', true), row('c'), row('d', true)]
    const { active, archived } = partitionArchived(rows)
    expect(active.map((r) => r.thread.id)).toEqual(['a', 'c'])
    expect(archived.map((r) => r.thread.id)).toEqual(['b', 'd'])
  })

  it('puts everything in archived when all are archived', () => {
    const { active, archived } = partitionArchived([row('a', true), row('b', true)])
    expect(active).toEqual([])
    expect(archived.map((r) => r.thread.id)).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const rows = [row('a'), row('b', true)]
    const snapshot = rows.map((r) => r.thread.id)
    partitionArchived(rows)
    expect(rows.map((r) => r.thread.id)).toEqual(snapshot)
  })

  it('handles an empty list', () => {
    expect(partitionArchived([])).toEqual({ active: [], archived: [] })
  })
})

describe('isThreadDeletable (safe-delete gate)', () => {
  function row(id: string, opts: Partial<UnifiedThreadRow> = {}): UnifiedThreadRow {
    return { thread: thread(id), live: false, streaming: false, needsAttention: false, ...opts }
  }

  it('allows deleting a cold row (no live session to tear out from under)', () => {
    expect(isThreadDeletable(row('c'), 'primary')).toBe(true)
  })

  it('never allows deleting the connection primary Thread mid-connection', () => {
    expect(isThreadDeletable(row('primary', { live: true }), 'primary')).toBe(false)
    // Even while idle — the primary is the connection's always-live Thread.
    expect(isThreadDeletable(row('primary', { live: true, streaming: false }), 'primary')).toBe(false)
  })

  it('allows deleting an idle non-primary live row (#53: streaming is now observable)', () => {
    expect(isThreadDeletable(row('a', { live: true, streaming: false }), 'primary')).toBe(true)
  })

  it('forbids deleting a live row while it is streaming', () => {
    expect(isThreadDeletable(row('a', { live: true, streaming: true }), 'primary')).toBe(false)
  })

  it('allows deleting an idle NON-active live sibling (#53 relaxation)', () => {
    // A backgrounded live sibling now carries its REAL per-Thread streaming via
    // main's push, so an idle one is deletable without being the active/mounted row.
    expect(isThreadDeletable(row('b', { live: true, streaming: false }), 'primary')).toBe(true)
    // ...but a streaming non-active sibling is still protected.
    expect(isThreadDeletable(row('b', { live: true, streaming: true }), 'primary')).toBe(false)
  })

  it('keeps cold rows deletable when there is no live connection', () => {
    expect(isThreadDeletable(row('c'), null)).toBe(true)
  })
})
