import { readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { ThreadMeta, WorkspaceMeta, WorkspaceThreads } from '../../shared/ipc'

/**
 * Main-side persistence of Workspace + Thread METADATA (ADR-0005: vibe owns the
 * transcript; we own a light, metadata-first index so the app can show a cold,
 * read-only Workspace/Thread list on launch with NO `vibe-acp` process spawned).
 *
 * Single-writer: only the main process mutates this. The fs/path is an injected
 * seam (deps) so tests run over a temp-dir file without touching real `userData`,
 * mirroring the fs-read/fs-write handlers. A corrupt or missing file degrades to
 * empty state — never a throw — so a bad index can't wedge launch.
 *
 * SEAM CONTRACT (ADR-0005 hardening): this class is the ONLY reader/writer of the
 * metadata file. No other module may derive its path or touch it directly — the
 * `userData` path is single-sourced in `src/main/index.ts` and injected here. Keep
 * it that way so the JSON→SQLite swap (ADR-0005 defers it) stays a drop-in: swap
 * this class's body behind the same public methods + injected `deps`.
 *
 * SCHEMA VERSIONING: the file is a versioned envelope
 * (`{ schemaVersion, workspaces, threads }`). Legacy files predate the envelope and
 * are read as v1. A file whose version is NEWER than this build FAILS CLOSED: we
 * refuse to load it AND refuse to overwrite it (see `load`/`persist`), so an older
 * build can never atomically wipe history written by a newer one.
 */

/**
 * The record shapes are the cross-boundary `WorkspaceMeta` / `ThreadMeta`
 * (declared in shared/ipc.ts, since the renderer renders them). Aliased here so
 * the store reads naturally.
 */
export type WorkspaceRecord = WorkspaceMeta
export type ThreadRecord = ThreadMeta

/** The full persisted index (flat). Grouped for the renderer by the helper below. */
export interface MetadataSnapshot {
  workspaces: WorkspaceRecord[]
  threads: ThreadRecord[]
}

/**
 * The on-disk schema version of the metadata envelope. Bump ONLY on a
 * backward-incompatible layout change, and add a migration branch in `load()`
 * for the older version(s). A file with a HIGHER version than this constant is
 * refused (fail-closed) rather than migrated down.
 */
export const METADATA_SCHEMA_VERSION = 1

/**
 * The persisted envelope: the flat index wrapped with its `schemaVersion`.
 * `workspaces`/`threads` are typed `unknown` because `load()` must tolerate an
 * arbitrary/corrupt shape before its per-record guards run.
 */
interface PersistedIndex {
  schemaVersion?: number
  workspaces?: unknown
  threads?: unknown
}

/** Upsert a Workspace by its `dir` (the natural key); mints `id` when new. */
export interface WorkspaceInput {
  dir: string
  displayName?: string
  /** Override the open timestamp (testing). Defaults to `now()`. */
  lastOpenedAt?: number
}

/** Add/update a Thread; `id` re-targets an existing Thread, else one is minted. */
export interface ThreadInput {
  id?: string
  workspaceId: string
  sessionId?: string | null
  title?: string | null
  createdAt?: number
  lastActiveAt?: number
  /** Pin flag (#132) — may be seeded here, but the primary toggle is `setThreadFlags`. */
  pinned?: boolean
  /** Archive flag (#133) — may be seeded here, but the primary toggle is `setThreadFlags`. */
  archived?: boolean
}

/**
 * The injectable seam: where the JSON lives and how to read/write it, plus the
 * clock and id source. Production wires `node:fs/promises` + `crypto.randomUUID`
 * and a `userData` path; tests pass a temp file (and may pin `now`/`mintId`).
 */
export interface MetadataStoreDeps {
  /** Absolute path to the JSON index file. */
  filePath: string
  readFile?: (path: string) => Promise<string>
  writeFile?: (path: string, data: string) => Promise<void>
  /** Atomic move of the temp file over the target. Defaults to `fs.rename`. */
  rename?: (from: string, to: string) => Promise<void>
  now?: () => number
  mintId?: () => string
}

export class MetadataStore {
  private readonly filePath: string
  private readonly readFileFn: (path: string) => Promise<string>
  private readonly writeFileFn: (path: string, data: string) => Promise<void>
  private readonly renameFn: (from: string, to: string) => Promise<void>
  private readonly now: () => number
  private readonly mintId: () => string
  private state: MetadataSnapshot = { workspaces: [], threads: [] }
  /**
   * Set when `load()` saw a file written by a NEWER schema version. While locked,
   * `persist()` is a no-op so we never overwrite (and thus destroy) data this
   * build can't safely parse. Exposed via `isLocked()` so the caller can surface
   * an honest "upgrade to open your data" notice instead of showing empty.
   */
  private locked = false

  constructor(deps: MetadataStoreDeps) {
    this.filePath = deps.filePath
    this.readFileFn = deps.readFile ?? ((path) => readFile(path, 'utf8'))
    this.writeFileFn = deps.writeFile ?? ((path, data) => writeFile(path, data, 'utf8'))
    this.renameFn = deps.rename ?? rename
    this.now = deps.now ?? Date.now
    this.mintId = deps.mintId ?? randomUUID
  }

  /**
   * Read the index into memory. A missing/unparseable file yields empty state;
   * a parseable-but-partially-malformed file degrades to its VALID subset —
   * each record is shape-checked so a single bad entry (e.g. a `null` thread)
   * can't later crash `snapshot()`/`groupThreadsByWorkspace`. Never throws.
   *
   * FAIL-CLOSED on a future version: if the file's `schemaVersion` is newer than
   * this build understands, we DON'T degrade to empty (which would let the next
   * `persist()` atomically overwrite real data) — we lock the store instead, so
   * the newer file is preserved untouched until an upgraded build reads it.
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await this.readFileFn(this.filePath)
    } catch {
      // Missing/unreadable file — the normal first-run case. Start empty; a file
      // that never existed carries no version, so this is NOT a lock condition.
      this.state = { workspaces: [], threads: [] }
      return
    }

    let parsed: PersistedIndex
    try {
      parsed = JSON.parse(raw) as PersistedIndex
    } catch {
      // Unparseable JSON (a torn write or hand-edit) has no trustworthy version.
      // Degrade to empty as before — locking here would wedge launch forever on
      // genuine corruption. (Versioned fail-closed applies only to WELL-FORMED
      // files that declare a newer version.)
      this.state = { workspaces: [], threads: [] }
      return
    }

    // Legacy files predate the envelope and carry no `schemaVersion` — they ARE
    // v1 by definition, so a missing/non-numeric version reads as the current one.
    const version =
      typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : METADATA_SCHEMA_VERSION
    if (version > METADATA_SCHEMA_VERSION) {
      this.locked = true
      this.state = { workspaces: [], threads: [] }
      console.error(
        `[MetadataStore] ${this.filePath} is schemaVersion ${version}; this build supports ` +
          `${METADATA_SCHEMA_VERSION}. Refusing to load or overwrite it to avoid destroying ` +
          `data written by a newer version of vibe-mistro. Upgrade to open these Workspaces/Threads.`,
      )
      return
    }

    this.state = {
      workspaces: (Array.isArray(parsed.workspaces) ? parsed.workspaces : []).filter(
        isWorkspaceRecord,
      ),
      threads: (Array.isArray(parsed.threads) ? parsed.threads : [])
        .filter(isThreadRecord)
        .map(normalizeThreadFlags),
    }
  }

  /**
   * Whether the store is locked because the on-disk file was written by a newer
   * schema version (see `load`). Callers should surface an honest "upgrade to
   * open your data" notice rather than presenting the empty state as real.
   */
  isLocked(): boolean {
    return this.locked
  }

  /**
   * Upsert the Workspace keyed by `dir` (the natural key): re-opening a known
   * dir refreshes `lastOpenedAt` (and `displayName`) on the SAME record rather
   * than duplicating it. Returns the new or updated record.
   */
  async upsertWorkspace(input: WorkspaceInput): Promise<WorkspaceRecord> {
    const existing = this.state.workspaces.find((w) => w.dir === input.dir)
    const record: WorkspaceRecord = {
      id: existing?.id ?? this.mintId(),
      dir: input.dir,
      displayName: input.displayName ?? existing?.displayName ?? input.dir,
      lastOpenedAt: input.lastOpenedAt ?? this.now(),
    }
    this.state.workspaces = [record, ...this.state.workspaces.filter((w) => w.dir !== input.dir)]
    await this.persist()
    return record
  }

  /**
   * Add or update a Thread. A matching `id` re-targets the existing Thread —
   * preserving its `createdAt` while refreshing `lastActiveAt` (and the
   * `sessionId` resume cursor) — instead of creating a second record. The
   * per-Thread flags (`pinned`/`archived`, #132/#133) are PRESERVED across a
   * re-target too, so a routine activity-upsert never clears a pin/archive; they
   * change only when explicitly passed here or (the primary path) via
   * `setThreadFlags`.
   */
  async upsertThread(input: ThreadInput): Promise<ThreadRecord> {
    const ts = this.now()
    const existing = input.id ? this.state.threads.find((t) => t.id === input.id) : undefined
    const record: ThreadRecord = {
      id: existing?.id ?? input.id ?? this.mintId(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      title: input.title ?? existing?.title ?? null,
      createdAt: input.createdAt ?? existing?.createdAt ?? ts,
      lastActiveAt: input.lastActiveAt ?? ts,
      pinned: input.pinned ?? existing?.pinned,
      archived: input.archived ?? existing?.archived,
    }
    this.state.threads = [record, ...this.state.threads.filter((t) => t.id !== record.id)]
    await this.persist()
    return record
  }

  /**
   * Toggle a Thread's per-Thread flags (#132 pin / #133 archive) on its metadata
   * record, keyed by minted `id`. Patches ONLY the provided flag(s) — the other is
   * left untouched — and holds the record's list POSITION (a flag change is not
   * activity, so it does not re-order like an upsert). An unknown id is a no-op
   * with NO write. Persisted atomically like the upserts; flags round-trip through
   * `load`, so a pin/archive survives reopen/eviction (ADR-0005).
   */
  async setThreadFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void> {
    const existing = this.state.threads.find((t) => t.id === id)
    if (!existing) return // unknown id — nothing to patch, no disk write
    const updated: ThreadRecord = {
      ...existing,
      ...(flags.pinned !== undefined ? { pinned: flags.pinned } : {}),
      ...(flags.archived !== undefined ? { archived: flags.archived } : {}),
    }
    this.state.threads = this.state.threads.map((t) => (t.id === id ? updated : t))
    await this.persist()
  }

  /**
   * Remove a Thread record by its minted `id` (TB6 #35). Idempotent: an unknown
   * id (or an already-deleted Thread) is a no-op — the filter simply matches
   * nothing — so deleting twice never throws. The JSONL transcript + any live ACP
   * session are torn down by the caller (best-effort, ADR-0005); this owns only
   * our metadata record. Persisted atomically like the upserts.
   */
  async deleteThread(id: string): Promise<void> {
    const before = this.state.threads.length
    this.state.threads = this.state.threads.filter((t) => t.id !== id)
    // Only rewrite the index when something actually changed — an unknown-id
    // delete touches no record and needs no disk write.
    if (this.state.threads.length !== before) await this.persist()
  }

  /**
   * Resolve a Thread's minted `id` from its bound ACP `sessionId` (TB2 transcript
   * routing). Events flow keyed by `sessionId`, but the JSONL is keyed by the
   * minted Thread `id`; this bridges the two. A null/unmatched session is `null`
   * (a `null`-session Thread never matches), so the caller can skip the tee.
   */
  findThreadIdBySessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId) return null
    return this.state.threads.find((t) => t.sessionId === sessionId)?.id ?? null
  }

  /**
   * The current in-memory index, most-recent-first (Workspaces by
   * `lastOpenedAt`, Threads by `lastActiveAt`) — the order the renderer lists.
   */
  snapshot(): MetadataSnapshot {
    return {
      workspaces: [...this.state.workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
      threads: [...this.state.threads].sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    }
  }

  /**
   * Write the index to a temp file then `rename` it over the target — atomic on
   * POSIX, so a crash mid-write can't truncate/corrupt the index (a corrupt
   * index loads empty = silent total data loss). Residual: with a single writer
   * (main) this is safe; truly-concurrent writers would be last-rename-wins —
   * revisit if write frequency rises (TB2). No write queue/mutex for now.
   *
   * Wraps the state in the versioned envelope. NO-OP while locked: a store that
   * loaded a newer-version file must never write, so the newer on-disk data is
   * preserved (in-memory mutations are intentionally non-durable in that state).
   */
  private async persist(): Promise<void> {
    if (this.locked) return
    const tmp = `${this.filePath}.tmp`
    const envelope: PersistedIndex = {
      schemaVersion: METADATA_SCHEMA_VERSION,
      workspaces: this.state.workspaces,
      threads: this.state.threads,
    }
    await this.writeFileFn(tmp, JSON.stringify(envelope, null, 2))
    await this.renameFn(tmp, this.filePath)
  }
}

/** Well-formed-Workspace guard for `load()` — drops malformed persisted entries. */
function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  const w = value as Record<string, unknown> | null
  return (
    !!w &&
    typeof w.id === 'string' &&
    typeof w.dir === 'string' &&
    typeof w.displayName === 'string' &&
    typeof w.lastOpenedAt === 'number'
  )
}

/** Well-formed-Thread guard for `load()` — drops malformed persisted entries. */
function isThreadRecord(value: unknown): value is ThreadRecord {
  const t = value as Record<string, unknown> | null
  return (
    !!t &&
    typeof t.id === 'string' &&
    typeof t.workspaceId === 'string' &&
    typeof t.createdAt === 'number' &&
    typeof t.lastActiveAt === 'number'
  )
}

/**
 * Coerce a loaded Thread's optional flags (#132/#133) to strict booleans: a stored
 * `pinned`/`archived` that isn't literally `true` (a stale non-boolean, or absent)
 * normalizes to `undefined` (= false). Keeps the in-memory shape honest so the
 * renderer's `orderByPin`/`partitionArchived` never see a truthy non-boolean.
 */
function normalizeThreadFlags(t: ThreadRecord): ThreadRecord {
  return {
    ...t,
    pinned: t.pinned === true ? true : undefined,
    archived: t.archived === true ? true : undefined,
  }
}

/**
 * Nest each Workspace's Threads under it for the renderer's cold launch list,
 * both ordered most-recent-first. Pure (no I/O) so it's unit-tested directly.
 * Threads whose Workspace is absent (an orphan after a Workspace was dropped)
 * are skipped rather than surfaced loose.
 */
export function groupThreadsByWorkspace(snapshot: MetadataSnapshot): WorkspaceThreads[] {
  const workspaces = [...snapshot.workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  const threads = [...snapshot.threads].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return workspaces.map((w) => ({
    ...w,
    threads: threads.filter((t) => t.workspaceId === w.id),
  }))
}
