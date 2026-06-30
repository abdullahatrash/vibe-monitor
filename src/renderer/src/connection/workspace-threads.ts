import type { ThreadAgentControls, ThreadConfigAxis } from '../../../shared/ipc'

/**
 * Per-Workspace, per-session Thread state (ADR-0006, TB3 #48) — lifted OUT of
 * `ConnectedWorkspace` so the sidebar (and the nav reducer) is the single source
 * of truth for selection and live-state, and `ConnectedWorkspace` becomes a
 * controlled outlet. The warm pool keeps several Workspaces live at once, so this
 * is keyed by `workspaceId`, mirroring the connection registry.
 *
 * Per Workspace we track exactly what `ConnectedWorkspace` used to own internally:
 * - `live`: which Threads are hosted on THIS session's agent (the auto-opened
 *   Thread + drafts/continued Threads) — the source of truth for live-vs-cold
 *   routing (mirrors `routeThreadSelection`), NOT a stale persisted `sessionId`.
 * - `bound`: sessions minted this session (threadId -> sessionId), so switching
 *   away from a just-bound draft and back re-seeds it instead of re-minting.
 * - `active`: the Thread this Workspace is currently showing. Lifted so a
 *   BACKGROUND (hidden) Workspace keeps its in-flight Thread mounted/streaming
 *   while the user looks elsewhere — the keep-mounted outlet renders `active`.
 * - `config`: each live Thread's OWN agent-controls (#70), keyed by `threadId`.
 *   The home migrated here from the single connect-time `ThreadConnection` (#66
 *   sourced ALL Threads' picker from one Thread's values) — seeded per Thread on
 *   `connect` (the primary) and `bind` (drafts/continued), and updated
 *   OPTIMISTICALLY per Thread on a `set-config` (a change emits no notification,
 *   ADR-0007). So EVERY live Thread shows + changes its own Mode/Model/effort.
 * - `selected`: the user's last EXPLICIT pick per Thread per axis (#72), recorded
 *   only on a CONFIRMED change (IPC `{ok:true}`) — the in-memory cache that lets a
 *   resumed Thread come back to the user's choice. Vibe resets Mode to `default` on
 *   `session/load` (acp-capture §10), so a Thread whose session is lost (idle-evicted
 *   + re-warmed per TB5, or a cold continue) and resumed would silently revert. We
 *   re-assert `selected` after the resume's `bind`. CRITICAL: unlike `config`, this
 *   SURVIVES a `connect`-reset, so a re-warm keeps the cache (ADR-0007 keeps it OUT of
 *   the durable store, so a cold app-restart reopen has none — accepted/out of scope).
 *
 * A pure reducer + derivation (no React, no IPC), like the nav/connection reducers.
 */
export interface WorkspaceThreadState {
  live: ReadonlySet<string>
  bound: Readonly<Record<string, string>>
  active: string
  config: Readonly<Record<string, ThreadAgentControls>>
  selected: Readonly<Record<string, Partial<Record<ThreadConfigAxis, string>>>>
}

export type WorkspaceThreadsState = Readonly<Record<string, WorkspaceThreadState>>

export type WorkspaceThreadsAction =
  // A Workspace (re)connected: reset its live-state to the agent's auto-opened
  // Thread. Fired once per connection — a reconnect (new agent) deliberately drops
  // the prior session's drafts (their sessions died with the old process). Carries
  // the connect-time Thread's controls (#70) so its picker is seeded up front.
  | {
      type: 'connect'
      workspaceId: string
      threadId: string
      sessionId: string | null
      controls: ThreadAgentControls | null
    }
  // A draft was minted or a cold Thread continued: host it live and make it active.
  | { type: 'open'; workspaceId: string; threadId: string }
  // Switch which Thread the Workspace is showing (kept mounted when backgrounded).
  | { type: 'select'; workspaceId: string; threadId: string }
  // A draft's first prompt bound its session (`thread:bound`) — record it, and seed
  // THIS Thread's controls (#70) from the bind payload (null on a reuse — keep what's
  // there, don't clobber with null).
  | {
      type: 'bind'
      workspaceId: string
      threadId: string
      sessionId: string
      controls: ThreadAgentControls | null
    }
  // A live Thread was deleted (TB6): drop it from the live set + its bound session
  // + its config entry.
  | { type: 'remove'; workspaceId: string; threadId: string }
  // Optimistically reflect a per-Thread agent-control change (#70, ADR-0007): a
  // change emits no notification, so the renderer updates THIS Thread's displayed
  // current value the instant the user picks, then reverts (re-dispatching the prior
  // value) on an IPC failure. Keyed by `threadId` so a sibling Thread is untouched.
  | { type: 'set-config'; workspaceId: string; threadId: string; axis: ThreadConfigAxis; value: string }
  // Record the user's last EXPLICIT pick for a Thread's axis (#72), dispatched ONLY
  // after the change's IPC confirms (`{ok:true}`) — never on the optimistic display
  // update or a revert. This is the cache re-asserted after a resume; it survives a
  // `connect`-reset (a re-warm keeps it), so it lives apart from `config`.
  | { type: 'cache-selection'; workspaceId: string; threadId: string; axis: ThreadConfigAxis; value: string }

export const initialWorkspaceThreads: WorkspaceThreadsState = {}

export function workspaceThreadsReducer(
  state: WorkspaceThreadsState,
  action: WorkspaceThreadsAction,
): WorkspaceThreadsState {
  switch (action.type) {
    case 'connect': {
      // A reconnect (new agent) deliberately drops the prior session's live/bound/
      // active/config — those died with the old process. But the per-Thread selection
      // cache (#72) PERSISTS: a re-warm after eviction (TB5) must keep the user's last
      // pick so it can be re-asserted once the resumed session reports its (default)
      // values. `connect` is the only action that would otherwise wipe `selected`.
      const cur = state[action.workspaceId]
      return {
        ...state,
        [action.workspaceId]: {
          live: new Set([action.threadId]),
          bound: action.sessionId ? { [action.threadId]: action.sessionId } : {},
          active: action.threadId,
          config: action.controls ? { [action.threadId]: action.controls } : {},
          selected: cur?.selected ?? {},
        },
      }
    }
    case 'open': {
      const cur = state[action.workspaceId]
      if (!cur) return state
      const live = new Set(cur.live)
      live.add(action.threadId)
      return { ...state, [action.workspaceId]: { ...cur, live, active: action.threadId } }
    }
    case 'select': {
      const cur = state[action.workspaceId]
      if (!cur || cur.active === action.threadId) return state
      return { ...state, [action.workspaceId]: { ...cur, active: action.threadId } }
    }
    case 'bind': {
      const cur = state[action.workspaceId]
      if (!cur) return state
      const boundUnchanged = cur.bound[action.threadId] === action.sessionId
      // Seed this Thread's controls (#70) from the bind payload; a null payload
      // (reuse — no fresh result) leaves any existing entry untouched (no clobber).
      const config = action.controls
        ? { ...cur.config, [action.threadId]: action.controls }
        : cur.config
      if (boundUnchanged && config === cur.config) return state
      return {
        ...state,
        [action.workspaceId]: {
          ...cur,
          bound: boundUnchanged ? cur.bound : { ...cur.bound, [action.threadId]: action.sessionId },
          config,
        },
      }
    }
    case 'remove': {
      const cur = state[action.workspaceId]
      if (!cur || !cur.live.has(action.threadId)) return state
      const live = new Set(cur.live)
      live.delete(action.threadId)
      const bound = { ...cur.bound }
      delete bound[action.threadId]
      const config = { ...cur.config }
      delete config[action.threadId]
      const selected = { ...cur.selected }
      delete selected[action.threadId] // drop its cached picks too (#72)
      // `active` is left to the caller: deleting the active Thread is paired with a
      // `select` back to the connection's primary Thread (which is never deletable).
      return { ...state, [action.workspaceId]: { ...cur, live, bound, config, selected } }
    }
    case 'set-config': {
      // Optimistic per-Thread update (#70, ADR-0007). Same-ref-on-noop discipline:
      // no Workspace, no config entry for the Thread, an unadvertised axis, or an
      // unchanged value all return the SAME ref so a redundant pick (or a revert to
      // the value already shown) drives no re-render. Sibling Threads are untouched.
      const cur = state[action.workspaceId]
      const controls = cur?.config[action.threadId]
      if (!cur || !controls) return state
      const next = applyConfig(controls, action.axis, action.value)
      if (next === controls) return state
      return {
        ...state,
        [action.workspaceId]: { ...cur, config: { ...cur.config, [action.threadId]: next } },
      }
    }
    case 'cache-selection': {
      // Record a CONFIRMED pick (#72). Same-ref discipline: no Workspace, or the same
      // value already cached for this axis, returns the SAME ref so a redundant cache
      // can't churn the reducer. Unlike `set-config` this records even axes with no
      // seeded `config` — the cache is keyed only by the pick the IPC confirmed.
      const cur = state[action.workspaceId]
      if (!cur) return state
      const prev = cur.selected[action.threadId]
      if (prev?.[action.axis] === action.value) return state
      return {
        ...state,
        [action.workspaceId]: {
          ...cur,
          selected: { ...cur.selected, [action.threadId]: { ...prev, [action.axis]: action.value } },
        },
      }
    }
  }
}

/**
 * Apply an agent-control change to a Thread's controls bundle (#70), returning a
 * NEW `ThreadAgentControls` with only the targeted nested current updated — or the
 * SAME ref when the axis isn't advertised (null) or the value is already current, so
 * a no-op pick can't churn the reducer. (Migrated from the per-Workspace #66 home in
 * `connections.ts`, now keyed per Thread.)
 */
function applyConfig(
  controls: ThreadAgentControls,
  axis: ThreadConfigAxis,
  value: string,
): ThreadAgentControls {
  switch (axis) {
    case 'mode':
      if (!controls.modes || controls.modes.currentModeId === value) return controls
      return { ...controls, modes: { ...controls.modes, currentModeId: value } }
    case 'model':
      if (!controls.models || controls.models.currentModelId === value) return controls
      return { ...controls, models: { ...controls.models, currentModelId: value } }
    case 'reasoningEffort':
      if (!controls.reasoningEffort || controls.reasoningEffort.current === value) return controls
      return { ...controls, reasoningEffort: { ...controls.reasoningEffort, current: value } }
  }
}

/** A Workspace's live-state, or null when it has never connected this session. */
export function workspaceThreadStateFor(
  state: WorkspaceThreadsState,
  workspaceId: string | null,
): WorkspaceThreadState | null {
  if (!workspaceId) return null
  return state[workspaceId] ?? null
}

/**
 * One live Thread's agent-controls (#70), or null when none are seeded for it yet —
 * a Thread whose session hasn't bound (a never-prompted draft), or a reopened Thread
 * before its first prompt resumes. App feeds this to the active Thread's picker so it
 * sources its OWN Mode/Model/effort.
 */
export function configFor(
  state: WorkspaceThreadsState,
  workspaceId: string | null,
  threadId: string,
): ThreadAgentControls | null {
  if (!workspaceId) return null
  return state[workspaceId]?.config[threadId] ?? null
}

/**
 * A draft's agent-controls bundle (#75): a New-thread draft has no `config` seeded
 * (its session binds only on the first prompt), so it can't read `configFor`. Instead
 * we project the CONNECTION's advertised option lists with each axis's current value
 * overlaid by the user's cached pre-pick (`selected`) when present, else the
 * connection's OWN connect-time current — the agent default (`default` / a model id /
 * `high`). The connection's current is never optimistically mutated (#70 moved that to
 * `config`), so a no-pick draft shows the TRUE defaults — display == the session the
 * first prompt will mint. Each axis is null when the agent advertises none. The cached
 * pick is the SAME `selected` cache `reassertAfterResume` re-asserts once the draft
 * binds (#72), so the pre-pick applies exactly once on bind — no second apply path.
 */
export function draftControls(
  connectionControls: ThreadAgentControls,
  selected: Partial<Record<ThreadConfigAxis, string>>,
): ThreadAgentControls {
  const { modes, models, reasoningEffort } = connectionControls
  return {
    modes: modes ? { ...modes, currentModeId: selected.mode ?? modes.currentModeId } : null,
    models: models ? { ...models, currentModelId: selected.model ?? models.currentModelId } : null,
    reasoningEffort: reasoningEffort
      ? { ...reasoningEffort, current: selected.reasoningEffort ?? reasoningEffort.current }
      : null,
  }
}

/**
 * A Thread's CURRENT value for an agent-control axis (#70), or null when the axis
 * isn't advertised (or no controls are seeded). App reads this BEFORE an optimistic
 * `set-config` so it can revert to the prior value if the IPC change fails (ADR-0007).
 */
export function currentConfigValue(
  state: WorkspaceThreadsState,
  workspaceId: string,
  threadId: string,
  axis: ThreadConfigAxis,
): string | null {
  const controls = state[workspaceId]?.config[threadId]
  if (!controls) return null
  return boundConfigValue(controls, axis)
}

/**
 * A controls bundle's CURRENT value for an axis (#72) — the standalone read used both
 * by `currentConfigValue` (over the store) and by `reassertions`/the App re-assert
 * (over a freshly-`bound` payload, before it lands in the store). Null when the axis
 * isn't advertised.
 */
export function boundConfigValue(controls: ThreadAgentControls, axis: ThreadConfigAxis): string | null {
  switch (axis) {
    case 'mode':
      return controls.modes?.currentModeId ?? null
    case 'model':
      return controls.models?.currentModelId ?? null
    case 'reasoningEffort':
      return controls.reasoningEffort?.current ?? null
  }
}

/**
 * A Thread's cached EXPLICIT selections (#72), or an empty object when none — the
 * user's last confirmed pick per axis, surviving a `connect`-reset (re-warm). App
 * reads this after a resume's `bind` to decide what to re-assert.
 */
export function selectedFor(
  state: WorkspaceThreadsState,
  workspaceId: string | null,
  threadId: string,
): Partial<Record<ThreadConfigAxis, string>> {
  if (!workspaceId) return {}
  return state[workspaceId]?.selected[threadId] ?? {}
}

/**
 * The re-assertions a just-resumed Thread needs (#72): for each axis the user has a
 * cached `selected` for AND that the resumed session still ADVERTISES, emit
 * `{axis, value}` when it DIFFERS from the session's reported current (`bound`). A
 * resume resets Mode to `default` (acp-capture §10), so the user's prior non-default
 * pick differs and is re-asserted; an axis with no selection, one whose resumed value
 * already matches, or one the resumed session no longer advertises (`boundConfigValue`
 * null — there's no setter target) yields nothing. So a fresh mint (no cache) and a
 * faithful resume both no-op, and we never fire a doomed setter. Pure (no React, no IPC).
 */
export function reassertions(
  selected: Partial<Record<ThreadConfigAxis, string>>,
  bound: ThreadAgentControls,
): Array<{ axis: ThreadConfigAxis; value: string }> {
  const axes: ThreadConfigAxis[] = ['mode', 'model', 'reasoningEffort']
  const out: Array<{ axis: ThreadConfigAxis; value: string }> = []
  for (const axis of axes) {
    const want = selected[axis]
    if (want === undefined) continue
    const have = boundConfigValue(bound, axis)
    // Skip an unadvertised axis (have === null): the session has no setter target, so
    // re-asserting would fire a request that just errors.
    if (have !== null && have !== want) out.push({ axis, value: want })
  }
  return out
}
