import { describe, expect, it, vi } from 'vitest'
import {
  getSidebarCollapsed,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  setSidebarCollapsed,
  type SidebarCollapsedStorage,
} from './sidebar-collapsed-store'

/** A throwaway in-memory Storage seam for the tests. */
function fakeStorage(
  seed?: Record<string, string>,
): SidebarCollapsedStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('getSidebarCollapsed', () => {
  it('defaults to false (expanded) when nothing is stored', () => {
    expect(getSidebarCollapsed(fakeStorage())).toBe(false)
  })

  it('defaults to false for a null/undefined store', () => {
    expect(getSidebarCollapsed(null)).toBe(false)
    expect(getSidebarCollapsed(undefined)).toBe(false)
  })

  it('reads true when the flag is stored as "true"', () => {
    expect(getSidebarCollapsed(fakeStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'true' }))).toBe(true)
  })

  it('reads false when the flag is stored as "false"', () => {
    expect(getSidebarCollapsed(fakeStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'false' }))).toBe(
      false,
    )
  })

  it('round-trips both values through setSidebarCollapsed', () => {
    const storage = fakeStorage()
    setSidebarCollapsed(storage, true)
    expect(getSidebarCollapsed(storage)).toBe(true)
    setSidebarCollapsed(storage, false)
    expect(getSidebarCollapsed(storage)).toBe(false)
  })

  it('treats any other/corrupt payload as absent → default false', () => {
    expect(getSidebarCollapsed(fakeStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: 'TRUE' }))).toBe(false)
    expect(getSidebarCollapsed(fakeStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: '1' }))).toBe(false)
    expect(getSidebarCollapsed(fakeStorage({ [SIDEBAR_COLLAPSED_STORAGE_KEY]: '{not json' }))).toBe(
      false,
    )
  })

  it('never throws when the store throws on read', () => {
    const storage: SidebarCollapsedStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(getSidebarCollapsed(storage)).toBe(false)
  })
})

describe('setSidebarCollapsed', () => {
  it('no-ops for a null/undefined store', () => {
    expect(() => setSidebarCollapsed(null, true)).not.toThrow()
    expect(() => setSidebarCollapsed(undefined, true)).not.toThrow()
  })

  it('swallows a throwing store (quota/security) without propagating', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    const storage: SidebarCollapsedStorage = { getItem: () => null, setItem }
    expect(() => setSidebarCollapsed(storage, true)).not.toThrow()
    expect(setItem).toHaveBeenCalledOnce()
  })
})
