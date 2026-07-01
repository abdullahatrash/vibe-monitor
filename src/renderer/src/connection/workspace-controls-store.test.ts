import { describe, it, expect } from 'vitest'
import {
  WORKSPACE_CONTROLS_STORAGE_KEY,
  getWorkspaceControls,
  setWorkspaceControls,
  workspaceControlsKey,
  type WorkspaceControlsStorage,
} from './workspace-controls-store'
import type { ThreadAgentControls } from '../../../shared/ipc'

/**
 * Per-Workspace agent-controls cache (#153): the last session-reported option lists
 * (+ current values) for a Workspace, cached so a never-bound draft's picker can show
 * BEFORE the first prompt mints a session (ADR-0011 lazy binding). The module is pure
 * over an injected storage seam, so here we feed it a Map-backed fake — round-trip,
 * per-Workspace isolation, the key fallback, and the never-throw tolerance paths.
 */

/** A Map-backed fake satisfying the injected `WorkspaceControlsStorage` seam. */
function fakeStorage(): WorkspaceControlsStorage & { map: Map<string, string> } {
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

/** A full three-axis controls bundle for round-trip assertions. */
function sampleControls(): ThreadAgentControls {
  return {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    models: {
      currentModelId: 'mistral-large',
      availableModels: [
        { modelId: 'mistral-large', name: 'Mistral Large' },
        { modelId: 'mistral-small', name: 'Mistral Small' },
      ],
    },
    reasoningEffort: {
      current: 'high',
      options: [{ value: 'low' }, { value: 'high', name: 'High' }],
    },
  }
}

describe('workspaceControlsKey', () => {
  it('prefers the persisted workspaceId', () => {
    expect(workspaceControlsKey('ws-1', '/home/me/project')).toBe('ws-1')
  })

  it('falls back to the workspaceDir when workspaceId is null (degraded / no-store draft)', () => {
    expect(workspaceControlsKey(null, '/home/me/project')).toBe('/home/me/project')
  })

  it('falls back to the workspaceDir for an empty workspaceId', () => {
    expect(workspaceControlsKey('', '/home/me/project')).toBe('/home/me/project')
  })
})

describe('get / set round-trip', () => {
  it('stores and reads back a Workspace bundle keyed by its key', () => {
    const storage = fakeStorage()
    const controls = sampleControls()
    setWorkspaceControls(storage, 'ws-1', controls)
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual(controls)
  })

  it('returns null for an absent Workspace', () => {
    expect(getWorkspaceControls(fakeStorage(), 'never')).toBeNull()
  })

  it('overwrites (patches) one Workspace without disturbing another', () => {
    const storage = fakeStorage()
    const a = sampleControls()
    const b: ThreadAgentControls = {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      models: null,
      reasoningEffort: null,
    }
    setWorkspaceControls(storage, 'ws-1', a)
    setWorkspaceControls(storage, 'ws-2', b)
    // Re-write ws-1 with a different bundle; ws-2 must stay intact.
    const a2: ThreadAgentControls = {
      modes: { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }] },
      models: null,
      reasoningEffort: null,
    }
    setWorkspaceControls(storage, 'ws-1', a2)
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual(a2)
    expect(getWorkspaceControls(storage, 'ws-2')).toEqual(b)
  })
})

describe('per-Workspace isolation', () => {
  it('keeps two Workspaces independent', () => {
    const storage = fakeStorage()
    const a = sampleControls()
    const b: ThreadAgentControls = {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      models: null,
      reasoningEffort: null,
    }
    setWorkspaceControls(storage, 'ws-1', a)
    setWorkspaceControls(storage, 'ws-2', b)
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual(a)
    expect(getWorkspaceControls(storage, 'ws-2')).toEqual(b)
  })

  it('normalizes a stored entry to the three-axis shape, defaulting missing axes to null', () => {
    const storage = fakeStorage()
    // A partial blob (e.g. from an older shape) still yields a valid bundle.
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, JSON.stringify({ 'ws-1': { modes: null } }))
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual({
      modes: null,
      models: null,
      reasoningEffort: null,
    })
  })

  it('nulls out an axis whose list field is missing or not an array (S1: picker maps it unguarded)', () => {
    const storage = fakeStorage()
    // A tampered/older blob: each axis is an object but its list field is absent or a
    // non-array. Passing these through would throw `undefined.map()` in AgentControls.
    storage.map.set(
      WORKSPACE_CONTROLS_STORAGE_KEY,
      JSON.stringify({
        'ws-1': {
          modes: { currentModeId: 'default' }, // no availableModes
          models: { currentModelId: 'm', availableModels: 'nope' }, // non-array list
          reasoningEffort: { current: 'high', options: [{ value: 'high' }] }, // valid → kept
        },
      }),
    )
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual({
      modes: null,
      models: null,
      reasoningEffort: { current: 'high', options: [{ value: 'high' }] },
    })
  })
})

describe('monotonic caching (N1: an all-null bundle never clobbers a good cache)', () => {
  it('does not write an all-null bundle', () => {
    const storage = fakeStorage()
    setWorkspaceControls(storage, 'ws-1', { modes: null, models: null, reasoningEffort: null })
    expect(getWorkspaceControls(storage, 'ws-1')).toBeNull()
    expect(storage.map.has(WORKSPACE_CONTROLS_STORAGE_KEY)).toBe(false)
  })

  it('a later all-null bind leaves an existing good cache intact', () => {
    const storage = fakeStorage()
    const good = sampleControls()
    setWorkspaceControls(storage, 'ws-1', good)
    // A degraded resume reports no axes — must NOT clobber the cached bundle.
    setWorkspaceControls(storage, 'ws-1', { modes: null, models: null, reasoningEffort: null })
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual(good)
  })
})

describe('malformed / missing tolerance (never throws into render)', () => {
  it('treats malformed JSON as absent', () => {
    const storage = fakeStorage()
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, '{not json')
    expect(getWorkspaceControls(storage, 'ws-1')).toBeNull()
  })

  it('treats a non-object blob as absent', () => {
    const storage = fakeStorage()
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, '"a string"')
    expect(getWorkspaceControls(storage, 'ws-1')).toBeNull()
  })

  it('treats an array blob as absent', () => {
    const storage = fakeStorage()
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, '[1,2,3]')
    expect(getWorkspaceControls(storage, 'ws-1')).toBeNull()
  })

  it('treats a non-object entry value as absent', () => {
    const storage = fakeStorage()
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, JSON.stringify({ 'ws-1': 42 }))
    expect(getWorkspaceControls(storage, 'ws-1')).toBeNull()
  })

  it('returns null for an absent key', () => {
    expect(getWorkspaceControls(fakeStorage(), 'ws-1')).toBeNull()
  })

  it('overwrites a malformed blob on the next set', () => {
    const storage = fakeStorage()
    storage.map.set(WORKSPACE_CONTROLS_STORAGE_KEY, '{not json')
    const controls = sampleControls()
    setWorkspaceControls(storage, 'ws-1', controls)
    expect(getWorkspaceControls(storage, 'ws-1')).toEqual(controls)
  })
})

describe('best-effort writes (a throwing storage does not propagate)', () => {
  it('swallows a setItem exception on set', () => {
    const throwing: WorkspaceControlsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
    }
    expect(() => setWorkspaceControls(throwing, 'ws-1', sampleControls())).not.toThrow()
  })

  it('swallows a getItem exception on read', () => {
    const throwing: WorkspaceControlsStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(getWorkspaceControls(throwing, 'ws-1')).toBeNull()
  })
})

describe('absent storage guard', () => {
  it('getWorkspaceControls returns null when storage is null/undefined', () => {
    expect(getWorkspaceControls(null, 'ws-1')).toBeNull()
    expect(getWorkspaceControls(undefined, 'ws-1')).toBeNull()
  })

  it('setWorkspaceControls is a no-op when storage is null/undefined', () => {
    expect(() => setWorkspaceControls(null, 'ws-1', sampleControls())).not.toThrow()
    expect(() => setWorkspaceControls(undefined, 'ws-1', sampleControls())).not.toThrow()
  })
})
