import { describe, it, expect } from 'vitest'
import { deriveUnifiedThreads, isThreadDeletable, workspaceFlags, type UnifiedThreadRow } from './unified-threads'
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

describe('isThreadDeletable (safe-delete gate)', () => {
  function row(id: string, opts: Partial<UnifiedThreadRow> = {}): UnifiedThreadRow {
    return { thread: thread(id), live: false, streaming: false, needsAttention: false, ...opts }
  }

  it('allows deleting a cold row (no live session to tear out from under)', () => {
    expect(isThreadDeletable(row('c'), 'active', 'primary')).toBe(true)
    // Even if it happens to be the active selection (a cold row being replayed).
    expect(isThreadDeletable(row('c'), 'c', 'primary')).toBe(true)
  })

  it('never allows deleting the connection primary Thread mid-connection', () => {
    expect(isThreadDeletable(row('primary', { live: true }), 'primary', 'primary')).toBe(false)
  })

  it('allows deleting the active, idle, non-primary live row', () => {
    expect(isThreadDeletable(row('a', { live: true }), 'a', 'primary')).toBe(true)
  })

  it('forbids deleting the active live row while it is streaming', () => {
    expect(isThreadDeletable(row('a', { live: true, streaming: true }), 'a', 'primary')).toBe(false)
  })

  it('forbids deleting a NON-active live row (its turn is unobservable; #53)', () => {
    // A backgrounded live sibling reports streaming:false because it is unmounted —
    // we cannot prove it idle, so it must not be deletable (the TB1 hazard).
    expect(isThreadDeletable(row('b', { live: true, streaming: false }), 'a', 'primary')).toBe(false)
  })

  it('treats every live row as non-active when there is no active/primary (defensive)', () => {
    expect(isThreadDeletable(row('a', { live: true }), null, null)).toBe(false)
    expect(isThreadDeletable(row('c'), null, null)).toBe(true) // cold still deletable
  })
})
