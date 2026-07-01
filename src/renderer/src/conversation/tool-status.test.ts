import { describe, it, expect } from 'vitest'
import { describeToolStatus } from './tool-status'

/**
 * ToolRow status mapping (#115): OUR ACP tool `status` string → the four display
 * buckets + trailing glyph. Pure/DOM-free — exercised as data.
 */
describe('describeToolStatus', () => {
  it('maps completed → done/check', () => {
    expect(describeToolStatus('completed')).toEqual({ state: 'done', glyph: 'check' })
  })

  it('maps failed → failed/x', () => {
    expect(describeToolStatus('failed')).toEqual({ state: 'failed', glyph: 'x' })
  })

  it('maps in_progress → running/spinner (live, no terminal check)', () => {
    expect(describeToolStatus('in_progress')).toEqual({ state: 'running', glyph: 'spinner' })
  })

  it('maps pending → pending/spinner', () => {
    expect(describeToolStatus('pending')).toEqual({ state: 'pending', glyph: 'spinner' })
  })

  it('defaults an unknown status to pending/spinner', () => {
    expect(describeToolStatus('weird-status')).toEqual({ state: 'pending', glyph: 'spinner' })
  })

  it('defaults a missing (null/undefined/empty) status to pending/spinner', () => {
    expect(describeToolStatus(null)).toEqual({ state: 'pending', glyph: 'spinner' })
    expect(describeToolStatus(undefined)).toEqual({ state: 'pending', glyph: 'spinner' })
    expect(describeToolStatus('')).toEqual({ state: 'pending', glyph: 'spinner' })
  })
})
