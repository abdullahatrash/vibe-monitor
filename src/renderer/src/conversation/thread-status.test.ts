import { describe, it, expect } from 'vitest'
import { clearThreadStatus, deriveThreadStatus, setThreadStatus, type ThreadStatusMap } from './thread-status'
import type { ConversationItem, PermissionItem } from './reducer'

/**
 * Per-Thread status surfaced from a live Conversation to the unified sidebar
 * (TB3 #48): `streaming` (turn in flight) and `needsAttention` (a pending
 * permission). Pure derivation + a render-loop-safe registry fold.
 */

function permission(chosenOptionId: string | null): PermissionItem {
  return {
    kind: 'permission',
    id: 'p1',
    requestId: 7,
    toolCallId: null,
    options: [],
    chosenOptionId,
    chosenName: chosenOptionId ? 'Allow' : null,
  }
}

const assistant: ConversationItem = { kind: 'assistant', id: 'a1', messageId: 'm1', text: 'hi' }

describe('deriveThreadStatus', () => {
  it('reports streaming while a turn is in flight', () => {
    expect(deriveThreadStatus({ isProcessing: true, items: [] })).toEqual({
      streaming: true,
      needsAttention: false,
    })
  })

  it('reports idle when no turn is in flight and no permission pending', () => {
    expect(deriveThreadStatus({ isProcessing: false, items: [assistant] })).toEqual({
      streaming: false,
      needsAttention: false,
    })
  })

  it('reports needsAttention while a permission request is unanswered', () => {
    expect(
      deriveThreadStatus({ isProcessing: true, items: [permission(null)] }).needsAttention,
    ).toBe(true)
  })

  it('drops needsAttention once the permission has been answered', () => {
    expect(
      deriveThreadStatus({ isProcessing: false, items: [permission('opt-allow')] }).needsAttention,
    ).toBe(false)
  })
})

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
