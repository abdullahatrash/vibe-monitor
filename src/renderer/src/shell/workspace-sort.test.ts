import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SORT_ORDER,
  WORKSPACE_SORT_STORAGE_KEY,
  getSortOrder,
  setSortOrder,
  sortWorkspaces,
  type SortOrderStorage,
} from './workspace-sort'

/** A minimal Workspace-shaped row for the sort. */
function ws(displayName: string): { id: string; displayName: string } {
  return { id: displayName, displayName }
}

describe('sortWorkspaces', () => {
  it("'recent' preserves the incoming (App-provided recency) order", () => {
    const list = [ws('Zed'), ws('alpha'), ws('Beta')]
    expect(sortWorkspaces(list, 'recent').map((w) => w.displayName)).toEqual(['Zed', 'alpha', 'Beta'])
  })

  it("'name' sorts by displayName case-insensitively", () => {
    const list = [ws('Zed'), ws('alpha'), ws('Beta')]
    expect(sortWorkspaces(list, 'name').map((w) => w.displayName)).toEqual(['alpha', 'Beta', 'Zed'])
  })

  it("'name' is stable for case-folded-equal names (keeps incoming order)", () => {
    const list = [
      { id: '1', displayName: 'repo' },
      { id: '2', displayName: 'Repo' },
      { id: '3', displayName: 'REPO' },
    ]
    expect(sortWorkspaces(list, 'name').map((w) => w.id)).toEqual(['1', '2', '3'])
  })

  it('returns a new array and never mutates the input', () => {
    const list = [ws('b'), ws('a')]
    const out = sortWorkspaces(list, 'name')
    expect(out).not.toBe(list)
    expect(list.map((w) => w.displayName)).toEqual(['b', 'a']) // input untouched
  })

  it('handles the empty and single-element cases', () => {
    expect(sortWorkspaces([], 'name')).toEqual([])
    expect(sortWorkspaces([ws('only')], 'name').map((w) => w.displayName)).toEqual(['only'])
  })
})

/** An in-memory storage double implementing the injected seam. */
function fakeStorage(initial?: Record<string, string>): SortOrderStorage & { map: Record<string, string> } {
  const map: Record<string, string> = { ...initial }
  return {
    map,
    getItem: (k) => (k in map ? map[k] : null),
    setItem: (k, v) => {
      map[k] = v
    },
  }
}

describe('getSortOrder', () => {
  it('defaults when absent, missing storage, or unknown value', () => {
    expect(getSortOrder(fakeStorage())).toBe(DEFAULT_SORT_ORDER)
    expect(getSortOrder(null)).toBe(DEFAULT_SORT_ORDER)
    expect(getSortOrder(fakeStorage({ [WORKSPACE_SORT_STORAGE_KEY]: 'bogus' }))).toBe(DEFAULT_SORT_ORDER)
  })

  it('reads a stored known order', () => {
    expect(getSortOrder(fakeStorage({ [WORKSPACE_SORT_STORAGE_KEY]: 'name' }))).toBe('name')
    expect(getSortOrder(fakeStorage({ [WORKSPACE_SORT_STORAGE_KEY]: 'recent' }))).toBe('recent')
  })

  it('never throws when the store throws', () => {
    const throwing: SortOrderStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(getSortOrder(throwing)).toBe(DEFAULT_SORT_ORDER)
  })
})

describe('setSortOrder', () => {
  it('persists the chosen order under the versioned key', () => {
    const storage = fakeStorage()
    setSortOrder(storage, 'name')
    expect(storage.map[WORKSPACE_SORT_STORAGE_KEY]).toBe('name')
  })

  it('never throws on a missing or blocked store', () => {
    expect(() => setSortOrder(null, 'name')).not.toThrow()
    const throwing: SortOrderStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(() => setSortOrder(throwing, 'name')).not.toThrow()
  })
})
