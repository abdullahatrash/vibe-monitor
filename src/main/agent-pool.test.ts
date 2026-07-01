import { describe, it, expect } from 'vitest'
import { AgentPool, type PoolAgent } from './agent-pool'

/**
 * The warm-agent pool (ADR-0006 decision 3, TB2 #47): one `vibe-acp` agent per
 * OPEN Workspace, lazily spawned on first select and kept warm thereafter — so
 * reselecting a Workspace REUSES the same agent (no second spawn/handshake) and
 * switching away never tears it down. Exercised at the injected-factory seam with
 * a fake agent (counting spawns + stops) — NEVER a live vibe-acp, like the
 * `thread-binding` / `workspace-agent` tests.
 */

interface FakeAgent extends PoolAgent {
  readonly workspaceDir: string
  stops: number
}

/** A counting fake-agent factory: one fresh agent per `vibe-acp` spawn. */
function fakeFactory(): { create: (workspaceDir: string) => FakeAgent; spawns: number } {
  const tracker = {
    spawns: 0,
    create(workspaceDir: string): FakeAgent {
      tracker.spawns++
      return {
        workspaceDir,
        stops: 0,
        stop() {
          this.stops++
        },
      }
    },
  }
  return tracker
}

/** A pool over the fake factory, with a deterministic id sequence for assertions. */
function makePool(now?: () => number): { pool: AgentPool<FakeAgent>; factory: ReturnType<typeof fakeFactory> } {
  const factory = fakeFactory()
  let n = 0
  const pool = new AgentPool<FakeAgent>({ createAgent: factory.create, mintId: () => `a${++n}`, now })
  return { pool, factory }
}

/** A mutable injected clock (TB5 #50): advance it to age agents — no real timers. */
function fakeClock(start = 0): { now: () => number; set: (t: number) => void } {
  let t = start
  return { now: () => t, set: (next) => void (t = next) }
}

/** Never protect any agent — the default policy input when protection isn't under test. */
const UNPROTECTED = (): boolean => false

describe('AgentPool — lazy-spawn-once + reuse-by-Workspace', () => {
  it('spawns an agent on first acquire and returns a minted id (created=true)', () => {
    const { pool, factory } = makePool()

    const first = pool.acquire('/proj/a')

    expect(factory.spawns).toBe(1)
    expect(first.created).toBe(true)
    expect(first.agentId).toBe('a1')
    expect(first.agent.workspaceDir).toBe('/proj/a')
  })

  it('REUSES the warm agent on a second acquire of the same Workspace (no second spawn/handshake)', () => {
    const { pool, factory } = makePool()

    const first = pool.acquire('/proj/a')
    const second = pool.acquire('/proj/a')

    expect(factory.spawns).toBe(1) // spawned once, reused
    expect(second.created).toBe(false)
    expect(second.agentId).toBe(first.agentId) // same renderer-facing handle
    expect(second.agent).toBe(first.agent) // same warm process
  })

  it('spawns a DISTINCT agent per Workspace (both stay warm at once)', () => {
    const { pool, factory } = makePool()

    const a = pool.acquire('/proj/a')
    const b = pool.acquire('/proj/b')

    expect(factory.spawns).toBe(2)
    expect(b.agentId).not.toBe(a.agentId)
    expect(b.agent).not.toBe(a.agent)
    // Acquiring A again after B was spawned still reuses A — B's spawn didn't evict it.
    expect(pool.acquire('/proj/a').agent).toBe(a.agent)
  })
})

describe('AgentPool — lookups', () => {
  it('resolves an agent by its renderer agentId handle, null for an unknown id', () => {
    const { pool } = makePool()
    const { agentId, agent } = pool.acquire('/proj/a')

    expect(pool.get(agentId)).toBe(agent)
    expect(pool.get('nope')).toBeNull()
  })

  it('resolves the warm agent + id for a Workspace, null when none is warm', () => {
    const { pool } = makePool()
    const acquired = pool.acquire('/proj/a')

    expect(pool.getByWorkspace('/proj/a')).toEqual({ agentId: acquired.agentId, agent: acquired.agent })
    expect(pool.getByWorkspace('/proj/unknown')).toBeNull()
  })

  it('resolves the warm agentId for a Workspace dir (null for unknown / after dispose)', () => {
    const { pool } = makePool()
    const { agentId } = pool.acquire('/proj/a')

    expect(pool.agentIdForWorkspace('/proj/a')).toBe(agentId)
    expect(pool.agentIdForWorkspace('/proj/unknown')).toBeNull()

    pool.dispose(agentId)
    expect(pool.agentIdForWorkspace('/proj/a')).toBeNull()
  })

  it('lists every warm agent (for fan-out like best-effort session close)', () => {
    const { pool } = makePool()
    const a = pool.acquire('/proj/a').agent
    const b = pool.acquire('/proj/b').agent

    expect(pool.agents()).toEqual(expect.arrayContaining([a, b]))
    expect(pool.agents()).toHaveLength(2)
  })
})

describe('AgentPool — explicit dispose (the TB5 eviction seam)', () => {
  it('dispose stops the agent, drops it from both lookups, and re-warms fresh on next acquire', () => {
    const { pool, factory } = makePool()
    const { agentId, agent } = pool.acquire('/proj/a')

    pool.dispose(agentId)

    expect(agent.stops).toBe(1) // the child was stopped
    expect(pool.get(agentId)).toBeNull()
    expect(pool.getByWorkspace('/proj/a')).toBeNull()

    // A subsequent select re-warms transparently with a brand-new agent.
    const rewarmed = pool.acquire('/proj/a')
    expect(factory.spawns).toBe(2)
    expect(rewarmed.created).toBe(true)
    expect(rewarmed.agent).not.toBe(agent)
  })

  it('dispose of one Workspace leaves the others warm', () => {
    const { pool } = makePool()
    const a = pool.acquire('/proj/a')
    const b = pool.acquire('/proj/b')

    pool.dispose(a.agentId)

    expect(pool.getByWorkspace('/proj/a')).toBeNull()
    expect(pool.getByWorkspace('/proj/b')).toEqual({ agentId: b.agentId, agent: b.agent })
    expect(b.agent.stops).toBe(0)
  })

  it('dispose of an unknown id is a no-op (never throws)', () => {
    const { pool } = makePool()
    expect(() => pool.dispose('nope')).not.toThrow()
  })

  it('disposeAll stops every warm agent and empties the pool (app quit)', () => {
    const { pool } = makePool()
    const a = pool.acquire('/proj/a').agent
    const b = pool.acquire('/proj/b').agent

    pool.disposeAll()

    expect(a.stops).toBe(1)
    expect(b.stops).toBe(1)
    expect(pool.agents()).toHaveLength(0)
  })
})

/**
 * Idle-evict (TB5 #50): the periodic sweep disposes an agent with no activity for
 * the configured timeout, EXCEPT the protected (on-screen / mid-turn) ones —
 * exercised with an INJECTED clock so no real timer or process is involved.
 */
describe('AgentPool — idle eviction (TB5 #50)', () => {
  it('stamps lastActiveAt on spawn and evicts only the stale, unprotected agent (returning its id)', () => {
    const clock = fakeClock(0)
    const { pool, factory } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // active at t=0
    clock.set(8_000)
    pool.acquire('/proj/b') // active at t=8_000

    clock.set(10_000)
    // idleMs 5_000 -> cutoff 5_000: a (t=0) is stale, b (t=8_000) is fresh.
    const evicted = pool.evictIdle({ idleMs: 5_000, isProtected: UNPROTECTED })

    expect(evicted).toEqual([a.agentId])
    expect(a.agent.stops).toBe(1)
    expect(pool.getByWorkspace('/proj/a')).toBeNull()
    expect(pool.getByWorkspace('/proj/b')).not.toBeNull()
    // A re-select of the evicted Workspace re-warms transparently (fresh spawn).
    clock.set(11_000)
    const rewarmed = pool.acquire('/proj/a')
    expect(factory.spawns).toBe(3)
    expect(rewarmed.created).toBe(true)
    expect(rewarmed.agent).not.toBe(a.agent)
  })

  it('REUSE refreshes lastActiveAt, so a re-selected Workspace is not evicted as idle', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // t=0
    clock.set(8_000)
    pool.acquire('/proj/a') // reuse -> refreshes to t=8_000

    clock.set(10_000)
    const evicted = pool.evictIdle({ idleMs: 5_000, isProtected: UNPROTECTED })

    expect(evicted).toEqual([])
    expect(a.agent.stops).toBe(0)
  })

  it('touch refreshes lastActiveAt (an unknown id is a no-op)', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // t=0
    clock.set(8_000)
    pool.touch(a.agentId)
    expect(() => pool.touch('nope')).not.toThrow()

    clock.set(10_000)
    expect(pool.evictIdle({ idleMs: 5_000, isProtected: UNPROTECTED })).toEqual([])
    expect(a.agent.stops).toBe(0)
  })

  it('NEVER evicts a protected (selected / mid-turn) agent, even when stale', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // t=0, will be stale but protected
    clock.set(20_000)

    const evicted = pool.evictIdle({ idleMs: 5_000, isProtected: (id) => id === a.agentId })

    expect(evicted).toEqual([])
    expect(a.agent.stops).toBe(0)
    expect(pool.getByWorkspace('/proj/a')).not.toBeNull()
  })
})

/**
 * Warm-count cap (TB5 #50): exceeding M warm agents disposes the LEAST-recently-
 * active one — never a protected (on-screen / mid-turn) agent, even when honoring
 * that means staying over cap. The just-acquired agent is most-recent, so the cap
 * trims a background Workspace, never the one the user just selected.
 */
describe('AgentPool — warm-count cap (TB5 #50)', () => {
  it('evicts the LRU non-protected agent when over cap (returning its id)', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // t=0  (LRU)
    clock.set(1_000)
    pool.acquire('/proj/b') // t=1_000
    clock.set(2_000)
    pool.acquire('/proj/c') // t=2_000

    const evicted = pool.enforceCap({ maxWarm: 2, isProtected: UNPROTECTED })

    expect(evicted).toEqual([a.agentId]) // the least-recently-active
    expect(a.agent.stops).toBe(1)
    expect(pool.agents()).toHaveLength(2)
    expect(pool.getByWorkspace('/proj/b')).not.toBeNull()
    expect(pool.getByWorkspace('/proj/c')).not.toBeNull()
  })

  it('is a no-op while at or under the cap', () => {
    const { pool } = makePool()
    pool.acquire('/proj/a')
    pool.acquire('/proj/b')

    expect(pool.enforceCap({ maxWarm: 2, isProtected: UNPROTECTED })).toEqual([])
    expect(pool.agents()).toHaveLength(2)
  })

  it('SKIPS a protected LRU and trims the next non-protected agent instead', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a') // t=0   (LRU, but protected — mid-turn)
    clock.set(1_000)
    const b = pool.acquire('/proj/b') // t=1_000 (next LRU, unprotected)
    clock.set(2_000)
    pool.acquire('/proj/c') // t=2_000

    const evicted = pool.enforceCap({ maxWarm: 2, isProtected: (id) => id === a.agentId })

    expect(evicted).toEqual([b.agentId]) // protected a survived; b trimmed
    expect(a.agent.stops).toBe(0)
    expect(b.agent.stops).toBe(1)
    expect(pool.getByWorkspace('/proj/a')).not.toBeNull()
  })

  it('STAYS over cap rather than evict a protected agent (protection wins)', () => {
    const clock = fakeClock(0)
    const { pool } = makePool(clock.now)

    const a = pool.acquire('/proj/a')
    clock.set(1_000)
    const b = pool.acquire('/proj/b')
    clock.set(2_000)
    const c = pool.acquire('/proj/c')
    const allProtected = new Set([a.agentId, b.agentId, c.agentId])

    const evicted = pool.enforceCap({ maxWarm: 2, isProtected: (id) => allProtected.has(id) })

    expect(evicted).toEqual([]) // nothing killable — left over cap
    expect(pool.agents()).toHaveLength(3)
  })
})

/**
 * Graceful teardown injection (TB5 #50, acceptance #3): the pool routes ALL exits
 * (explicit dispose, idle-evict, cap-trim) through the injected `disposeAgent` so
 * production can best-effort `session/close` THEN terminate — while the fake-agent
 * tests above keep using the default `stop()` disposer unchanged.
 */
describe('AgentPool — injected disposeAgent (graceful teardown)', () => {
  /** A pool whose teardown is recorded (not a raw stop) — the production wiring shape. */
  function makeGracefulPool(now?: () => number): {
    pool: AgentPool<FakeAgent>
    disposed: FakeAgent[]
  } {
    const factory = fakeFactory()
    let n = 0
    const disposed: FakeAgent[] = []
    const pool = new AgentPool<FakeAgent>({
      createAgent: factory.create,
      mintId: () => `a${++n}`,
      now,
      disposeAgent: (agent) => disposed.push(agent),
    })
    return { pool, disposed }
  }

  it('routes an explicit dispose through disposeAgent (not a direct stop), maps updated first', () => {
    const { pool, disposed } = makeGracefulPool()
    const { agentId, agent } = pool.acquire('/proj/a')

    pool.dispose(agentId)

    expect(disposed).toEqual([agent]) // the injected disposer ran for this agent
    expect(agent.stops).toBe(0) // the pool did NOT bypass it with a raw stop()
    // Maps are already consistent (updated before the async teardown) — re-warmable.
    expect(pool.get(agentId)).toBeNull()
    expect(pool.getByWorkspace('/proj/a')).toBeNull()
  })

  it('routes an idle eviction through disposeAgent for the evicted id', () => {
    const clock = fakeClock(0)
    const { pool, disposed } = makeGracefulPool(clock.now)
    const a = pool.acquire('/proj/a')

    clock.set(20_000)
    const evicted = pool.evictIdle({ idleMs: 5_000, isProtected: UNPROTECTED })

    expect(evicted).toEqual([a.agentId])
    expect(disposed).toEqual([a.agent]) // graceful teardown, not stop()
    expect(a.agent.stops).toBe(0)
  })

  it('routes a cap-trim through disposeAgent for the LRU id', () => {
    const clock = fakeClock(0)
    const { pool, disposed } = makeGracefulPool(clock.now)
    const a = pool.acquire('/proj/a')
    clock.set(1_000)
    pool.acquire('/proj/b')

    const evicted = pool.enforceCap({ maxWarm: 1, isProtected: UNPROTECTED })

    expect(evicted).toEqual([a.agentId])
    expect(disposed).toEqual([a.agent])
  })
})
