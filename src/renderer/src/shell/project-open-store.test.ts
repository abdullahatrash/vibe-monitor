import { describe, expect, it, vi } from 'vitest'
import {
  getOpenProjects,
  OPEN_PROJECTS_STORAGE_KEY,
  setOpenProjects,
  type OpenProjectsStorage,
} from './project-open-store'

/** A throwaway in-memory Storage seam for the tests. */
function fakeStorage(seed?: Record<string, string>): OpenProjectsStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('getOpenProjects', () => {
  it('is empty when nothing is stored', () => {
    expect(getOpenProjects(fakeStorage())).toEqual([])
  })

  it('is empty for a null/undefined store', () => {
    expect(getOpenProjects(null)).toEqual([])
    expect(getOpenProjects(undefined)).toEqual([])
  })

  it('round-trips a set of ids through setOpenProjects', () => {
    const storage = fakeStorage()
    setOpenProjects(storage, ['a', 'b', 'c'])
    expect(getOpenProjects(storage)).toEqual(['a', 'b', 'c'])
  })

  it('ignores corrupt JSON and falls back to empty', () => {
    expect(getOpenProjects(fakeStorage({ [OPEN_PROJECTS_STORAGE_KEY]: '{not json' }))).toEqual([])
  })

  it('ignores a non-array payload', () => {
    expect(getOpenProjects(fakeStorage({ [OPEN_PROJECTS_STORAGE_KEY]: '"just-a-string"' }))).toEqual([])
  })

  it('filters non-string members out of the array', () => {
    expect(
      getOpenProjects(fakeStorage({ [OPEN_PROJECTS_STORAGE_KEY]: '["a", 1, null, "b", true]' })),
    ).toEqual(['a', 'b'])
  })

  it('never throws when the store throws on read', () => {
    const storage: OpenProjectsStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(getOpenProjects(storage)).toEqual([])
  })
})

describe('setOpenProjects', () => {
  it('no-ops for a null/undefined store', () => {
    expect(() => setOpenProjects(null, ['a'])).not.toThrow()
    expect(() => setOpenProjects(undefined, ['a'])).not.toThrow()
  })

  it('swallows a throwing store (quota/security) without propagating', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    const storage: OpenProjectsStorage = { getItem: () => null, setItem }
    expect(() => setOpenProjects(storage, ['a', 'b'])).not.toThrow()
    expect(setItem).toHaveBeenCalledOnce()
  })
})
