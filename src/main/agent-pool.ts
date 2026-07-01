import { randomUUID } from 'node:crypto'
import type { WorkspaceAgent } from './workspace-agent'

/**
 * The warm-agent pool (ADR-0006 decision 3): one `vibe-acp` agent per OPEN
 * Workspace, keyed by Workspace directory. Selecting a Workspace lazily spawns its
 * agent on first need and then keeps it warm, so reselecting REUSES the same agent
 * (no second spawn, no re-handshake) and switching away never tears it down — a
 * Workspace's Threads keep streaming while the user looks elsewhere.
 *
 * This replaces the dispose-then-respawn model: the old `disposeAgentsForWorkspace`
 * dedup folds into the pool's reuse semantics (`acquire` returns the warm agent
 * rather than spawning a second). The pool is the single LIFECYCLE OWNER — it mints
 * the renderer-facing `agentId` handle, holds the agent, and is the only place an
 * agent is stopped (`dispose`/`disposeAll`).
 *
 * BOUNDED (TB5 #50): beyond spawn-once-and-reuse-per-Workspace, the pool tracks
 * per-agent activity (`lastActiveAt`, set on acquire/reuse + `touch`) and exposes
 * two pure policies — `evictIdle` (dispose agents idle past a timeout) and
 * `enforceCap` (LRU-trim the warm count) — that just call this pool's own `dispose`,
 * so all teardown stays here. Both honor an injected `isProtected` predicate so the
 * on-screen / mid-turn Workspace is never evicted (main supplies the real one), and
 * return the disposed agentIds so the caller re-warms the renderer transparently.
 *
 * The agent factory is injected (Seam B) so tests pool a fake — never a live
 * `vibe-acp`. Generic over the agent type for that reason; production wires
 * `WorkspaceAgent`.
 */

/** The minimal agent surface the pool owns: it only ever stops a warm agent. */
export interface PoolAgent {
  stop(): void
}

/** A warm agent plus its renderer-facing handle (the id the renderer prompts by). */
export interface PooledAgent<A extends PoolAgent> {
  agentId: string
  agent: A
}

/** The outcome of an `acquire`: the warm agent, plus whether THIS call spawned it. */
export interface AcquireResult<A extends PoolAgent> extends PooledAgent<A> {
  /**
   * True when this acquire SPAWNED the agent (first select of the Workspace) — the
   * caller must `start()` it and wire its `event` tee. False on a reuse (already
   * warm): start() is a no-op early-return and the tee is already wired.
   */
  created: boolean
}

interface PoolEntry<A extends PoolAgent> {
  agentId: string
  workspaceDir: string
  agent: A
  /**
   * Epoch-ms of this agent's last real activity (TB5 #50): set on `acquire`
   * (spawn AND reuse) and refreshed by `touch`. The idle-evict + LRU-cap policy
   * read it, so an in-use Workspace is always most-recently-active.
   */
  lastActiveAt: number
}

export interface AgentPoolOptions<A extends PoolAgent> {
  /** Spawn a fresh agent for a Workspace dir (injected; tests pass a fake). */
  createAgent: (workspaceDir: string) => A
  /** Mint the renderer-facing agent id (testing). Defaults to a random uuid. */
  mintId?: () => string
  /**
   * Clock for activity timestamps (TB5 #50), mirroring `MetadataStore`'s `now`
   * seam. Defaults to `Date.now` (available in main — only Workflow scripts lack
   * it). Tests inject a fake clock so eviction is exercised with NO real timers.
   */
  now?: () => number
  /**
   * How to tear an agent down when it leaves the pool (TB5 #50). Defaults to a
   * plain `agent.stop()` (the minimal `PoolAgent` surface, so the fake-agent tests
   * need nothing more). Production injects `(a) => void a.disposeGracefully()` so
   * eviction best-effort closes hosted sessions THEN terminates — asynchronously,
   * AFTER the pool's maps are already updated below, so consistency + re-warm are
   * unaffected. The pool never awaits this (fire-and-forget): lifecycle bookkeeping
   * stays synchronous while the child's clean shutdown finishes in the background.
   */
  disposeAgent?: (agent: A) => void
}

/** Inputs to the pure idle-evict policy (TB5 #50). */
export interface EvictIdleOptions {
  /** Dispose an agent idle (no activity) for at least this many ms. */
  idleMs: number
  /**
   * Protection predicate: an agent is NEVER evicted while this returns true —
   * main supplies the real one (the on-screen Workspace + any mid-turn agent),
   * keeping the pure logic testable. See the protection contract in #50.
   */
  isProtected: (agentId: string) => boolean
}

/** Inputs to the pure warm-count-cap policy (TB5 #50). */
export interface EnforceCapOptions {
  /** The maximum number of simultaneously-warm agents to keep. */
  maxWarm: number
  /** Protection predicate — see `EvictIdleOptions.isProtected`. */
  isProtected: (agentId: string) => boolean
}

export class AgentPool<A extends PoolAgent = WorkspaceAgent> {
  private readonly createAgent: (workspaceDir: string) => A
  private readonly mintId: () => string
  private readonly now: () => number
  private readonly disposeAgent: (agent: A) => void
  /** Warm agents keyed by the minted `agentId` (the renderer's handle). */
  private readonly byId = new Map<string, PoolEntry<A>>()
  /** Reverse index: Workspace dir -> `agentId`, for reuse + dir-scoped lookup. */
  private readonly byWorkspace = new Map<string, string>()

  constructor(options: AgentPoolOptions<A>) {
    this.createAgent = options.createAgent
    this.mintId = options.mintId ?? randomUUID
    this.now = options.now ?? Date.now
    this.disposeAgent = options.disposeAgent ?? ((agent) => agent.stop())
  }

  /**
   * Lazily spawn-or-reuse the warm agent for a Workspace dir. Returns the warm
   * agent + its handle and `created` (true only when this call spawned it). A
   * second acquire of the same dir takes the reuse branch — same id, same process,
   * `created: false` — so the caller never re-handshakes a warm Workspace.
   */
  acquire(workspaceDir: string): AcquireResult<A> {
    const existingId = this.byWorkspace.get(workspaceDir)
    if (existingId) {
      const entry = this.byId.get(existingId)
      if (entry) {
        // A reuse IS activity — refresh so a re-selected Workspace can't be
        // mistaken for idle and evicted out from under the user (TB5 #50).
        entry.lastActiveAt = this.now()
        return { agentId: entry.agentId, agent: entry.agent, created: false }
      }
    }
    const agentId = this.mintId()
    const agent = this.createAgent(workspaceDir)
    this.byId.set(agentId, { agentId, workspaceDir, agent, lastActiveAt: this.now() })
    this.byWorkspace.set(workspaceDir, agentId)
    return { agentId, agent, created: true }
  }

  /**
   * Mark an agent active NOW (TB5 #50) — main calls this on real activity beyond
   * acquire (a prompt, an open) so an in-use Workspace stays most-recently-active
   * and outranks idle ones under both the idle-evict and the LRU cap. An unknown
   * id is a no-op (the agent may have just been evicted/disposed).
   */
  touch(agentId: string): void {
    const entry = this.byId.get(agentId)
    if (entry) entry.lastActiveAt = this.now()
  }

  /**
   * Dispose every warm agent idle for at least `idleMs`, EXCEPT protected ones
   * (the on-screen / mid-turn agents — `isProtected`). Returns the disposed
   * agentIds so the caller can notify the renderer to drop the now-dead handles
   * (re-warm transparently on next select). A pure policy over the injected clock
   * — no real timers — so it's unit-testable without Electron.
   */
  evictIdle(opts: EvictIdleOptions): string[] {
    const cutoff = this.now() - opts.idleMs
    const stale: string[] = []
    for (const entry of this.byId.values()) {
      if (entry.lastActiveAt <= cutoff && !opts.isProtected(entry.agentId)) {
        stale.push(entry.agentId)
      }
    }
    for (const agentId of stale) this.dispose(agentId)
    return stale
  }

  /**
   * Bound the warm count to `maxWarm` (TB5 #50): while over the cap, dispose the
   * least-recently-active NON-protected agent. Returns the disposed agentIds.
   * Protection WINS — if the only over-cap candidates are protected (on-screen or
   * mid-turn), we stop and stay over cap rather than kill an in-use agent; the
   * next acquire (or the next sweep, once it's unprotected) trims it. Called after
   * each `acquire`, so the just-warmed agent — most-recently-active — is never the
   * one trimmed.
   */
  enforceCap(opts: EnforceCapOptions): string[] {
    const evicted: string[] = []
    while (this.byId.size > opts.maxWarm) {
      let victim: PoolEntry<A> | null = null
      for (const entry of this.byId.values()) {
        if (opts.isProtected(entry.agentId)) continue
        if (!victim || entry.lastActiveAt < victim.lastActiveAt) victim = entry
      }
      // No unprotected candidate: every over-cap agent is in use — protection
      // wins, leave them warm (the caller logs/notes the over-cap, see #50).
      if (!victim) break
      this.dispose(victim.agentId)
      evicted.push(victim.agentId)
    }
    return evicted
  }

  /** The warm agent for a renderer `agentId` handle, or null when none. */
  get(agentId: string): A | null {
    return this.byId.get(agentId)?.agent ?? null
  }

  /**
   * The minted `agentId` currently warm for a Workspace dir, or null when none is
   * (never selected, evicted, or disposed). A thin reverse-index read used by
   * "Remove project" to find the warm agent to stop before removing our records —
   * distinct from `getByWorkspace` in returning just the handle (no agent).
   */
  agentIdForWorkspace(workspaceDir: string): string | null {
    return this.byWorkspace.get(workspaceDir) ?? null
  }

  /** The warm agent + id for a Workspace dir, or null when none is warm. */
  getByWorkspace(workspaceDir: string): PooledAgent<A> | null {
    const agentId = this.byWorkspace.get(workspaceDir)
    if (!agentId) return null
    const entry = this.byId.get(agentId)
    return entry ? { agentId: entry.agentId, agent: entry.agent } : null
  }

  /** Every warm agent (for fan-out like best-effort session close on delete). */
  agents(): A[] {
    return [...this.byId.values()].map((e) => e.agent)
  }

  /**
   * Stop + drop one warm agent by id (explicit close — `stopAgent`, or the TB5
   * evictor). Idempotent: an unknown id is a no-op. After this the Workspace
   * re-warms transparently on its next select (nothing user-visible is lost — the
   * metadata + JSONL survive, ADR-0005).
   */
  dispose(agentId: string): void {
    const entry = this.byId.get(agentId)
    if (!entry) return
    // Update the maps FIRST (synchronously) so the pool is consistent the instant
    // dispose returns — `get`/`getByWorkspace` already miss this id, and a re-warm
    // `acquire` spawns a fresh agent — THEN tear the old agent down (which may be
    // async + best-effort `session/close` via the injected disposer, TB5 #50).
    this.byId.delete(agentId)
    this.byWorkspace.delete(entry.workspaceDir)
    this.disposeAgent(entry.agent)
  }

  /** Stop + drop every warm agent (app quit). */
  disposeAll(): void {
    for (const entry of this.byId.values()) entry.agent.stop()
    this.byId.clear()
    this.byWorkspace.clear()
  }
}
