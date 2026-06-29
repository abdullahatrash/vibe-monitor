import { describe, it, expect } from 'vitest'
import { routeThreadResult } from './routing'
import type { AuthMethod, ThreadConnection } from '../../../shared/ipc'

/**
 * Pure routing: map a `startThread` / `openThread` result to the next
 * ConnectState. The Open-project path consults auth state (via the result's
 * `kind`) and routes to the sign-in panel when not-signed-in, instead of a raw
 * error dead-end (ADR-0001: renderer owns view routing).
 */

const AUTH_METHODS: AuthMethod[] = [{ id: 'browser-auth-delegated', name: 'Sign in through Mistral AI Studio' }]

const THREAD: ThreadConnection = {
  agentId: 'a1',
  workspaceDir: '/abs/ws',
  threadId: 't1',
  workspaceId: 'w1',
  sessionId: 's1',
  title: null,
  modes: null,
  models: null,
  signOutAvailable: true,
  authMethods: AUTH_METHODS,
}

describe('routeThreadResult', () => {
  it('routes a not-signed-in result to the sign-in panel (consults auth state)', () => {
    const next = routeThreadResult({
      ok: false,
      kind: 'not-signed-in',
      agentId: 'a1',
      workspaceDir: '/abs/ws',
      authMethods: AUTH_METHODS,
    })
    expect(next).toEqual({
      status: 'not-signed-in',
      agentId: 'a1',
      workspaceDir: '/abs/ws',
      authMethods: AUTH_METHODS,
    })
  })

  it('routes an ok result to a connected Thread', () => {
    expect(routeThreadResult({ ok: true, thread: THREAD })).toEqual({
      status: 'connected',
      thread: THREAD,
    })
  })

  it('routes a generic error to the error state', () => {
    expect(routeThreadResult({ ok: false, kind: 'error', error: 'boom', hint: 'try again' })).toEqual({
      status: 'error',
      message: 'boom',
      hint: 'try again',
    })
  })
})
