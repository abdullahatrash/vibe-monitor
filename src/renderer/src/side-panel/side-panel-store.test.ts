import { afterEach, describe, expect, it } from 'vitest'
import {
  activateSurface,
  activateWorkspaceSurface,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  closePanel,
  coercePanelState,
  coerceSurface,
  EMPTY_PANEL_STATE,
  getWorkspacePanel,
  openSurface,
  openWorkspaceSurface,
  readPanelMap,
  showPanel,
  SIDE_PANEL_STORAGE_KEY,
  subscribe,
  toggleSurface,
  toggleWorkspaceSurface,
  togglePanelVisibility,
  updateWorkspace,
  writePanelMap,
  _resetSidePanelStore,
  type PanelStorage,
  type Surface,
  type WorkspacePanelState,
} from './side-panel-store'

/** A closed, empty starting state (a copy so tests never share the frozen constant). */
function empty(): WorkspacePanelState {
  return { isOpen: false, activeSurfaceId: null, surfaces: [] }
}

const REVIEW: Surface = { id: 'review', kind: 'review' }
const FILES: Surface = { id: 'files', kind: 'files' }

describe('openSurface', () => {
  it('opens the panel with the singleton active from a closed empty state', () => {
    expect(openSurface(empty(), 'review')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW],
    })
  })

  it('appends a second singleton and activates it (ordered, both open)', () => {
    const one = openSurface(empty(), 'review')
    expect(openSurface(one, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('re-activates an already-open singleton instead of duplicating it', () => {
    const both = openSurface(openSurface(empty(), 'review'), 'files')
    const again = openSurface(both, 'review')
    expect(again.surfaces).toEqual([REVIEW, FILES])
    expect(again.activeSurfaceId).toBe('review')
  })

  it('re-opens the panel (isOpen) when a hidden panel still holds the surface', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(openSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })
})

describe('toggleSurface (⌘P / ⌃⇧G semantics)', () => {
  it('opens a closed empty panel with the surface active', () => {
    expect(toggleSurface(empty(), 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('opens a closed panel that already holds the surface (does NOT stay closed)', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(toggleSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('hides the panel when its kind is already the ACTIVE tab (keeping tabs + active id)', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: false,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('switches to the surface when a DIFFERENT tab is active (panel stays open)', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('opens + adds the surface when the panel is open but the kind is not present', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })
})

describe('activateSurface', () => {
  it('activates an open surface and shows the panel', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(activateSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('is a no-op for an unknown id (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(activateSurface(state, 'files')).toBe(state)
  })
})

describe('closeSurface', () => {
  it('removes a non-active tab, leaving the active one', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(closeSurface(state, 'review')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('activates the NEXT tab (slid into the slot) when closing the active middle tab', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES, c],
    }
    // index 1 (files) closed → neighbour at min(1, 1) = the new index 1 = c.
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:c',
      surfaces: [REVIEW, c],
    })
  })

  it('activates the new LAST tab when closing the active last tab', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    // index 1 closed → min(1, 0) = 0 = review.
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW],
    })
  })

  it('returns to the cards (active null, panel still open) when closing the last tab', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('is a no-op for an unknown id (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(closeSurface(state, 'files')).toBe(state)
  })
})

describe('closeOtherSurfaces', () => {
  it('keeps + activates only the given surface', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(closeOtherSurfaces(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('is a no-op with a single surface (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closeOtherSurfaces(state, 'files')).toBe(state)
  })
})

describe('closeSurfacesToRight', () => {
  it('drops every tab after the given one', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'file:c',
      surfaces: [REVIEW, FILES, c],
    }
    // active (c) is dropped → falls back to the anchor (files).
    expect(closeSurfacesToRight(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('keeps the active tab when it survives to the left', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW, FILES, c],
    }
    expect(closeSurfacesToRight(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW, FILES],
    })
  })

  it('is a no-op when the given tab is already last (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(closeSurfacesToRight(state, 'files')).toBe(state)
  })
})

describe('closeAllSurfaces', () => {
  it('clears every tab and hides the panel', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(closeAllSurfaces(state)).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] })
  })

  it('is a no-op when already empty (same ref)', () => {
    const state = empty()
    expect(closeAllSurfaces(state)).toBe(state)
  })
})

describe('panel visibility', () => {
  it('showPanel opens; is a no-op when already open', () => {
    const closed: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(showPanel(closed).isOpen).toBe(true)
    const open = showPanel(closed)
    expect(showPanel(open)).toBe(open)
  })

  it('closePanel hides; is a no-op when already closed', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closePanel(open).isOpen).toBe(false)
    const closed = closePanel(open)
    expect(closePanel(closed)).toBe(closed)
  })

  it('togglePanelVisibility flips isOpen, keeping tabs + active id', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(togglePanelVisibility(open)).toEqual({
      isOpen: false,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
    expect(togglePanelVisibility(togglePanelVisibility(open))).toEqual(open)
  })
})

describe('updateWorkspace', () => {
  it('scopes state per Workspace without touching siblings (stable sibling ref)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const before = map['ws-a']
    const next = updateWorkspace(map, 'ws-b', (s) => openSurface(s, 'files'))
    expect(next['ws-a']).toBe(before) // unchanged sibling keeps its identity
    expect(next['ws-b']?.activeSurfaceId).toBe('files')
  })

  it('prunes a Workspace that lands fully-empty (no residue)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const closed = updateWorkspace(map, 'ws-a', closeAllSurfaces)
    expect('ws-a' in closed).toBe(false)
  })

  it('returns the SAME map when the updater is a no-op', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const same = updateWorkspace(map, 'ws-a', (s) => activateSurface(s, 'nope'))
    expect(same).toBe(map)
  })

  it('KEEPS an open, zero-surface Workspace (the cards empty state is legitimate)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const cards = updateWorkspace(map, 'ws-a', (s) => closeSurface(s, 'review'))
    expect(cards['ws-a']).toEqual({ isOpen: true, activeSurfaceId: null, surfaces: [] })
  })
})

describe('coerceSurface', () => {
  it('accepts the implemented singletons', () => {
    expect(coerceSurface({ id: 'review', kind: 'review' })).toEqual(REVIEW)
    expect(coerceSurface({ id: 'files', kind: 'files' })).toEqual(FILES)
  })

  it('drops not-yet-implemented / unknown / malformed descriptors', () => {
    expect(coerceSurface({ kind: 'file', relativePath: 'x' })).toBeNull()
    expect(coerceSurface({ kind: 'terminal' })).toBeNull()
    expect(coerceSurface({ kind: 'nope' })).toBeNull()
    expect(coerceSurface(null)).toBeNull()
    expect(coerceSurface('review')).toBeNull()
  })
})

describe('coercePanelState', () => {
  it('coerces + de-duplicates surfaces and validates the active id', () => {
    const state = coercePanelState({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [
        { id: 'review', kind: 'review' },
        { id: 'review', kind: 'review' },
        { id: 'files', kind: 'files' },
        { id: 'x', kind: 'nope' },
      ],
    })
    expect(state).toEqual({ isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] })
  })

  it('nulls an active id that no longer names a surviving surface', () => {
    const state = coercePanelState({ isOpen: true, activeSurfaceId: 'gone', surfaces: [REVIEW] })
    expect(state.activeSurfaceId).toBeNull()
  })

  it('degrades a malformed blob to the empty state', () => {
    expect(coercePanelState(null)).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState(42)).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState([])).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState({})).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] })
  })
})

// --- Persistence round-trip through a fake storage ---

/** An in-memory `PanelStorage` with an injectable throw. */
function fakeStorage(): PanelStorage & { store: Map<string, string>; throwOnGet?: boolean; throwOnSet?: boolean } {
  const store = new Map<string, string>()
  return {
    store,
    getItem(key) {
      if (this.throwOnGet) throw new Error('blocked')
      return store.get(key) ?? null
    },
    setItem(key, value) {
      if (this.throwOnSet) throw new Error('full')
      store.set(key, value)
    },
  }
}

describe('readPanelMap / writePanelMap', () => {
  it('round-trips a per-Workspace map under the v2 key', () => {
    const storage = fakeStorage()
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(openSurface(s, 'review'), 'files'))
    writePanelMap(storage, map)
    expect(storage.store.has(SIDE_PANEL_STORAGE_KEY)).toBe(true)
    expect(readPanelMap(storage)).toEqual(map)
  })

  it('returns {} for absent storage value', () => {
    expect(readPanelMap(fakeStorage())).toEqual({})
  })

  it('prunes fully-empty entries on read', () => {
    const storage = fakeStorage()
    storage.store.set(
      SIDE_PANEL_STORAGE_KEY,
      JSON.stringify({ 'ws-a': { isOpen: false, activeSurfaceId: null, surfaces: [] } }),
    )
    expect(readPanelMap(storage)).toEqual({})
  })

  it('degrades a non-object / array payload to {}', () => {
    const storage = fakeStorage()
    storage.store.set(SIDE_PANEL_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(readPanelMap(storage)).toEqual({})
  })

  it('swallows a throwing setItem (best-effort write)', () => {
    const storage = fakeStorage()
    storage.throwOnSet = true
    expect(() => writePanelMap(storage, { 'ws-a': openSurface(empty(), 'review') })).not.toThrow()
  })
})

// --- The reactive singleton (reset per test so state never leaks) ---

describe('module singleton', () => {
  afterEach(() => _resetSidePanelStore(null))

  it('seeds from the injected storage and reads back per Workspace', () => {
    const storage = fakeStorage()
    writePanelMap(storage, { 'ws-a': openSurface(empty(), 'review') })
    _resetSidePanelStore(storage)
    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBe('review')
    expect(getWorkspacePanel('ws-unknown')).toBe(EMPTY_PANEL_STATE)
  })

  it('persists ops back to the injected storage', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)
    openWorkspaceSurface('ws-a', 'files')
    expect(readPanelMap(storage)['ws-a']).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('notifies subscribers on a real change only', () => {
    _resetSidePanelStore(null)
    let count = 0
    const off = subscribe(() => (count += 1))
    openWorkspaceSurface('ws-a', 'files')
    expect(count).toBe(1)
    activateWorkspaceSurface('ws-a', 'zzz') // unknown id changes nothing → no notify
    expect(count).toBe(1)
    off()
  })

  it('tolerates a throwing storage on seed (degrades to empty)', () => {
    const storage = fakeStorage()
    storage.throwOnGet = true
    expect(() => _resetSidePanelStore(storage)).not.toThrow()
    expect(getWorkspacePanel('ws-a')).toBe(EMPTY_PANEL_STATE)
  })

  it('toggleWorkspaceSurface drives the full open→hide cycle', () => {
    _resetSidePanelStore(null)
    toggleWorkspaceSurface('ws-a', 'files') // closed → open, files active
    expect(getWorkspacePanel('ws-a')).toEqual({ isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] })
    toggleWorkspaceSurface('ws-a', 'files') // active kind → hide
    expect(getWorkspacePanel('ws-a').isOpen).toBe(false)
    toggleWorkspaceSurface('ws-a', 'files') // hidden → re-open
    expect(getWorkspacePanel('ws-a').isOpen).toBe(true)
  })
})
