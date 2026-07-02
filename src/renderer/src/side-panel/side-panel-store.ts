/**
 * The right side panel's Surface-descriptor store (#193, ADR-0013 decision 1;
 * CONTEXT.md "Surface" / "Side panel"). Reshapes the panel onto t3code's Sheet/tab
 * model (`apps/web/src/rightPanelStore.ts`): per-Workspace, the panel owns an ORDERED
 * list of open Surface descriptors + an active id + an open flag. Open Surfaces render
 * as a tab strip; with zero open the panel shows the launcher cards (its empty state).
 *
 * Two layers, split like `follow-up-queue.ts` and the app's other renderer logic:
 *  - PURE immutable ops over a single `WorkspacePanelState` (and the per-Workspace map),
 *    plus coercion/serialization — all unit-tested here, DOM-free.
 *  - A MODULE-LEVEL singleton wiring those ops to a `useSyncExternalStore` subscription
 *    and localStorage persistence through an injected-storage seam (throw-tolerant, the
 *    established pattern). The singleton is shared so the window-header icon (App) and a
 *    Workspace's `SurfacePanel` drive the SAME state.
 *
 * The op SEMANTICS mirror t3code's `rightPanelStore` (read its implementations): a
 * singleton kind opened twice ACTIVATES rather than duplicating; closing the active tab
 * activates the neighbour at `min(index, len-1)`; `toggle` hides the panel when its kind
 * is already the active tab, else opens/activates it (the ⌘P / ⌃⇧G semantics, including
 * opening a CLOSED panel). The old `surface-state:v1` / `side-panel-open:v1` keys are
 * SUPERSEDED — not migrated; a fresh `:v2` key holds the new shape.
 */
import { useSyncExternalStore } from 'react'

/** Every Surface kind the descriptor union accommodates (#189 files, reserved terminal/
 *  browser). Only the SINGLETON kinds have ops this slice. */
export const SURFACE_KINDS = ['review', 'files', 'file', 'terminal', 'browser'] as const
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** The kinds with a singleton descriptor + ops NOW (`review`, `files`). ⌘P/⌃⇧G target these. */
export type SingletonKind = 'review' | 'files'

/**
 * A Surface descriptor. `review`/`files` are singletons (fixed id === kind); the union is
 * shaped like t3code's to accommodate a per-file `file:<relativePath>` Surface (#189) and
 * reserved `terminal`/`browser` kinds, but only the singletons are constructed here.
 */
export type Surface =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; relativePath: string }
  | { id: `terminal:${string}`; kind: 'terminal'; resourceId: string }
  | { id: `browser:${string}`; kind: 'browser'; resourceId: string }

/** One Workspace's panel state: open flag + ordered Surfaces + which is active. */
export interface WorkspacePanelState {
  isOpen: boolean
  activeSurfaceId: string | null
  surfaces: Surface[]
}

/** The whole persisted map, keyed by workspaceId. */
export type PanelStateMap = Record<string, WorkspacePanelState>

/** The versioned localStorage key holding the per-Workspace panel map (supersedes v1). */
export const SIDE_PANEL_STORAGE_KEY = 'vibe-mistro:side-panel:v2'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface PanelStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The default (absent-Workspace) state: closed, nothing open. A single FROZEN shared
 * instance so an unknown Workspace's `useSyncExternalStore` snapshot has a STABLE
 * reference (a fresh object per read would loop the subscription).
 */
export const EMPTY_PANEL_STATE: WorkspacePanelState = Object.freeze({
  isOpen: false,
  activeSurfaceId: null,
  surfaces: Object.freeze([]) as unknown as Surface[],
})

// --- Descriptor constructors (only the singleton kinds this slice) ---

/** The singleton descriptor for a kind (fixed id === kind). */
function singletonSurface(kind: SingletonKind): Surface {
  return kind === 'review' ? { id: 'review', kind: 'review' } : { id: 'files', kind: 'files' }
}

// --- Pure immutable ops over ONE WorkspacePanelState (never mutate inputs) ---

/**
 * Add `surface` (if absent) and activate it, opening the panel. A singleton already
 * present is only re-activated, never duplicated (t3code `upsertSurface`).
 */
function upsertSurface(state: WorkspacePanelState, surface: Surface): WorkspacePanelState {
  return {
    isOpen: true,
    surfaces: state.surfaces.some((entry) => entry.id === surface.id)
      ? state.surfaces
      : [...state.surfaces, surface],
    activeSurfaceId: surface.id,
  }
}

/** Open (or re-activate) a singleton Surface, opening the panel. */
export function openSurface(state: WorkspacePanelState, kind: SingletonKind): WorkspacePanelState {
  return upsertSurface(state, singletonSurface(kind))
}

/**
 * The ⌘P / ⌃⇧G semantics (t3code `toggle`): if the panel is open AND this kind is the
 * ACTIVE tab, hide the panel (keep the tabs + active id). Otherwise open/activate the
 * singleton — which also OPENS a closed panel. So one chord opens, a second (while it's
 * the active tab) closes; from another tab it switches.
 */
export function toggleSurface(state: WorkspacePanelState, kind: SingletonKind): WorkspacePanelState {
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId)
  if (state.isOpen && active?.kind === kind) return { ...state, isOpen: false }
  return openSurface(state, kind)
}

/** Activate an already-open Surface by id, opening the panel; a no-op if absent. */
export function activateSurface(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  if (!state.surfaces.some((surface) => surface.id === surfaceId)) return state
  return { ...state, isOpen: true, activeSurfaceId: surfaceId }
}

/**
 * Close ONE Surface. When it was the active tab, activate the neighbour at
 * `min(index, len-1)` — the tab that slides into its slot, or the new last tab
 * (t3code `closeSurface`'s fallback). Closing the FINAL tab returns
 * `activeSurfaceId: null` with the panel STILL OPEN — the launcher-cards empty state
 * (brief decision 3; a deliberate deviation from t3code, which hides the panel on the
 * last close). `closePanel` / `closeAllSurfaces` are the ways to hide the panel.
 */
export function closeSurface(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === surfaceId)
  if (index < 0) return state
  const surfaces = state.surfaces.filter((surface) => surface.id !== surfaceId)
  if (state.activeSurfaceId !== surfaceId) return { ...state, surfaces }
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null
  return { ...state, surfaces, activeSurfaceId: fallback?.id ?? null }
}

/** Close every OTHER Surface, keeping + activating `surfaceId` (t3code `closeOtherSurfaces`). */
export function closeOtherSurfaces(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const surface = state.surfaces.find((entry) => entry.id === surfaceId)
  if (!surface || state.surfaces.length === 1) return state
  return { ...state, isOpen: true, surfaces: [surface], activeSurfaceId: surface.id }
}

/**
 * Close every Surface to the RIGHT of `surfaceId` (t3code `closeSurfacesToRight`). The
 * active tab is retained when it survives, else it falls to `surfaceId`.
 */
export function closeSurfacesToRight(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === surfaceId)
  if (index < 0 || index === state.surfaces.length - 1) return state
  const surfaces = state.surfaces.slice(0, index + 1)
  const activeStillExists = surfaces.some((surface) => surface.id === state.activeSurfaceId)
  return { ...state, surfaces, activeSurfaceId: activeStillExists ? state.activeSurfaceId : surfaceId }
}

/** Close ALL Surfaces and the panel (t3code `closeAllSurfaces`). */
export function closeAllSurfaces(state: WorkspacePanelState): WorkspacePanelState {
  if (state.surfaces.length === 0) return state
  return { ...state, isOpen: false, surfaces: [], activeSurfaceId: null }
}

/** Show the panel (header icon / a Surface open) — keeps tabs + active id (t3code `show`). */
export function showPanel(state: WorkspacePanelState): WorkspacePanelState {
  return state.isOpen ? state : { ...state, isOpen: true }
}

/** Hide the panel — keeps tabs + active id, so re-showing lands where you left off. */
export function closePanel(state: WorkspacePanelState): WorkspacePanelState {
  return state.isOpen ? { ...state, isOpen: false } : state
}

/** Flip the panel's visibility (the window-header PanelRight icon; t3code `toggleVisibility`). */
export function togglePanelVisibility(state: WorkspacePanelState): WorkspacePanelState {
  return { ...state, isOpen: !state.isOpen }
}

// --- Pure map wrapper (prunes fully-empty Workspaces, t3code `updateThread`) ---

/**
 * Apply `updater` to one Workspace's state within the map, returning a NEW map (inputs
 * untouched) — or the SAME map reference when nothing changed, so an unrelated Workspace's
 * snapshot ref stays stable. A Workspace that lands fully-empty (closed, no active, no
 * surfaces) is PRUNED so it leaves no residue.
 */
export function updateWorkspace(
  map: PanelStateMap,
  workspaceId: string,
  updater: (current: WorkspacePanelState) => WorkspacePanelState,
): PanelStateMap {
  const current = map[workspaceId] ?? EMPTY_PANEL_STATE
  const next = updater(current)
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(workspaceId in map)) return map
    const rest = { ...map }
    delete rest[workspaceId]
    return rest
  }
  if (next === current) return map
  return { ...map, [workspaceId]: next }
}

// --- Coercion + (de)serialization (defensive against corrupt / legacy blobs) ---

/**
 * Coerce an untrusted descriptor into a valid `Surface`, or `null` to drop it. Only the
 * IMPLEMENTED singleton kinds are accepted this slice; a `file`/`terminal`/`browser`
 * blob (or anything unknown) is dropped rather than trusted — #189 extends this when the
 * `file` shape lands.
 */
export function coerceSurface(raw: unknown): Surface | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'review') return { id: 'review', kind: 'review' }
  if (kind === 'files') return { id: 'files', kind: 'files' }
  return null
}

/**
 * Coerce an untrusted per-Workspace blob into a valid `WorkspacePanelState`. Surfaces are
 * coerced + de-duplicated by id; `activeSurfaceId` survives only if it names a surviving
 * Surface; `isOpen` is honoured as a boolean (an open-with-zero-surfaces state — the cards
 * empty state — is legitimate). Anything malformed degrades to `EMPTY_PANEL_STATE`.
 */
export function coercePanelState(raw: unknown): WorkspacePanelState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_PANEL_STATE
  const obj = raw as { isOpen?: unknown; activeSurfaceId?: unknown; surfaces?: unknown }
  const surfaces: Surface[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.surfaces)) {
    for (const entry of obj.surfaces) {
      const surface = coerceSurface(entry)
      if (surface && !seen.has(surface.id)) {
        seen.add(surface.id)
        surfaces.push(surface)
      }
    }
  }
  const activeSurfaceId =
    typeof obj.activeSurfaceId === 'string' && seen.has(obj.activeSurfaceId)
      ? obj.activeSurfaceId
      : null
  const isOpen = typeof obj.isOpen === 'boolean' ? obj.isOpen : false
  return { isOpen, activeSurfaceId, surfaces }
}

/**
 * Read the whole persisted map, coercing each entry and pruning any that lands fully-empty.
 * MAY THROW if `getItem` / `JSON.parse` throws — callers wrap and fall back to `{}`.
 */
export function readPanelMap(storage: PanelStorage): PanelStateMap {
  const raw = storage.getItem(SIDE_PANEL_STORAGE_KEY)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: PanelStateMap = {}
  for (const [workspaceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const state = coercePanelState(value)
    if (state.isOpen || state.activeSurfaceId !== null || state.surfaces.length > 0) {
      out[workspaceId] = state
    }
  }
  return out
}

/** Persist the map best-effort; a quota/security exception is swallowed (never traps a toggle). */
export function writePanelMap(storage: PanelStorage, map: PanelStateMap): void {
  try {
    storage.setItem(SIDE_PANEL_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a panel op.
  }
}

// --- The module singleton (shared reactive state + localStorage persistence) ---

/** Resolve the live storage, tolerating a missing/throwing `window` (node tests, SSR). */
function resolveStorage(): PanelStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Read the map from a storage, tolerating any throw (blocked/corrupt) → `{}`. */
function safeReadMap(storage: PanelStorage | null): PanelStateMap {
  if (!storage) return {}
  try {
    return readPanelMap(storage)
  } catch {
    return {}
  }
}

let storage: PanelStorage | null = resolveStorage()
let byWorkspace: PanelStateMap = safeReadMap(storage)
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Subscribe to any panel-state change; returns an unsubscribe (for `useSyncExternalStore`). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A Workspace's panel state as a STABLE reference: the same object until THAT Workspace
 * changes (the pure ops only replace the mutated Workspace's value), and the shared frozen
 * empty otherwise. Safe as a `useSyncExternalStore` snapshot.
 */
export function getWorkspacePanel(workspaceId: string): WorkspacePanelState {
  return byWorkspace[workspaceId] ?? EMPTY_PANEL_STATE
}

/** Apply a pure op to one Workspace, persisting + notifying only on a real change. */
function apply(workspaceId: string, updater: (current: WorkspacePanelState) => WorkspacePanelState): void {
  const next = updateWorkspace(byWorkspace, workspaceId, updater)
  if (next === byWorkspace) return
  byWorkspace = next
  if (storage) writePanelMap(storage, byWorkspace)
  notify()
}

export function openWorkspaceSurface(workspaceId: string, kind: SingletonKind): void {
  apply(workspaceId, (state) => openSurface(state, kind))
}
export function toggleWorkspaceSurface(workspaceId: string, kind: SingletonKind): void {
  apply(workspaceId, (state) => toggleSurface(state, kind))
}
export function activateWorkspaceSurface(workspaceId: string, surfaceId: string): void {
  apply(workspaceId, (state) => activateSurface(state, surfaceId))
}
export function closeWorkspaceSurface(workspaceId: string, surfaceId: string): void {
  apply(workspaceId, (state) => closeSurface(state, surfaceId))
}
export function closeOtherWorkspaceSurfaces(workspaceId: string, surfaceId: string): void {
  apply(workspaceId, (state) => closeOtherSurfaces(state, surfaceId))
}
export function closeWorkspaceSurfacesToRight(workspaceId: string, surfaceId: string): void {
  apply(workspaceId, (state) => closeSurfacesToRight(state, surfaceId))
}
export function closeAllWorkspaceSurfaces(workspaceId: string): void {
  apply(workspaceId, closeAllSurfaces)
}
export function showWorkspacePanel(workspaceId: string): void {
  apply(workspaceId, showPanel)
}
export function closeWorkspacePanel(workspaceId: string): void {
  apply(workspaceId, closePanel)
}
export function toggleWorkspacePanelVisibility(workspaceId: string): void {
  apply(workspaceId, togglePanelVisibility)
}
/**
 * Delete-cascade for a REMOVED Workspace (#193 review; t3code `removeThread`): drop its
 * panel entry entirely so `side-panel:v2` accumulates no unreachable blobs — workspaceIds
 * are fresh UUIDs, so a removed Workspace's entry could never be read again. Called from
 * App's remove-Workspace flow beside its other localStorage cascades.
 */
export function removeWorkspacePanel(workspaceId: string): void {
  apply(workspaceId, () => EMPTY_PANEL_STATE)
}

/**
 * Bind the module store to one Workspace: a live, stable-reference `WorkspacePanelState`
 * via `useSyncExternalStore`. Its identity is stable across unrelated Workspaces' changes,
 * so the subscription doesn't loop.
 */
export function useWorkspacePanel(workspaceId: string): WorkspacePanelState {
  return useSyncExternalStore(
    subscribe,
    () => getWorkspacePanel(workspaceId),
    () => getWorkspacePanel(workspaceId),
  )
}

/**
 * Test-only reset so the module singleton doesn't leak state across tests. Pass a fake
 * storage to exercise persistence round-trips; pass `null` for a no-storage store; omit
 * to re-resolve `window.localStorage`.
 */
export function _resetSidePanelStore(fakeStorage?: PanelStorage | null): void {
  storage = fakeStorage === undefined ? resolveStorage() : fakeStorage
  byWorkspace = safeReadMap(storage)
  listeners.clear()
}
