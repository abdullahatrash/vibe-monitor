import { coerceExpandedSurface, type ExpandedSurface } from './surface-model'

/**
 * Which Surface is expanded PER Workspace (ADR-0013 decision 1) — a renderer-only,
 * display-only choice that survives restart. Like the sidebar-collapsed flag (#127) and
 * the open-projects set (#138), it is pure UI chrome (it never spawns an agent or touches
 * persistence), so it lives in localStorage alone via the established injected-storage,
 * throw-tolerant pattern: no IPC, no main.
 *
 * Stored as a single JSON object keyed by workspaceId; a collapsed (`null`) Workspace is
 * OMITTED from the map. Any malformed / absent / throwing store degrades to `null` (the
 * card stack) so a blocked store never traps a Surface open or shut.
 */

/** The single localStorage key holding the per-Workspace expanded-Surface map. */
export const SURFACE_STATE_STORAGE_KEY = 'vibe-mistro:surface-state:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface SurfaceStateStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The whole persisted map, defensively coerced: a non-object payload, or a member that
 * isn't a live Surface, is dropped. Throws only if the store's `getItem`/`JSON.parse`
 * throws — callers wrap in try/catch and fall back to `{}`.
 */
function readMap(storage: SurfaceStateStorage): Record<string, Exclude<ExpandedSurface, null>> {
  const raw = storage.getItem(SURFACE_STATE_STORAGE_KEY)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, Exclude<ExpandedSurface, null>> = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const surface = coerceExpandedSurface(value)
    if (surface) out[id] = surface
  }
  return out
}

/**
 * The expanded Surface for a Workspace, or `null` when absent / unknown / unavailable.
 * Never throws — a blocked/throwing/corrupt store must not trap the panel shut.
 */
export function getSurfaceState(
  storage: SurfaceStateStorage | null | undefined,
  workspaceId: string,
): ExpandedSurface {
  if (!storage) return null
  try {
    return readMap(storage)[workspaceId] ?? null
  } catch {
    return null
  }
}

/**
 * Persist a Workspace's expanded Surface best-effort; a `null` clears its entry (so a
 * collapsed Workspace leaves no stale blob). A quota/security exception is swallowed.
 */
export function setSurfaceState(
  storage: SurfaceStateStorage | null | undefined,
  workspaceId: string,
  surface: ExpandedSurface,
): void {
  if (!storage) return
  try {
    const map = readMap(storage)
    if (surface) map[workspaceId] = surface
    else delete map[workspaceId]
    storage.setItem(SURFACE_STATE_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a Surface toggle.
  }
}
