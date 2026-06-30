/**
 * Per-Thread composer drafts (#60): the unsent text in a Thread's composer, kept
 * so it survives any unmount — a cold↔live transition, an agent eviction/re-warm
 * (TB5 #56), an app restart, or switching to a non-mounted cold Thread. The draft
 * is EPHEMERAL UI state, so it lives in localStorage ONLY: no IPC, no main, no
 * JSONL (those persist the transcript, not the half-typed prompt). Keyed by the
 * durable renderer-minted Thread id (#58 hands us one up front), so a single key
 * space covers both unsent-draft Threads and persisted ones.
 *
 * A pure module over an INJECTED storage seam (like `thread-status.ts` /
 * `workspace-threads.ts`): every function takes the storage, so tests pass a fake
 * and render code passes `window.localStorage`. Reading must never throw into a
 * render and writing must never throw from a keystroke, so both paths swallow a
 * malformed blob, an absent key, and a quota/security exception.
 */

/** The single localStorage key holding the `threadId -> text` map. */
export const COMPOSER_DRAFT_STORAGE_KEY = 'vibe-mistro:composer-drafts:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The persisted shape: a thread id -> unsent text map. */
type DraftMap = Record<string, string>

/**
 * Read + parse the draft map, tolerating everything: an unavailable storage, an
 * absent key, a parse error, or a non-object blob all yield an empty map. Never
 * throws — a corrupt entry must not break the composer's render.
 */
function readMap(storage: DraftStorage | null | undefined): DraftMap {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as DraftMap
  } catch {
    return {}
  }
}

/**
 * Persist the draft map best-effort: a quota/security exception is swallowed. When
 * the last draft is pruned the whole key is REMOVED (not stored as `'{}'`), so an
 * emptied store leaves no dangling blob behind.
 */
function writeMap(storage: DraftStorage, map: DraftMap): void {
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY)
      return
    }
    storage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a keystroke.
  }
}

/** The stored draft for a Thread, or '' when absent/malformed. Never throws. */
export function getDraft(storage: DraftStorage | null | undefined, threadId: string): string {
  const text = readMap(storage)[threadId]
  return typeof text === 'string' ? text : ''
}

/**
 * Write a Thread's unsent text. The RAW text is stored verbatim (a trailing space
 * the user is mid-typing is preserved), but an effectively-empty draft is PRUNED
 * rather than stored as '' so blank entries never accumulate — the prune DECISION
 * is the only place we trim. A no-op (already-stored value, or pruning an absent
 * entry) skips the write.
 */
export function setDraft(
  storage: DraftStorage | null | undefined,
  threadId: string,
  text: string,
): void {
  if (!storage) return
  const map = readMap(storage)
  if (text.trim().length === 0) {
    if (!(threadId in map)) return
    delete map[threadId]
    writeMap(storage, map)
    return
  }
  if (map[threadId] === text) return
  map[threadId] = text
  writeMap(storage, map)
}

/**
 * Drop a Thread's draft entry — used on send (the text is now in the transcript)
 * and on delete (no orphaned composer text). Skips the write when absent.
 */
export function clearDraft(storage: DraftStorage | null | undefined, threadId: string): void {
  if (!storage) return
  const map = readMap(storage)
  if (!(threadId in map)) return
  delete map[threadId]
  writeMap(storage, map)
}
