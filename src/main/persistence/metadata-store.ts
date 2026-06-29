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
   */
  async load(): Promise<void> {
    try {
      const raw = await this.readFileFn(this.filePath)
      const parsed = JSON.parse(raw) as Partial<MetadataSnapshot>
      this.state = {
        workspaces: (Array.isArray(parsed.workspaces) ? parsed.workspaces : []).filter(
          isWorkspaceRecord,
        ),
        threads: (Array.isArray(parsed.threads) ? parsed.threads : []).filter(isThreadRecord),
      }
    } catch {
      this.state = { workspaces: [], threads: [] }
    }
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
   * `sessionId` resume cursor) — instead of creating a second record.
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
    }
    this.state.threads = [record, ...this.state.threads.filter((t) => t.id !== record.id)]
    await this.persist()
    return record
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
   */
  private async persist(): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    await this.writeFileFn(tmp, JSON.stringify(this.state, null, 2))
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
