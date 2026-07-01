/**
 * Per-Workspace agent-controls cache (#153): the option lists (+ current values) for
 * a Workspace's Mode / Model / Reasoning-effort pickers, as the LAST bound session
 * reported them. The picker option lists are Vibe-owned and surfaced ONLY by
 * `session/new` / `session/load`; by ADR-0011's lazy binding we open NO ACP session
 * until a Thread's first prompt, so a never-prompted draft's connection advertises
 * all-null controls and `AgentControls` renders nothing. Caching the last bound
 * bundle lets a fresh draft show the picker immediately, standing in until its own
 * first prompt binds and the REAL session values self-correct (the bound path wins;
 * this cache is read only in the draft branch, before `configFor` is seeded).
 *
 * Like the composer drafts (#60), open-projects (#138), and sidebar-collapsed state,
 * this is renderer-only display state, so it lives in localStorage alone: no IPC, no
 * main, no persistence store, no new ACP session. A pure module over an INJECTED
 * storage seam — tests pass a fake and render code passes `window.localStorage`.
 * Reading must never throw into a render and writing must never throw from a bind, so
 * both paths swallow a malformed blob, an absent key, and a quota/security exception.
 */

import type { ThreadAgentControls } from '../../../shared/ipc'

/** The single localStorage key holding the `workspaceKey -> controls` map. */
export const WORKSPACE_CONTROLS_STORAGE_KEY = 'vibe-mistro:workspace-controls:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface WorkspaceControlsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The persisted shape: a workspace key -> its cached agent-controls bundle. */
type ControlsMap = Record<string, ThreadAgentControls>

/**
 * The map key for a Workspace's cached controls: prefer the persisted `workspaceId`,
 * but fall back to the `workspaceDir` when `workspaceId` is absent — a draft opened in
 * degraded / no-store mode has no minted id yet. A Workspace uses one or the other for
 * a session, so a mid-flight id/dir switch is at worst a cache miss (acceptable — a
 * miss just falls back to today's cold behavior).
 */
export function workspaceControlsKey(workspaceId: string | null, workspaceDir: string): string {
  return workspaceId ? workspaceId : workspaceDir
}

/**
 * Read one axis from a raw entry, keeping it ONLY when it's an object whose list field
 * (the array `AgentControls` maps over) is actually an array. A stale/older-shaped/
 * tampered axis like `{}` (object but no `availableModes`) is nulled out rather than
 * passed through — the picker calls `.map()` on that list unguarded, so an axis missing
 * its array would throw in render. `listKey` is the axis's array field name.
 */
function readAxis(v: Record<string, unknown>, key: string, listKey: string): unknown {
  const raw = v[key]
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  return Array.isArray((raw as Record<string, unknown>)[listKey]) ? raw : null
}

/**
 * Normalize an unknown stored entry to a valid three-axis bundle: a non-object entry
 * is rejected (null), and any missing/non-object/list-less axis defaults to null. Keeps
 * a stale or older-shaped blob from ever surfacing a malformed control to the picker.
 */
function normalizeControls(value: unknown): ThreadAgentControls | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  return {
    modes: readAxis(v, 'modes', 'availableModes') as ThreadAgentControls['modes'],
    models: readAxis(v, 'models', 'availableModels') as ThreadAgentControls['models'],
    reasoningEffort: readAxis(v, 'reasoningEffort', 'options') as ThreadAgentControls['reasoningEffort'],
  }
}

/**
 * Read + parse the controls map, tolerating everything: an unavailable storage, an
 * absent key, a parse error, or a non-object blob all yield an empty map. Never throws
 * — a corrupt entry must not break a draft's render.
 */
function readMap(storage: WorkspaceControlsStorage | null | undefined): ControlsMap {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(WORKSPACE_CONTROLS_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as ControlsMap
  } catch {
    return {}
  }
}

/**
 * Persist the controls map best-effort: a quota/security exception is swallowed. When
 * the map is empty the whole key is REMOVED (not stored as `'{}'`), so an emptied store
 * leaves no dangling blob behind.
 */
function writeMap(storage: WorkspaceControlsStorage, map: ControlsMap): void {
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(WORKSPACE_CONTROLS_STORAGE_KEY)
      return
    }
    storage.setItem(WORKSPACE_CONTROLS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a bind.
  }
}

/**
 * The cached controls for a Workspace, or null when absent/malformed. Never throws —
 * the draft branch reads this to stand in for the not-yet-bound session's controls.
 */
export function getWorkspaceControls(
  storage: WorkspaceControlsStorage | null | undefined,
  key: string,
): ThreadAgentControls | null {
  const entry = readMap(storage)[key]
  return entry === undefined ? null : normalizeControls(entry)
}

/**
 * Cache a Workspace's controls (patching just that key, leaving other Workspaces
 * intact) — called on `thread:bound` when the session reports a non-null bundle so the
 * next draft in this Workspace shows the picker. Best-effort; a store failure is a
 * silent no-op (the picker just stays cold until the next bind).
 */
export function setWorkspaceControls(
  storage: WorkspaceControlsStorage | null | undefined,
  key: string,
  controls: ThreadAgentControls,
): void {
  if (!storage) return
  // Skip an all-null bundle so caching stays MONOTONIC: a degraded bind/resume that
  // reports no axes must not clobber a Workspace's already-good cache (which would send
  // the next draft back to a cold, picker-less state). An all-null bundle caches nothing
  // useful anyway — the draft branch renders nothing from it.
  if (!controls.modes && !controls.models && !controls.reasoningEffort) return
  const map = readMap(storage)
  map[key] = controls
  writeMap(storage, map)
}
