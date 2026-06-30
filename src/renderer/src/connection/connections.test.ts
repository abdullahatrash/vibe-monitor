import { describe, it, expect } from 'vitest'
import {
  connectedWorkspaceIds,
  connectionsReducer,
  initialConnections,
  selectedConnection,
  shouldConnect,
  type ConnectionMap,
} from './connections'
import type { ConnectState } from './routing'
import type { AuthMethod, ThreadConnection } from '../../../shared/ipc'

/**
 * Per-Workspace connection registry (ADR-0006, TB2 #47): the renderer keeps a
 * ConnectState PER Workspace so switching between warm Workspaces is instant and
 * both keep streaming. Pure reducer + derivations, like the nav reducer.
 */

const AUTH_METHODS: AuthMethod[] = [{ id: 'browser-auth-delegated', name: 'Sign in' }]

function connected(workspaceId: string, agentId: string): ConnectState {
  const thread: ThreadConnection = {
    agentId,
    workspaceDir: `/proj/${workspaceId}`,
    threadId: `t-${workspaceId}`,
    workspaceId,
    sessionId: `s-${workspaceId}`,
    title: null,
    modes: null,
    models: null,
    signOutAvailable: true,
    authMethods: AUTH_METHODS,
  }
  return { status: 'connected', thread }
}

describe('connectionsReducer', () => {
  it('starts empty', () => {
    expect(initialConnections).toEqual({})
  })

  it('set adds a Workspace connection without disturbing the others', () => {
    const a = connectionsReducer(initialConnections, { type: 'set', workspaceId: 'w1', state: connected('w1', 'a1') })
    const b = connectionsReducer(a, { type: 'set', workspaceId: 'w2', state: connected('w2', 'a2') })

    expect(Object.keys(b)).toEqual(['w1', 'w2'])
    expect(b.w1).toEqual(connected('w1', 'a1')) // w1 untouched when w2 connects
  })

  it('set replaces a Workspace connection in place (e.g. connecting -> connected)', () => {
    const connecting: ConnectState = { status: 'connecting', workspaceDir: '/proj/w1' }
    const a = connectionsReducer(initialConnections, { type: 'set', workspaceId: 'w1', state: connecting })
    const b = connectionsReducer(a, { type: 'set', workspaceId: 'w1', state: connected('w1', 'a1') })

    expect(b.w1.status).toBe('connected')
  })

  it('clear removes one Workspace connection (and is a no-op for an absent one)', () => {
    const a = connectionsReducer(initialConnections, { type: 'set', workspaceId: 'w1', state: connected('w1', 'a1') })
    const cleared = connectionsReducer(a, { type: 'clear', workspaceId: 'w1' })
    expect(cleared).toEqual({})

    const same = connectionsReducer(a, { type: 'clear', workspaceId: 'absent' })
    expect(same).toBe(a) // unchanged reference: no spurious re-render
  })
})

describe('selectedConnection', () => {
  const map: ConnectionMap = { w1: connected('w1', 'a1') }

  it('returns the selected Workspace connection', () => {
    expect(selectedConnection(map, 'w1').status).toBe('connected')
  })

  it('returns idle when nothing is selected', () => {
    expect(selectedConnection(map, null)).toEqual({ status: 'idle' })
  })

  it('returns idle for a never-connected Workspace (cold clicks route correctly post-connect)', () => {
    // w2 was never connected even though w1 is connected — the outlet for w2 is
    // idle, so its cold thread replays instead of being shadowed by w1 (finding 2).
    expect(selectedConnection(map, 'w2')).toEqual({ status: 'idle' })
  })
})

describe('connectedWorkspaceIds', () => {
  it('lists only the connected Workspaces (the keep-mounted set)', () => {
    const map: ConnectionMap = {
      w1: connected('w1', 'a1'),
      w2: { status: 'connecting', workspaceDir: '/proj/w2' },
      w3: connected('w3', 'a3'),
      w4: { status: 'not-signed-in', agentId: 'a4', workspaceDir: '/proj/w4', authMethods: AUTH_METHODS },
    }
    expect(connectedWorkspaceIds(map).sort()).toEqual(['w1', 'w3'])
  })
})

describe('shouldConnect', () => {
  it('connects a never-seen Workspace and re-tries an errored one', () => {
    expect(shouldConnect(undefined)).toBe(true)
    expect(shouldConnect({ status: 'idle' })).toBe(true)
    expect(shouldConnect({ status: 'error', message: 'boom', hint: null })).toBe(true)
  })

  it('REUSES a connecting / not-signed-in / connected Workspace (no respawn)', () => {
    expect(shouldConnect({ status: 'connecting', workspaceDir: '/proj/w1' })).toBe(false)
    expect(
      shouldConnect({ status: 'not-signed-in', agentId: 'a1', workspaceDir: '/proj/w1', authMethods: AUTH_METHODS }),
    ).toBe(false)
    expect(shouldConnect(connected('w1', 'a1'))).toBe(false)
  })
})
