import { describe, it, expect } from 'vitest'
import {
  boundConfigValue,
  configFor,
  currentConfigValue,
  draftControls,
  initialWorkspaceThreads,
  reassertions,
  selectedFor,
  workspaceThreadsReducer,
  workspaceThreadStateFor,
  type WorkspaceThreadsState,
} from './workspace-threads'
import type { ThreadAgentControls } from '../../../shared/ipc'

/**
 * Per-Workspace, per-session Thread state lifted out of ConnectedWorkspace (TB3
 * #48): the live set, bound sessions, the active (kept-mounted) Thread, and (TB #70)
 * each live Thread's OWN agent-controls — keyed by Workspace so several warm
 * Workspaces coexist. Pure reducer + derivations.
 */

/** A full agent-controls bundle for the per-Thread config tests (#70). */
function controls(modeId = 'default', modelId = 'mistral-medium-3.5', effort = 'high'): ThreadAgentControls {
  return {
    modes: {
      currentModeId: modeId,
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    models: {
      currentModelId: modelId,
      availableModels: [
        { modelId: 'mistral-medium-3.5', name: 'mistral-medium-3.5' },
        { modelId: 'devstral-small', name: 'devstral-small' },
      ],
    },
    reasoningEffort: {
      current: effort,
      options: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    },
  }
}

describe('workspaceThreadsReducer', () => {
  it('connect seeds the live set + active with the auto-opened Thread', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: null,
    })
    expect([...s.w1.live]).toEqual(['t-open'])
    expect(s.w1.bound).toEqual({ 't-open': 's1' })
    expect(s.w1.active).toBe('t-open')
  })

  it('connect with a null session seeds no bound entry (a continued/never-bound Thread)', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-cont',
      sessionId: null,
      controls: null,
    })
    expect(s.w1.bound).toEqual({})
    expect([...s.w1.live]).toEqual(['t-cont'])
  })

  it('connect resets a reconnecting Workspace (new agent drops prior drafts)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w1', threadId: 't-new', sessionId: 's2', controls: null })
    expect([...s.w1.live]).toEqual(['t-new']) // 'draft' gone with the old agent
    expect(s.w1.active).toBe('t-new')
  })

  it('open hosts a new Thread live and makes it active', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    expect([...s.w1.live].sort()).toEqual(['draft', 't-open'])
    expect(s.w1.active).toBe('draft')
  })

  it('open on an unconnected Workspace is a no-op (no agent to host it)', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'open',
      workspaceId: 'w1',
      threadId: 'draft',
    })
    expect(s).toBe(initialWorkspaceThreads)
  })

  it('select changes the active Thread only (no live-set change)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'select', workspaceId: 'w1', threadId: 't-open' })
    expect(s.w1.active).toBe('t-open')
    expect([...s.w1.live].sort()).toEqual(['draft', 't-open'])
  })

  it('select to the same active Thread returns the same state reference', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: null,
    })
    expect(workspaceThreadsReducer(s, { type: 'select', workspaceId: 'w1', threadId: 't-open' })).toBe(s)
  })

  it('bind records a session bound this session', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 'draft', sessionId: 'sD', controls: null })
    expect(s.w1.bound).toEqual({ draft: 'sD' })
  })

  it('bind with an unchanged session AND null controls returns the same state reference', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: null,
    })
    expect(
      workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 't-open', sessionId: 's1', controls: null }),
    ).toBe(s)
  })

  it('remove drops a live Thread + its bound session (delete teardown)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 'draft', sessionId: 'sD', controls: null })
    s = workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'draft' })
    expect([...s.w1.live]).toEqual(['t-open'])
    expect(s.w1.bound).toEqual({ 't-open': 's1' })
  })

  it('remove of a non-live Thread is a no-op', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: null,
    })
    expect(workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'cold' })).toBe(s)
  })

  it('remove-workspace drops the whole Workspace entry, leaving siblings intact', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't1',
      sessionId: 's1',
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w2', threadId: 't2', sessionId: 's2', controls: null })
    s = workspaceThreadsReducer(s, { type: 'remove-workspace', workspaceId: 'w1' })
    expect(workspaceThreadStateFor(s, 'w1')).toBeNull()
    expect(workspaceThreadStateFor(s, 'w2')).not.toBeNull()
  })

  it('remove-workspace on an unconnected Workspace returns the same state reference', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't1',
      sessionId: null,
      controls: null,
    })
    expect(workspaceThreadsReducer(s, { type: 'remove-workspace', workspaceId: 'w-none' })).toBe(s)
  })

  it('keeps Workspaces independent (one connect does not disturb another)', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't1',
      sessionId: null,
      controls: null,
    })
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w2', threadId: 't2', sessionId: null, controls: null })
    expect(Object.keys(s).sort()).toEqual(['w1', 'w2'])
    expect(s.w1.active).toBe('t1')
  })
})

describe('per-Thread agent-controls config (#70)', () => {
  it('connect seeds config for the primary Thread (none when controls are null)', () => {
    const withControls = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('plan'),
    })
    expect(withControls.w1.config['t-open']?.modes?.currentModeId).toBe('plan')

    const without = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: null,
    })
    expect(without.w1.config).toEqual({})
  })

  it('bind seeds the bound Thread its OWN config without touching the primary', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, {
      type: 'bind',
      workspaceId: 'w1',
      threadId: 'draft',
      sessionId: 'sD',
      controls: controls('plan', 'devstral-small'),
    })
    expect(s.w1.config['draft']?.modes?.currentModeId).toBe('plan')
    expect(s.w1.config['draft']?.models?.currentModelId).toBe('devstral-small')
    // The primary Thread's controls are untouched — per-Thread isolation.
    expect(s.w1.config['t-open']?.modes?.currentModeId).toBe('default')
    expect(s.w1.config['t-open']?.models?.currentModelId).toBe('mistral-medium-3.5')
  })

  it('bind with null controls leaves an existing entry (no clobber), updating only the session', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: null,
      controls: controls('plan'),
    })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 't-open', sessionId: 's1', controls: null })
    expect(s.w1.bound['t-open']).toBe('s1')
    expect(s.w1.config['t-open']?.modes?.currentModeId).toBe('plan') // kept
  })

  it('bind delivers controls even when the session is unchanged (resumed Thread)', () => {
    // A continued Thread: connect seeds the cursor; its first prompt resumes the
    // SAME session and `thread:bound` brings the resumed config — the same-session
    // path must still seed config (it no longer short-circuits before that).
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-cont',
      sessionId: 'cursor',
      controls: null,
    })
    s = workspaceThreadsReducer(s, {
      type: 'bind',
      workspaceId: 'w1',
      threadId: 't-cont',
      sessionId: 'cursor',
      controls: controls('default'),
    })
    expect(s.w1.config['t-cont']?.modes?.currentModeId).toBe('default')
  })

  it('set-config optimistically updates one axis for one Thread, leaving siblings + axes untouched', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, {
      type: 'bind',
      workspaceId: 'w1',
      threadId: 'draft',
      sessionId: 'sD',
      controls: controls('default'),
    })
    s = workspaceThreadsReducer(s, { type: 'set-config', workspaceId: 'w1', threadId: 'draft', axis: 'mode', value: 'plan' })
    expect(s.w1.config['draft']?.modes?.currentModeId).toBe('plan')
    expect(s.w1.config['draft']?.models?.currentModelId).toBe('mistral-medium-3.5') // axis untouched
    expect(s.w1.config['t-open']?.modes?.currentModeId).toBe('default') // sibling untouched
  })

  it('set-config reverts cleanly by re-dispatching the prior value (ADR-0007 revert)', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    const optimistic = workspaceThreadsReducer(s, { type: 'set-config', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    const reverted = workspaceThreadsReducer(optimistic, { type: 'set-config', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'default' })
    expect(reverted.w1.config['t-open']?.modes?.currentModeId).toBe('default')
  })

  it('set-config does not mutate the input state', () => {
    const before = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    workspaceThreadsReducer(before, { type: 'set-config', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    expect(before.w1.config['t-open']?.modes?.currentModeId).toBe('default')
  })

  it('set-config is a no-op (same ref) for an unchanged value, missing axis, missing Thread, or missing Workspace', () => {
    const s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    // unchanged value
    expect(workspaceThreadsReducer(s, { type: 'set-config', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'default' })).toBe(s)
    // a Thread with no seeded config
    expect(workspaceThreadsReducer(s, { type: 'set-config', workspaceId: 'w1', threadId: 'no-config', axis: 'mode', value: 'plan' })).toBe(s)
    // an absent Workspace
    expect(workspaceThreadsReducer(s, { type: 'set-config', workspaceId: 'absent', threadId: 't-open', axis: 'mode', value: 'plan' })).toBe(s)

    // an unadvertised axis (null modes/models/effort)
    const bare = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: { modes: null, models: null, reasoningEffort: null },
    })
    expect(workspaceThreadsReducer(bare, { type: 'set-config', workspaceId: 'w1', threadId: 't-open', axis: 'model', value: 'x' })).toBe(bare)
  })

  it('remove drops a Thread config entry too', () => {
    let s = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: controls('default'),
    })
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'bind', workspaceId: 'w1', threadId: 'draft', sessionId: 'sD', controls: controls('plan') })
    s = workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'draft' })
    expect(s.w1.config['draft']).toBeUndefined()
    expect(s.w1.config['t-open']?.modes?.currentModeId).toBe('default') // primary kept
  })
})

describe('workspaceThreadStateFor', () => {
  const state: WorkspaceThreadsState = {
    w1: { live: new Set(['t1']), bound: {}, active: 't1', config: {}, selected: {} },
  }
  it('returns a Workspace live-state', () => {
    expect(workspaceThreadStateFor(state, 'w1')?.active).toBe('t1')
  })
  it('returns null for an unconnected or unselected Workspace', () => {
    expect(workspaceThreadStateFor(state, 'w2')).toBeNull()
    expect(workspaceThreadStateFor(state, null)).toBeNull()
  })
})

describe('configFor (#70)', () => {
  const state = workspaceThreadsReducer(initialWorkspaceThreads, {
    type: 'connect',
    workspaceId: 'w1',
    threadId: 't-open',
    sessionId: 's1',
    controls: controls('plan'),
  })
  it('returns a Thread its own controls', () => {
    expect(configFor(state, 'w1', 't-open')?.modes?.currentModeId).toBe('plan')
  })
  it('returns null for a Thread with no seeded config, an absent Workspace, or null workspaceId', () => {
    expect(configFor(state, 'w1', 'no-config')).toBeNull()
    expect(configFor(state, 'absent', 't-open')).toBeNull()
    expect(configFor(state, null, 't-open')).toBeNull()
  })
})

describe('currentConfigValue (#70)', () => {
  const state = workspaceThreadsReducer(initialWorkspaceThreads, {
    type: 'connect',
    workspaceId: 'w1',
    threadId: 't-open',
    sessionId: 's1',
    controls: controls('default', 'devstral-small', 'max'),
  })
  it('reads the current value per axis', () => {
    expect(currentConfigValue(state, 'w1', 't-open', 'mode')).toBe('default')
    expect(currentConfigValue(state, 'w1', 't-open', 'model')).toBe('devstral-small')
    expect(currentConfigValue(state, 'w1', 't-open', 'reasoningEffort')).toBe('max')
  })
  it('returns null when no controls are seeded, or the axis is unadvertised', () => {
    expect(currentConfigValue(state, 'w1', 'no-config', 'mode')).toBeNull()
    const bare = workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls: { modes: null, models: null, reasoningEffort: null },
    })
    expect(currentConfigValue(bare, 'w1', 't-open', 'mode')).toBeNull()
  })
})

describe('selection cache + re-assert (#72)', () => {
  function connected(controls: ThreadAgentControls | null = null): WorkspaceThreadsState {
    return workspaceThreadsReducer(initialWorkspaceThreads, {
      type: 'connect',
      workspaceId: 'w1',
      threadId: 't-open',
      sessionId: 's1',
      controls,
    })
  }

  it('cache-selection records, then overwrites, an axis pick (a confirmed change)', () => {
    let s = connected()
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    expect(s.w1.selected['t-open']).toEqual({ mode: 'plan' })
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'model', value: 'devstral-small' })
    expect(s.w1.selected['t-open']).toEqual({ mode: 'plan', model: 'devstral-small' })
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'default' })
    expect(s.w1.selected['t-open']).toEqual({ mode: 'default', model: 'devstral-small' })
  })

  it('cache-selection is a no-op (same ref) for an unchanged value or an absent Workspace', () => {
    let s = connected()
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    expect(workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })).toBe(s)
    expect(workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'absent', threadId: 't-open', axis: 'mode', value: 'x' })).toBe(s)
  })

  it('connect PRESERVES the selection cache while resetting live/bound/active/config (re-warm)', () => {
    let s = connected(controls('default'))
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    // A re-warm after eviction: new agent, fresh primary Thread + session + config.
    s = workspaceThreadsReducer(s, { type: 'connect', workspaceId: 'w1', threadId: 't-new', sessionId: 's2', controls: controls('default') })
    expect([...s.w1.live]).toEqual(['t-new']) // live reset
    expect(s.w1.bound).toEqual({ 't-new': 's2' }) // bound reset
    expect(s.w1.config['t-open']).toBeUndefined() // config reset
    expect(s.w1.selected['t-open']).toEqual({ mode: 'plan' }) // cache SURVIVES
  })

  it('remove drops a Thread selection cache entry too', () => {
    let s = connected()
    s = workspaceThreadsReducer(s, { type: 'open', workspaceId: 'w1', threadId: 'draft' })
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 'draft', axis: 'mode', value: 'plan' })
    s = workspaceThreadsReducer(s, { type: 'remove', workspaceId: 'w1', threadId: 'draft' })
    expect(s.w1.selected['draft']).toBeUndefined()
  })

  it('selectedFor returns a Thread cache, or {} for none / absent Workspace / null workspaceId', () => {
    let s = connected()
    s = workspaceThreadsReducer(s, { type: 'cache-selection', workspaceId: 'w1', threadId: 't-open', axis: 'mode', value: 'plan' })
    expect(selectedFor(s, 'w1', 't-open')).toEqual({ mode: 'plan' })
    expect(selectedFor(s, 'w1', 'no-cache')).toEqual({})
    expect(selectedFor(s, 'absent', 't-open')).toEqual({})
    expect(selectedFor(s, null, 't-open')).toEqual({})
  })

  describe('reassertions', () => {
    it('no cached selection → no re-assertions', () => {
      expect(reassertions({}, controls('plan', 'devstral-small', 'max'))).toEqual([])
    })

    it('selection equal to the resumed value → no re-assertion', () => {
      expect(reassertions({ mode: 'default' }, controls('default'))).toEqual([])
    })

    it('selection differing from the resumed value → re-asserted (the session/load reset case)', () => {
      // Resume reports Mode=default; the user had picked plan.
      expect(reassertions({ mode: 'plan' }, controls('default'))).toEqual([{ axis: 'mode', value: 'plan' }])
    })

    it('emits across multiple axes, skipping the ones that already match', () => {
      const out = reassertions(
        { mode: 'plan', model: 'mistral-medium-3.5', reasoningEffort: 'max' },
        controls('default', 'mistral-medium-3.5', 'high'),
      )
      expect(out).toEqual([
        { axis: 'mode', value: 'plan' }, // differs → re-assert
        { axis: 'reasoningEffort', value: 'max' }, // differs → re-assert; model matched → skipped
      ])
    })

    it('a cached axis the resumed session no longer advertises is NOT re-asserted (no setter target)', () => {
      const bound: ThreadAgentControls = { modes: null, models: null, reasoningEffort: null }
      expect(reassertions({ mode: 'plan' }, bound)).toEqual([])
    })
  })

  it('boundConfigValue reads a controls payload per axis (null when unadvertised)', () => {
    expect(boundConfigValue(controls('plan', 'devstral-small', 'max'), 'mode')).toBe('plan')
    expect(boundConfigValue(controls('plan', 'devstral-small', 'max'), 'model')).toBe('devstral-small')
    expect(boundConfigValue(controls('plan', 'devstral-small', 'max'), 'reasoningEffort')).toBe('max')
    expect(boundConfigValue({ modes: null, models: null, reasoningEffort: null }, 'mode')).toBeNull()
  })
})

describe('draftControls (#75)', () => {
  it('shows the connection defaults when there is no pre-pick (no lie)', () => {
    // A fresh draft (empty selected) must display the agent's connect-time current
    // values, so the default session the first prompt mints matches the display.
    const out = draftControls(controls('default', 'mistral-medium-3.5', 'high'), {})
    expect(out.modes?.currentModeId).toBe('default')
    expect(out.models?.currentModelId).toBe('mistral-medium-3.5')
    expect(out.reasoningEffort?.current).toBe('high')
  })

  it('overlays each axis with the cached pre-pick when present', () => {
    const out = draftControls(controls('default', 'mistral-medium-3.5', 'high'), {
      mode: 'plan',
      model: 'devstral-small',
      reasoningEffort: 'max',
    })
    expect(out.modes?.currentModeId).toBe('plan')
    expect(out.models?.currentModelId).toBe('devstral-small')
    expect(out.reasoningEffort?.current).toBe('max')
  })

  it('falls back per axis to the connection current when only some axes are pre-picked', () => {
    const out = draftControls(controls('default', 'mistral-medium-3.5', 'high'), { mode: 'plan' })
    expect(out.modes?.currentModeId).toBe('plan') // overlaid
    expect(out.models?.currentModelId).toBe('mistral-medium-3.5') // connection default
    expect(out.reasoningEffort?.current).toBe('high') // connection default
  })

  it('carries the connection option lists through unchanged', () => {
    const conn = controls('default', 'mistral-medium-3.5', 'high')
    const out = draftControls(conn, { mode: 'plan' })
    expect(out.modes?.availableModes).toEqual(conn.modes?.availableModes)
    expect(out.models?.availableModels).toEqual(conn.models?.availableModels)
    expect(out.reasoningEffort?.options).toEqual(conn.reasoningEffort?.options)
  })

  it('keeps an axis null when the agent advertises none (even with a stray pick)', () => {
    const none: ThreadAgentControls = { modes: null, models: null, reasoningEffort: null }
    const out = draftControls(none, { mode: 'plan', model: 'x', reasoningEffort: 'max' })
    expect(out.modes).toBeNull()
    expect(out.models).toBeNull()
    expect(out.reasoningEffort).toBeNull()
  })
})
