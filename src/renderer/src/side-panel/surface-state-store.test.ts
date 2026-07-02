import { describe, expect, it, vi } from 'vitest'
import {
  getSurfaceState,
  setSurfaceState,
  SURFACE_STATE_STORAGE_KEY,
  type SurfaceStateStorage,
} from './surface-state-store'

/** A throwaway in-memory Storage seam for the tests. */
function fakeStorage(seed?: Record<string, string>): SurfaceStateStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('getSurfaceState', () => {
  it('defaults to null (collapsed) when nothing is stored', () => {
    expect(getSurfaceState(fakeStorage(), 'ws-1')).toBeNull()
  })

  it('defaults to null for a null/undefined store', () => {
    expect(getSurfaceState(null, 'ws-1')).toBeNull()
    expect(getSurfaceState(undefined, 'ws-1')).toBeNull()
  })

  it('reads a per-Workspace entry, independent of other Workspaces', () => {
    const storage = fakeStorage({
      [SURFACE_STATE_STORAGE_KEY]: JSON.stringify({ 'ws-1': 'review', 'ws-2': 'files' }),
    })
    expect(getSurfaceState(storage, 'ws-1')).toBe('review')
    expect(getSurfaceState(storage, 'ws-2')).toBe('files')
    expect(getSurfaceState(storage, 'ws-3')).toBeNull()
  })

  it('drops members that are not a live Surface', () => {
    const storage = fakeStorage({
      [SURFACE_STATE_STORAGE_KEY]: JSON.stringify({ 'ws-1': 'terminal', 'ws-2': 42, 'ws-3': 'files' }),
    })
    expect(getSurfaceState(storage, 'ws-1')).toBeNull()
    expect(getSurfaceState(storage, 'ws-2')).toBeNull()
    expect(getSurfaceState(storage, 'ws-3')).toBe('files')
  })

  it('treats a non-object / corrupt payload as absent → null', () => {
    expect(getSurfaceState(fakeStorage({ [SURFACE_STATE_STORAGE_KEY]: '{not json' }), 'ws-1')).toBeNull()
    expect(getSurfaceState(fakeStorage({ [SURFACE_STATE_STORAGE_KEY]: '["review"]' }), 'ws-1')).toBeNull()
    expect(getSurfaceState(fakeStorage({ [SURFACE_STATE_STORAGE_KEY]: '"review"' }), 'ws-1')).toBeNull()
  })

  it('never throws when the store throws on read', () => {
    const storage: SurfaceStateStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {},
    }
    expect(getSurfaceState(storage, 'ws-1')).toBeNull()
  })
})

describe('setSurfaceState', () => {
  it('round-trips a per-Workspace choice', () => {
    const storage = fakeStorage()
    setSurfaceState(storage, 'ws-1', 'review')
    expect(getSurfaceState(storage, 'ws-1')).toBe('review')
    setSurfaceState(storage, 'ws-1', 'files')
    expect(getSurfaceState(storage, 'ws-1')).toBe('files')
  })

  it('clears a Workspace entry on null without disturbing others', () => {
    const storage = fakeStorage()
    setSurfaceState(storage, 'ws-1', 'review')
    setSurfaceState(storage, 'ws-2', 'files')
    setSurfaceState(storage, 'ws-1', null)
    expect(getSurfaceState(storage, 'ws-1')).toBeNull()
    expect(getSurfaceState(storage, 'ws-2')).toBe('files')
  })

  it('no-ops for a null/undefined store', () => {
    expect(() => setSurfaceState(null, 'ws-1', 'review')).not.toThrow()
    expect(() => setSurfaceState(undefined, 'ws-1', 'review')).not.toThrow()
  })

  it('swallows a throwing store (quota/security) without propagating', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota exceeded')
    })
    const storage: SurfaceStateStorage = { getItem: () => null, setItem }
    expect(() => setSurfaceState(storage, 'ws-1', 'review')).not.toThrow()
    expect(setItem).toHaveBeenCalledOnce()
  })
})
