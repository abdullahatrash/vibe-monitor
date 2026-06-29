import { describe, it, expect } from 'vitest'
import { eventBelongsToThread, sessionIdOfEvent } from './event-routing'

/**
 * Live event routing for multiple Threads on ONE agent (ADR-0005, TB5 #34). A
 * single `vibe-acp` hosts many ACP sessions, all streamed over the one
 * `acp:event` channel tagged only by `agentId`; the renderer must route each
 * session-tagged payload to the Thread bound to that sessionId, while agent-wide
 * lifecycle events (no sessionId) pass through. Pure — no React, no IPC.
 */

describe('sessionIdOfEvent', () => {
  it('pulls params.sessionId from a session/update or request_permission payload', () => {
    expect(sessionIdOfEvent({ method: 'session/update', params: { sessionId: 's1' } })).toBe('s1')
    expect(
      sessionIdOfEvent({ method: 'session/request_permission', params: { sessionId: 's2' } }),
    ).toBe('s2')
  })

  it('returns null for lifecycle payloads and malformed input', () => {
    expect(sessionIdOfEvent({ type: 'exit', info: {} })).toBeNull()
    expect(sessionIdOfEvent({ type: 'stderr', text: 'x' })).toBeNull()
    expect(sessionIdOfEvent(null)).toBeNull()
    expect(sessionIdOfEvent({ params: {} })).toBeNull()
  })
})

describe('eventBelongsToThread', () => {
  it('routes a session-tagged event only to the Thread bound to that session', () => {
    const mine = { params: { sessionId: 's1' } }
    const other = { params: { sessionId: 's2' } }
    expect(eventBelongsToThread(mine, 's1')).toBe(true)
    expect(eventBelongsToThread(other, 's1')).toBe(false)
  })

  it('passes session-less lifecycle events through (agent-wide)', () => {
    expect(eventBelongsToThread({ type: 'exit', info: {} }, 's1')).toBe(true)
    expect(eventBelongsToThread({ type: 'error', message: 'boom' }, null)).toBe(true)
  })

  it('REJECTS every session-tagged event while a draft is still unbound (no sibling adoption)', () => {
    // A sibling Thread stays live on the shared agent: an unbound draft must NOT
    // adopt an arbitrary event's session, or it would splice a sibling's turn in.
    // Main's `thread:bound` signal binds the draft BEFORE its own events arrive,
    // so rejecting-while-unbound drops nothing of the draft's own stream.
    expect(eventBelongsToThread({ params: { sessionId: 's-sibling' } }, null)).toBe(false)
    expect(eventBelongsToThread({ params: { sessionId: 's-own' } }, null)).toBe(false)
  })

  it('after binding (thread:bound) routes the draft to its OWN session, rejecting a sibling', () => {
    // Models the canonical race: draft D mounts unbound while sibling A streams on
    // sA. Until D is bound, BOTH are rejected. Once `thread:bound` sets D to sD,
    // D accepts its own sD events and still rejects A's sA events.
    const sibling = { params: { sessionId: 'sA' } }
    const own = { params: { sessionId: 'sD' } }
    expect(eventBelongsToThread(sibling, null)).toBe(false)
    expect(eventBelongsToThread(own, null)).toBe(false)
    expect(eventBelongsToThread(own, 'sD')).toBe(true)
    expect(eventBelongsToThread(sibling, 'sD')).toBe(false)
    // Lifecycle still passes through at every stage.
    expect(eventBelongsToThread({ type: 'exit', info: {} }, null)).toBe(true)
    expect(eventBelongsToThread({ type: 'exit', info: {} }, 'sD')).toBe(true)
  })
})
