import type { GitStatus, GitStatusEvent, GitStatusKind } from '../../shared/ipc'

/**
 * The streamed git-status manager (#84, ADR-0008). Per `workspaceDir` it ref-counts
 * subscribers and, while at least one is held, runs ONE debounced fs watcher (local
 * edits) + ONE background `git fetch` interval (remote ahead/behind) — the same
 * resource discipline as the warm-agent cap (ADR-0006): active-Workspace-only, one
 * watcher + one fetch. The renderer's mounted Changes panel is the only subscriber,
 * so subscribe-on-mount / unsubscribe-on-switch keeps it bounded by construction.
 *
 * All side-effecting deps are INJECTED (read / fetch / watch / clock / emit) so the
 * load-bearing lifecycle — ref-count start/stop, debounce, fetch TTL, teardown — is
 * unit-testable without shelling git or touching the real fs / electron. The index.ts
 * glue wires `emit` to `webContents.send` (this module never imports electron),
 * mirroring `emitThreadStatus`.
 */

/** Opaque timer handle — the real clock returns Node timers; tests return fakes. */
export type TimerHandle = unknown

/** The clock seam (setTimeout for debounce, setInterval for the fetch TTL). */
export interface Clock {
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

/** A started fs watcher this manager can later close (the chokidar surface it uses). */
export interface WatcherLike {
  close(): void | Promise<void>
}

/** Start watching `workspaceDir`, calling `onChange` on each (non-ignored) fs event. */
export type WatchFactory = (workspaceDir: string, onChange: () => void) => WatcherLike

/** Push one status event to the renderer(s). Wired to `webContents.send` in index.ts. */
export type EmitStatus = (event: GitStatusEvent) => void

export interface GitStatusManagerDeps {
  read: (workspaceDir: string) => Promise<GitStatus>
  fetch: (workspaceDir: string) => Promise<void>
  watch: WatchFactory
  clock: Clock
  emit: EmitStatus
  /** fs-watcher debounce before a re-read (default 250ms). */
  debounceMs?: number
  /** Background fetch TTL — re-fetch + re-read this often while subscribed (default 15s). */
  fetchIntervalMs?: number
}

interface Entry {
  count: number
  watcher: WatcherLike
  fetchTimer: TimerHandle
  debounceTimer: TimerHandle | null
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_FETCH_INTERVAL_MS = 15_000

export class GitStatusManager {
  private readonly entries = new Map<string, Entry>()
  private readonly debounceMs: number
  private readonly fetchIntervalMs: number

  constructor(private readonly deps: GitStatusManagerDeps) {
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.fetchIntervalMs = deps.fetchIntervalMs ?? DEFAULT_FETCH_INTERVAL_MS
  }

  /**
   * Add a subscriber for `workspaceDir`. The FIRST starts the fs watcher + the fetch
   * interval; later ones only bump the ref-count (no 2nd watcher). Every subscribe
   * emits a fresh `snapshot` so the newly-mounted panel renders current state.
   */
  subscribe(workspaceDir: string): void {
    let entry = this.entries.get(workspaceDir)
    if (!entry) {
      const watcher = this.deps.watch(workspaceDir, () => this.onLocalChange(workspaceDir))
      const fetchTimer = this.deps.clock.setInterval(() => void this.onFetch(workspaceDir), this.fetchIntervalMs)
      entry = { count: 0, watcher, fetchTimer, debounceTimer: null }
      this.entries.set(workspaceDir, entry)
    }
    entry.count++
    void this.emitRead(workspaceDir, 'snapshot')
  }

  /** Drop one subscriber. The LAST tears the watcher + fetch timer down; else no-op. */
  unsubscribe(workspaceDir: string): void {
    const entry = this.entries.get(workspaceDir)
    if (!entry) return
    entry.count--
    if (entry.count > 0) return
    this.teardown(workspaceDir, entry)
  }

  /**
   * Force a `localUpdated` re-read for a SUBSCRIBED Workspace (the turn-end trigger +
   * the panel's manual Refresh). No-op when not subscribed — there's no panel to push
   * to. The turn-end case catches the agent's OWN git commands (a commit changes
   * `.git/`, which the working-tree watcher ignores).
   */
  refresh(workspaceDir: string): void {
    if (!this.entries.has(workspaceDir)) return
    void this.emitRead(workspaceDir, 'localUpdated')
  }

  /** Tear every subscription down (app quit) — no watcher or timer outlives the app. */
  disposeAll(): void {
    for (const [workspaceDir, entry] of [...this.entries]) this.teardown(workspaceDir, entry)
  }

  /** Whether a Workspace currently has any subscriber (test/diagnostic helper). */
  isSubscribed(workspaceDir: string): boolean {
    return this.entries.has(workspaceDir)
  }

  /** Debounce an fs-watcher burst into a single `localUpdated` re-read. */
  private onLocalChange(workspaceDir: string): void {
    const entry = this.entries.get(workspaceDir)
    if (!entry) return
    if (entry.debounceTimer != null) this.deps.clock.clearTimeout(entry.debounceTimer)
    entry.debounceTimer = this.deps.clock.setTimeout(() => {
      entry.debounceTimer = null
      void this.emitRead(workspaceDir, 'localUpdated')
    }, this.debounceMs)
  }

  /** Background fetch tick: best-effort `git fetch`, then a `remoteUpdated` re-read. */
  private async onFetch(workspaceDir: string): Promise<void> {
    if (!this.entries.has(workspaceDir)) return
    await this.deps.fetch(workspaceDir)
    if (!this.entries.has(workspaceDir)) return // unsubscribed during the fetch
    await this.emitRead(workspaceDir, 'remoteUpdated')
  }

  /** Read status and emit it, unless the Workspace was unsubscribed during the read. */
  private async emitRead(workspaceDir: string, kind: GitStatusKind): Promise<void> {
    const status = await this.deps.read(workspaceDir)
    if (!this.entries.has(workspaceDir)) return
    this.deps.emit({ workspaceDir, kind, status })
  }

  private teardown(workspaceDir: string, entry: Entry): void {
    if (entry.debounceTimer != null) this.deps.clock.clearTimeout(entry.debounceTimer)
    this.deps.clock.clearInterval(entry.fetchTimer)
    void entry.watcher.close()
    this.entries.delete(workspaceDir)
  }
}
