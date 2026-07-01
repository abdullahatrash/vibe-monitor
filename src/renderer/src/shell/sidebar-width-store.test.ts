import { describe, expect, it, vi } from 'vitest'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  getSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  setSidebarWidth,
  type SidebarWidthStorage,
} from './sidebar-width-store'

/** A throwaway in-memory Storage seam for the tests. */
function fakeStorage(
  seed?: Record<string, string>,
): SidebarWidthStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('clampSidebarWidth', () => {
  it('passes an in-range width through unchanged', () => {
    expect(clampSidebarWidth(338)).toBe(338)
    expect(clampSidebarWidth(300)).toBe(300)
  })

  it('clamps below the minimum up to MIN', () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH - 100)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(0)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(-50)).toBe(MIN_SIDEBAR_WIDTH)
  })

  it('clamps above the maximum down to MAX', () => {
    expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH + 100)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(10_000)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('keeps the exact bounds', () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('falls back to DEFAULT for NaN / non-finite inputs', () => {
    expect(clampSidebarWidth(NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Infinity)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(-Infinity)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})

describe('getSidebarWidth', () => {
  it('defaults to DEFAULT_SIDEBAR_WIDTH when nothing is stored', () => {
    expect(getSidebarWidth(fakeStorage())).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('defaults to DEFAULT_SIDEBAR_WIDTH for a null/undefined store', () => {
    expect(getSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(getSidebarWidth(undefined)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('reads a stored in-range width', () => {
    expect(getSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '300' }))).toBe(300)
  })

  it('clamps an out-of-range stored width', () => {
    expect(getSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '100' }))).toBe(
      MIN_SIDEBAR_WIDTH,
    )
    expect(getSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '9999' }))).toBe(
      MAX_SIDEBAR_WIDTH,
    )
  })

  it('defaults on a corrupt (non-numeric) payload', () => {
    expect(getSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: 'wide' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH,
    )
    expect(getSidebarWidth(fakeStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: '{not json' }))).toBe(
      DEFAULT_SIDEBAR_WIDTH,
    )
  })

  it('round-trips a value through setSidebarWidth', () => {
    const storage = fakeStorage()
    setSidebarWidth(storage, 400)
    expect(getSidebarWidth(storage)).toBe(400)
  })

  it('never throws when the store throws on read', () => {
    const storage: SidebarWidthStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(getSidebarWidth(storage)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})

describe('setSidebarWidth', () => {
  it('stores the CLAMPED value (out-of-range in → bound stored)', () => {
    const storage = fakeStorage()
    setSidebarWidth(storage, 9999)
    expect(storage.map.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(MAX_SIDEBAR_WIDTH))
    setSidebarWidth(storage, 10)
    expect(storage.map.get(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(MIN_SIDEBAR_WIDTH))
  })

  it('no-ops for a null/undefined store', () => {
    expect(() => setSidebarWidth(null, 300)).not.toThrow()
    expect(() => setSidebarWidth(undefined, 300)).not.toThrow()
  })

  it('swallows a throwing store (quota/security) without propagating', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    const storage: SidebarWidthStorage = { getItem: () => null, setItem }
    expect(() => setSidebarWidth(storage, 300)).not.toThrow()
    expect(setItem).toHaveBeenCalledOnce()
  })
})
