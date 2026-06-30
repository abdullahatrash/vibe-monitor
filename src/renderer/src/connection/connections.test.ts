import { describe, it, expect } from 'vitest'
import {
  agentIdOf,
  connectedWorkspaceIds,
  connectionsReducer,
  currentConfigValue,
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
    reasoningEffort: null,
    signOutAvailable: true,
    authMethods: AUTH_METHODS,
  }
  return { status: 'connected', thread }
}

/** A connected state carrying all three agent-control axes (#66), for set-config tests. */
function connectedWithControls(workspaceId: string, agentId: string): ConnectState {
  const base = connected(workspaceId, agentId)
  if (base.status !== 'connected') throw new Error('unreachable')
  return {
    status: 'connected',
    thread: {
      ...base.thread,
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ],
      },
      models: {
        currentModelId: 'mistral-medium-3.5',
        availableModels: [
          { modelId: 'mistral-medium-3.5', name: 'mistral-medium-3.5' },
          { modelId: 'devstral-small', name: 'devstral-small' },
        ],
      },
      reasoningEffort: {
        current: 'high',
        options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
      },
    },
  }
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

  it('evict drops the Workspaces holding pool-evicted agents (re-warm on next select), TB5 #50', () => {
    const map: ConnectionMap = {
      w1: connected('w1', 'a1'),
      w2: connected('w2', 'a2'),
      w3: { status: 'not-signed-in', agentId: 'a3', workspaceDir: '/proj/w3', authMethods: AUTH_METHODS },
    }
    // The pool evicted a1 (connected) and a3 (not-signed-in) — both Workspaces drop.
    const next = connectionsReducer(map, { type: 'evict', agentIds: new Set(['a1', 'a3']) })
    expect(Object.keys(next)).toEqual(['w2']) // w2 (a2) untouched
  })

  it('evict is a no-op (same ref) when no connection holds an evicted agent', () => {
    const map: ConnectionMap = { w1: connected('w1', 'a1') }
    // a connecting/idle Workspace has no agent yet, so an unrelated eviction is inert.
    const same = connectionsReducer(map, { type: 'evict', agentIds: new Set(['a-unknown']) })
    expect(same).toBe(map)
  })
})

describe('connectionsReducer set-config (#66 optimistic agent-control change)', () => {
  it('updates the current value for each axis, leaving the others untouched', () => {
    const map: ConnectionMap = { w1: connectedWithControls('w1', 'a1') }

    const mode = connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'plan' })
    const s1 = mode.w1
    if (s1.status !== 'connected') throw new Error('expected connected')
    expect(s1.thread.modes?.currentModeId).toBe('plan')
    expect(s1.thread.models?.currentModelId).toBe('mistral-medium-3.5') // model untouched
    expect(s1.thread.reasoningEffort?.current).toBe('high') // effort untouched

    const model = connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'model', value: 'devstral-small' })
    const s2 = model.w1
    if (s2.status !== 'connected') throw new Error('expected connected')
    expect(s2.thread.models?.currentModelId).toBe('devstral-small')

    const effort = connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'reasoningEffort', value: 'max' })
    const s3 = effort.w1
    if (s3.status !== 'connected') throw new Error('expected connected')
    expect(s3.thread.reasoningEffort?.current).toBe('max')
  })

  it('reverts cleanly by re-dispatching the prior value (ADR-0007 revert)', () => {
    const map: ConnectionMap = { w1: connectedWithControls('w1', 'a1') }
    const optimistic = connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'plan' })
    const reverted = connectionsReducer(optimistic, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'default' })
    const s = reverted.w1
    if (s.status !== 'connected') throw new Error('expected connected')
    expect(s.thread.modes?.currentModeId).toBe('default')
  })

  it('does not mutate the input state', () => {
    const before = connectedWithControls('w1', 'a1')
    const map: ConnectionMap = { w1: before }
    connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'plan' })
    if (before.status !== 'connected') throw new Error('expected connected')
    expect(before.thread.modes?.currentModeId).toBe('default') // original object unchanged
  })

  it('is a no-op (same ref) when the value is already current', () => {
    const map: ConnectionMap = { w1: connectedWithControls('w1', 'a1') }
    const same = connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'default' })
    expect(same).toBe(map)
  })

  it('is a no-op (same ref) when the Workspace is not connected or absent', () => {
    const map: ConnectionMap = {
      w1: { status: 'connecting', workspaceDir: '/proj/w1' },
    }
    expect(connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'mode', value: 'plan' })).toBe(map)
    expect(connectionsReducer(map, { type: 'set-config', workspaceId: 'absent', axis: 'mode', value: 'plan' })).toBe(map)
  })

  it('is a no-op (same ref) when the axis is not advertised (null modes/models/effort)', () => {
    const map: ConnectionMap = { w1: connected('w1', 'a1') } // all axes null
    expect(connectionsReducer(map, { type: 'set-config', workspaceId: 'w1', axis: 'model', value: 'x' })).toBe(map)
  })
})

describe('currentConfigValue (#66)', () => {
  it('reads the current value per axis, null when unadvertised', () => {
    const withControls = connectedWithControls('w1', 'a1')
    if (withControls.status !== 'connected') throw new Error('expected connected')
    expect(currentConfigValue(withControls.thread, 'mode')).toBe('default')
    expect(currentConfigValue(withControls.thread, 'model')).toBe('mistral-medium-3.5')
    expect(currentConfigValue(withControls.thread, 'reasoningEffort')).toBe('high')

    const bare = connected('w1', 'a1')
    if (bare.status !== 'connected') throw new Error('expected connected')
    expect(currentConfigValue(bare.thread, 'mode')).toBeNull()
    expect(currentConfigValue(bare.thread, 'reasoningEffort')).toBeNull()
  })
})

describe('agentIdOf', () => {
  it('extracts the pool agentId from a connected / not-signed-in state, null otherwise', () => {
    expect(agentIdOf(connected('w1', 'a1'))).toBe('a1')
    expect(
      agentIdOf({ status: 'not-signed-in', agentId: 'a4', workspaceDir: '/proj/w4', authMethods: AUTH_METHODS }),
    ).toBe('a4')
    expect(agentIdOf({ status: 'idle' })).toBeNull()
    expect(agentIdOf({ status: 'connecting', workspaceDir: '/proj/w1' })).toBeNull()
    expect(agentIdOf({ status: 'error', message: 'boom', hint: null })).toBeNull()
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
