import { describe, it, expect } from 'vitest'
import { isProtected, type ProtectionState } from './agent-protection'

/**
 * The warm-pool eviction-protection predicate (TB5 #50) — the safety-critical
 * guarantee that the on-screen / streaming / signing-in Workspace can NEVER be
 * evicted. Exercised here as a pure function over the three protection signals
 * (no Electron, no timers), so the rule itself is verified in isolation.
 */

/** Build a protection state, overriding only the fields a case cares about. */
function state(over: Partial<ProtectionState> = {}): ProtectionState {
  return {
    activeAgentId: null,
    inFlightTurns: new Map(),
    signingInAgents: new Set(),
    ...over,
  }
}

describe('isProtected (TB5 #50)', () => {
  it('protects the on-screen (active) agent', () => {
    expect(isProtected('a1', state({ activeAgentId: 'a1' }))).toBe(true)
  })

  it('protects an agent with a prompt turn in flight (>0)', () => {
    expect(isProtected('a1', state({ inFlightTurns: new Map([['a1', 1]]) }))).toBe(true)
    // Overlapping turns (count 2) stay protected.
    expect(isProtected('a1', state({ inFlightTurns: new Map([['a1', 2]]) }))).toBe(true)
  })

  it('protects an agent with a sign-in flow in progress', () => {
    expect(isProtected('a1', state({ signingInAgents: new Set(['a1']) }))).toBe(true)
  })

  it('does NOT protect an agent that is idle, not selected, and not signing in', () => {
    const s = state({
      activeAgentId: 'other',
      inFlightTurns: new Map([['other', 1]]),
      signingInAgents: new Set(['another']),
    })
    expect(isProtected('a1', s)).toBe(false)
  })

  it('treats a zero / settled turn count as unprotected (the count is removed at zero)', () => {
    // Defensive: even a lingering 0 entry must not protect (mirrors `endTurn`'s delete).
    expect(isProtected('a1', state({ inFlightTurns: new Map([['a1', 0]]) }))).toBe(false)
  })

  it('protects nobody when there is no on-screen agent (activeAgentId null)', () => {
    expect(isProtected('a1', state({ activeAgentId: null }))).toBe(false)
  })
})
