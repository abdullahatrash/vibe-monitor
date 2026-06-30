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
 * Bounded only by spawn-once-and-reuse-per-Workspace here (unbounded warm count is
 * fine for this slice). Idle-eviction and a warm-count cap are TB5 (#50): they hook
 * in HERE — the pool owning lifecycle is the seam, so eviction will just call this
 * pool's own `dispose` on an LRU/idle policy without scattering teardown elsewhere.
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
}

export interface AgentPoolOptions<A extends PoolAgent> {
  /** Spawn a fresh agent for a Workspace dir (injected; tests pass a fake). */
  createAgent: (workspaceDir: string) => A
  /** Mint the renderer-facing agent id (testing). Defaults to a random uuid. */
  mintId?: () => string
}

export class AgentPool<A extends PoolAgent = WorkspaceAgent> {
  private readonly createAgent: (workspaceDir: string) => A
  private readonly mintId: () => string
  /** Warm agents keyed by the minted `agentId` (the renderer's handle). */
  private readonly byId = new Map<string, PoolEntry<A>>()
  /** Reverse index: Workspace dir -> `agentId`, for reuse + dir-scoped lookup. */
  private readonly byWorkspace = new Map<string, string>()

  constructor(options: AgentPoolOptions<A>) {
    this.createAgent = options.createAgent
    this.mintId = options.mintId ?? randomUUID
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
      if (entry) return { agentId: entry.agentId, agent: entry.agent, created: false }
    }
    const agentId = this.mintId()
    const agent = this.createAgent(workspaceDir)
    this.byId.set(agentId, { agentId, workspaceDir, agent })
    this.byWorkspace.set(workspaceDir, agentId)
    return { agentId, agent, created: true }
  }

  /** The warm agent for a renderer `agentId` handle, or null when none. */
  get(agentId: string): A | null {
    return this.byId.get(agentId)?.agent ?? null
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
    entry.agent.stop()
    this.byId.delete(agentId)
    this.byWorkspace.delete(entry.workspaceDir)
  }

  /** Stop + drop every warm agent (app quit). */
  disposeAll(): void {
    for (const entry of this.byId.values()) entry.agent.stop()
    this.byId.clear()
    this.byWorkspace.clear()
  }
}
