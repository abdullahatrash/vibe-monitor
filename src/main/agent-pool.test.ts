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
function makePool(): { pool: AgentPool<FakeAgent>; factory: ReturnType<typeof fakeFactory> } {
  const factory = fakeFactory()
  let n = 0
  const pool = new AgentPool<FakeAgent>({ createAgent: factory.create, mintId: () => `a${++n}` })
  return { pool, factory }
}

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
