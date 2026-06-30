import { describe, it, expect } from 'vitest'
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  clearDraft,
  getDraft,
  setDraft,
  type DraftStorage,
} from './composer-draft-store'

/**
 * Per-Thread composer drafts (#60): unsent composer text persisted to localStorage
 * so it survives any unmount. The module is pure over an injected storage seam, so
 * here we feed it a Map-backed fake — round-trip, prune, raw-text fidelity, send
 * clear, per-Thread isolation, and the never-throw tolerance paths.
 */

/** A Map-backed fake satisfying the injected `DraftStorage` seam. */
function fakeStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

describe('getDraft / setDraft round-trip', () => {
  it('stores and reads back a draft keyed by threadId', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'hello world')
    expect(getDraft(storage, 't1')).toBe('hello world')
  })

  it('returns "" for an absent thread', () => {
    expect(getDraft(fakeStorage(), 'never')).toBe('')
  })

  it('overwrites an existing draft', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'first')
    setDraft(storage, 't1', 'second')
    expect(getDraft(storage, 't1')).toBe('second')
  })
})

describe('prune on empty / whitespace-only', () => {
  it('removes the entry when set to an empty string', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '')
    expect(getDraft(storage, 't1')).toBe('')
    // The entry is gone from the underlying map, not stored as ''.
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({})
  })

  it('removes the entry when set to whitespace-only text', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '   \n\t  ')
    expect(getDraft(storage, 't1')).toBe('')
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({})
  })

  it('removes the whole storage key once the last draft is pruned (no dangling blob)', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '')
    expect(storage.map.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
  })

  it('removes the whole storage key once the last draft is cleared', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'queued')
    clearDraft(storage, 't1')
    expect(storage.map.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
  })
})

describe('raw text fidelity (only the prune decision trims)', () => {
  it('preserves leading/trailing spaces and newlines verbatim', () => {
    const storage = fakeStorage()
    const raw = '  hello \n  world  \n'
    setDraft(storage, 't1', raw)
    expect(getDraft(storage, 't1')).toBe(raw)
  })

  it('keeps a non-empty draft that has trailing whitespace', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'typing ')
    expect(getDraft(storage, 't1')).toBe('typing ')
  })
})

describe('clearDraft (send / delete)', () => {
  it('removes the entry', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'queued prompt')
    clearDraft(storage, 't1')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('is a no-op for an absent entry', () => {
    const storage = fakeStorage()
    expect(() => clearDraft(storage, 'gone')).not.toThrow()
    expect(getDraft(storage, 'gone')).toBe('')
  })
})

describe('per-Thread isolation', () => {
  it('keeps two threads independent', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    expect(getDraft(storage, 't1')).toBe('one')
    expect(getDraft(storage, 't2')).toBe('two')
  })

  it('clearing one thread leaves the other intact (delete cascade)', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    clearDraft(storage, 't1')
    expect(getDraft(storage, 't1')).toBe('')
    expect(getDraft(storage, 't2')).toBe('two')
  })

  it('pruning one thread leaves the other intact', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    setDraft(storage, 't1', '')
    expect(getDraft(storage, 't1')).toBe('')
    expect(getDraft(storage, 't2')).toBe('two')
  })
})

describe('malformed / missing tolerance (never throws into render)', () => {
  it('treats malformed JSON as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '{not json')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats a non-object blob as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '"a string"')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats an array blob as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '[1,2,3]')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats a non-string entry value as ""', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ t1: 42 }))
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('returns "" for an absent key', () => {
    expect(getDraft(fakeStorage(), 't1')).toBe('')
  })

  it('overwrites a malformed blob on the next set', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '{not json')
    setDraft(storage, 't1', 'recovered')
    expect(getDraft(storage, 't1')).toBe('recovered')
  })
})

describe('best-effort writes (a throwing storage does not propagate)', () => {
  it('swallows a setItem exception on set', () => {
    const throwing: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
    }
    expect(() => setDraft(throwing, 't1', 'text')).not.toThrow()
  })

  it('swallows a getItem exception on read', () => {
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(getDraft(throwing, 't1')).toBe('')
    expect(() => clearDraft(throwing, 't1')).not.toThrow()
  })
})

describe('absent storage guard', () => {
  it('getDraft returns "" when storage is null/undefined', () => {
    expect(getDraft(null, 't1')).toBe('')
    expect(getDraft(undefined, 't1')).toBe('')
  })

  it('setDraft / clearDraft are no-ops when storage is null/undefined', () => {
    expect(() => setDraft(null, 't1', 'x')).not.toThrow()
    expect(() => clearDraft(undefined, 't1')).not.toThrow()
  })
})
