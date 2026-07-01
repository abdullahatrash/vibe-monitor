import { describe, expect, it } from 'vitest'
import { isRejectOption } from './permission-option'

describe('isRejectOption', () => {
  it('classifies reject_once / reject_always as reject actions', () => {
    expect(isRejectOption({ kind: 'reject_once' })).toBe(true)
    expect(isRejectOption({ kind: 'reject_always' })).toBe(true)
  })

  it('classifies allow_* kinds as non-reject (allow) actions', () => {
    expect(isRejectOption({ kind: 'allow_once' })).toBe(false)
    expect(isRejectOption({ kind: 'allow_always' })).toBe(false)
  })

  it('treats an unknown kind as a non-reject action', () => {
    expect(isRejectOption({ kind: 'proceed' })).toBe(false)
    expect(isRejectOption({ kind: '' })).toBe(false)
  })
})
