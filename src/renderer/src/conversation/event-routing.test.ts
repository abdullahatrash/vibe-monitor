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

  it('accepts a session-tagged event for a not-yet-bound (draft) Thread so its first turn shows', () => {
    // A draft has no bound session until its first prompt resolves; its first
    // turn's events must still render (only the selected Thread is mounted, so
    // there is no other live Thread to misroute to).
    expect(eventBelongsToThread({ params: { sessionId: 's-new' } }, null)).toBe(true)
  })
})
