import { beforeEach, describe, expect, it } from 'vitest'
import { clearCommitDrafts, getCommitDraft, setCommitDraft } from './commit-draft-store'

describe('commit-draft-store', () => {
  beforeEach(() => {
    clearCommitDrafts()
  })

  it('round-trips a draft per Workspace', () => {
    setCommitDraft('/a', { message: 'fix: thing', unchecked: new Set(['x.ts']) })
    expect(getCommitDraft('/a')).toEqual({ message: 'fix: thing', unchecked: new Set(['x.ts']) })
  })

  it('isolates Workspaces', () => {
    setCommitDraft('/a', { message: 'for a', unchecked: new Set() })
    setCommitDraft('/b', { message: 'for b', unchecked: new Set() })
    expect(getCommitDraft('/a')?.message).toBe('for a')
    expect(getCommitDraft('/b')?.message).toBe('for b')
  })

  it('returns undefined for a Workspace with no draft', () => {
    expect(getCommitDraft('/nope')).toBeUndefined()
  })

  it('deletes the entry when the draft is empty (post-commit leaves no residue)', () => {
    setCommitDraft('/a', { message: 'wip', unchecked: new Set() })
    setCommitDraft('/a', { message: '', unchecked: new Set() })
    expect(getCommitDraft('/a')).toBeUndefined()
  })

  it('keeps an entry with an empty message but a live deselection set', () => {
    setCommitDraft('/a', { message: '', unchecked: new Set(['skip.ts']) })
    expect(getCommitDraft('/a')?.unchecked).toEqual(new Set(['skip.ts']))
  })
})
