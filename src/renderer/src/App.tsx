import { useEffect, useReducer, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  AuthMethod,
  ListMetadataResult,
  StartThreadResult,
  ThreadAgentControls,
  ThreadConfigAxis,
  ThreadConnection,
  ThreadMeta,
  VibeDetectResult,
} from '../../shared/ipc'
import {
  authReducer,
  initialAuthViewState,
  selectAuthView,
  signedInAuthViewState,
} from './auth/auth-view'
import { routeThreadResult, type ConnectState } from './connection/routing'
import {
  agentIdOf,
  connectedWorkspaceIds,
  connectionsReducer,
  initialConnections,
  selectedConnection,
  shouldConnect,
} from './connection/connections'
import {
  boundConfigValue,
  configFor,
  currentConfigValue,
  initialWorkspaceThreads,
  reassertions,
  selectedFor,
  workspaceThreadsReducer,
  workspaceThreadStateFor,
  type WorkspaceThreadState,
} from './connection/workspace-threads'
import { ConnectedWorkspace } from './connection/ConnectedWorkspace'
import { routeThreadSelection, seedSessionId } from './connection/thread-selection'
import { ColdThread } from './conversation/ColdThread'
import {
  clearThreadStatus,
  setThreadStatus,
  type ThreadStatusMap,
} from './conversation/thread-status'
import { clearDraft } from './conversation/composer-draft-store'
import { Shell, type WorkspaceFlags } from './shell/Shell'
import { firstRunState, type FirstRunState } from './shell/first-run'
import { findSelectedThread, initialNavState, navReducer } from './shell/nav-reducer'
import { deriveUnifiedThreads, workspaceFlags, type UnifiedThreadRow } from './shell/unified-threads'

/** A stable empty live-set for Workspaces with no live-state yet (no re-alloc). */
const NO_LIVE: ReadonlySet<string> = new Set()

/**
 * Thin glue (ADR-0006): App owns IPC/data wiring — detection, the persisted
 * Workspace/Thread metadata, NAVIGATION (the pure nav reducer), and the
 * PER-WORKSPACE connection registry — and renders the persistent `<Shell>`, which
 * is now a presentational two-pane layout fed a fully-computed outlet.
 *
 * The warm-agent pool (TB2 #47) keeps many Workspaces' agents alive at once, so
 * connection state is tracked PER Workspace (`connections`, keyed by `workspaceId`)
 * rather than TB1's single `connect`. Selecting a Workspace connect-or-REUSES its
 * warm agent and routes the outlet to THAT Workspace; every connected Workspace's
 * view stays MOUNTED (hidden when not selected) so its background turn keeps
 * streaming and switching back is instant with no re-handshake. The outlet is
 * routed off the NAV SELECTION (not a single global connect), so a cold click on a
 * never-connected Workspace replays correctly even after another connected
 * (TB1-review finding 2); the sidebar suppresses per-Thread highlights for a
 * connected Workspace, whose live view owns Thread selection (finding 1).
 */
export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  // Whether the on-demand environment/settings panel is open in the sidebar. The
  // env check is no longer a permanent top-level card (#49) — it's reachable here,
  // and surfaced prominently in the outlet only when it matters (first-run).
  const [showSettings, setShowSettings] = useState(false)
  // Navigation (decision 2): WHICH Workspace/Thread the user is looking at —
  // lifted here so the connect flow (Open project, Continue, sign-in) can drive it.
  const [nav, navDispatch] = useReducer(navReducer, initialNavState)
  // Per-Workspace connection registry (decision 3): one ConnectState per warm
  // Workspace, so switching between two is instant and both keep streaming.
  const [connections, connDispatch] = useReducer(connectionsReducer, initialConnections)
  // Per-Workspace, per-session Thread state (TB3 #48): the live set, bound sessions,
  // and the active (kept-mounted) Thread — lifted OUT of ConnectedWorkspace so the
  // sidebar + nav reducer are the single source of truth for selection/live-state.
  const [workspaceThreads, wtDispatch] = useReducer(workspaceThreadsReducer, initialWorkspaceThreads)
  // Per-Thread live status (TB3 #48, #53): streaming (turn in flight) +
  // needsAttention (pending permission), keyed by threadId. The SINGLE source is
  // now main's `thread:status` push (#53) — main owns the authoritative turn +
  // permission lifecycle, so this covers NON-active live Threads the renderer never
  // mounts, not just the active one. The fold returns the same ref when unchanged
  // so a redundant push can't loop.
  const [statuses, setStatuses] = useState<ThreadStatusMap>({})
  // Persisted Workspaces + Threads (ADR-0005), listed cold on launch from
  // metadata alone — no agent spawned, no transcript loaded.
  const [recents, setRecents] = useState<ListMetadataResult>([])
  // Workspaces with a connect IN FLIGHT, tracked synchronously so a fast double-
  // select can't fire two `startThread`s (the `connections` closure is stale
  // within a render frame, so a state check alone would let both through).
  const connectingRef = useRef<Set<string>>(new Set())
  // The committed selected Workspace, read synchronously by an async connect to
  // decide whether to pull focus to its just-opened Thread (don't yank focus if the
  // user has since switched away). Mirrors the latest rendered nav selection.
  const selectionRef = useRef<string | null>(nav.selectedWorkspaceId)
  selectionRef.current = nav.selectedWorkspaceId
  // Latest workspace-threads, mirrored into a ref so the async `onBound` re-assert
  // (#72) reads the CURRENT selection cache — its render-time closure is stale by the
  // time a resume's `thread:bound` fires (mirrors `selectionRef` above).
  const workspaceThreadsRef = useRef(workspaceThreads)
  workspaceThreadsRef.current = workspaceThreads

  async function runDetect(): Promise<void> {
    setLoading(true)
    const result = await window.api.detectVibe()
    setDetect(result)
    setLoading(false)
  }

  async function refreshRecents(): Promise<void> {
    setRecents(await window.api.listMetadata())
  }

  /**
   * Delete a Thread from the unified list (TB6 + #48 safe-delete). Main removes its
   * metadata + JSONL and best-effort closes any live session. The sidebar only
   * offers delete for a row `isThreadDeletable` proves safe (a cold row, or any
   * idle non-primary live row — its real per-Thread streaming is now observable for
   * ALL live Threads via main's push, #53), so we never tear a Thread out mid-stream.
   *
   * Reselection is gated on SELECTION, not liveness: `active`/`nav.selectedThreadId`
   * can legitimately point at a COLD (history) row, and dropping it from `recents`
   * would leave the outlet/sidebar pinned to a now-gone Thread. So whenever the
   * deleted Thread is the active/selected one of a CONNECTED Workspace, reselect the
   * connection's (always-live) primary Thread. The `wt remove` (drop from live-state)
   * runs ONLY when it was live; its stale status entry is cleared either way.
   *
   * Main re-validates streaming authoritatively and can REFUSE a delete that raced a
   * just-started turn (`{ok:false, reason:'streaming'}`, #53); we bail and leave the
   * row in place so the UI never drops a Thread main still hosts mid-stream.
   */
  async function deleteThread(thread: ThreadMeta): Promise<void> {
    const result = await window.api.deleteThread(thread.id)
    if (!result.ok) return
    const wts = workspaceThreadStateFor(workspaceThreads, thread.workspaceId)
    if (wts?.live.has(thread.id)) {
      wtDispatch({ type: 'remove', workspaceId: thread.workspaceId, threadId: thread.id })
    }
    const conn = connections[thread.workspaceId]
    const wasSelected = wts?.active === thread.id || nav.selectedThreadId === thread.id
    if (conn?.status === 'connected' && wasSelected) {
      selectThreadInWorkspace(thread.workspaceId, conn.thread.threadId)
    }
    setStatuses((prev) => clearThreadStatus(prev, thread.id))
    // Drop the deleted Thread's persisted composer draft (#60) — no orphaned text.
    clearDraft(window.localStorage, thread.id)
    await refreshRecents()
  }

  /**
   * Record a Workspace connect outcome: set its ConnectState and, when connected,
   * (re)seed its per-session live-state with the agent's auto-opened Thread. Pull
   * focus to that Thread when the user is still on this Workspace (`focus`, or the
   * live selection still matches) — so the sidebar highlights the live Thread and
   * the outlet routes to it, without yanking focus from a Workspace switched-to
   * while this connect was in flight.
   */
  function applyConnectResult(workspaceId: string, state: ConnectState, focus: boolean): void {
    connDispatch({ type: 'set', workspaceId, state })
    if (state.status !== 'connected') return
    // Seed the connect-time (primary) Thread's controls per-Thread (#70) from the
    // connection's `session/new` values — every sibling Thread later seeds its own on
    // `bind`. A non-default selection lost to a session reset (re-warm / cold continue)
    // is now re-asserted after the resume's `bind` via `reassertAfterResume` (#72), from
    // the per-Thread `selected` cache that survives this `connect`-reset.
    wtDispatch({
      type: 'connect',
      workspaceId,
      threadId: state.thread.threadId,
      sessionId: state.thread.sessionId,
      controls: {
        modes: state.thread.modes,
        models: state.thread.models,
        reasoningEffort: state.thread.reasoningEffort,
      },
    })
    if (focus || selectionRef.current === workspaceId) {
      navDispatch({ type: 'select-thread', workspaceId, threadId: state.thread.threadId })
    }
  }

  /**
   * Select a Thread from the sidebar (TB3 #48): pin it in nav (the single source of
   * truth) and, for a connected Workspace, remember it as the active (kept-mounted)
   * Thread so backgrounding the Workspace keeps it streaming.
   */
  function selectThreadInWorkspace(workspaceId: string, threadId: string): void {
    navDispatch({ type: 'select-thread', workspaceId, threadId })
    if (workspaceThreadStateFor(workspaceThreads, workspaceId)) {
      wtDispatch({ type: 'select', workspaceId, threadId })
    }
  }

  /**
   * Change an agent control for ONE Thread (#66/#70, ADR-0007): reflect the pick
   * OPTIMISTICALLY on THAT Thread's per-Thread config (keyed by `threadId` in the
   * workspace-threads store — a change emits no notification, so the `{}` result is
   * the only signal), fire the IPC, and on an `{ok:false}` REVERT to the value shown
   * before — leaving the control displaying the agent's real state — and surface the
   * error. Reads the prior value from the per-Thread config up front so the revert is
   * exact; a sibling Thread's controls are never touched.
   */
  function changeThreadConfig(
    workspaceId: string,
    agentId: string,
    threadId: string,
    axis: ThreadConfigAxis,
    value: string,
    sessionId: string,
  ): void {
    const prev = currentConfigValue(workspaceThreads, workspaceId, threadId, axis)
    if (prev === value) return // already current — no optimistic churn, no IPC round-trip
    wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value })
    void window.api.setThreadConfig({ agentId, sessionId, axis, value }).then((res) => {
      if (res.ok) {
        // Remember the CONFIRMED pick (#72) so a later resume (re-warm / cold continue)
        // re-asserts it — Vibe resets Mode to `default` on `session/load`. Cached only
        // here, never on the optimistic update or the revert below.
        wtDispatch({ type: 'cache-selection', workspaceId, threadId, axis, value })
        return
      }
      console.error(`Failed to set ${axis} to "${value}": ${res.error}`)
      if (prev !== null) wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value: prev })
    })
  }

  /**
   * Re-assert a Thread's cached selection after a resume (#72). Vibe resets Mode to
   * `default` on `session/load`, so a Thread whose session was lost (idle-evicted +
   * re-warmed per TB5, or a cold continue) and resumed reports its DEFAULT controls on
   * `thread:bound`. For each axis whose cached `selected` differs from the resumed
   * value, optimistically reflect it on the displayed config AND fire the IPC to put
   * the live session back to the user's choice — reverting (to the resumed value) +
   * logging on failure, mirroring `changeThreadConfig`. Reads the cache from the ref so
   * an async resume sees the latest, not its stale render-time closure. No-ops for a
   * fresh mint (no cache) and when the resumed value already matches.
   */
  function reassertAfterResume(
    workspaceId: string,
    agentId: string,
    threadId: string,
    sessionId: string,
    controls: ThreadAgentControls,
  ): void {
    const selected = selectedFor(workspaceThreadsRef.current, workspaceId, threadId)
    for (const { axis, value } of reassertions(selected, controls)) {
      const prev = boundConfigValue(controls, axis) // the resumed value to revert to
      wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value })
      void window.api.setThreadConfig({ agentId, sessionId, axis, value }).then((res) => {
        if (res.ok) return
        console.error(`Failed to re-assert ${axis} to "${value}": ${res.error}`)
        if (prev !== null) wtDispatch({ type: 'set-config', workspaceId, threadId, axis, value: prev })
      })
    }
  }

  /**
   * New-thread (#58): a renderer-only live draft, matching t3code. Mint a durable
   * Thread id locally (Chromium `crypto.randomUUID()`), host it LIVE on the selected
   * Workspace's agent + select it — but persist NOTHING. No `createDraft` IPC, no
   * metadata record, no JSONL, and nothing to `refreshRecents`. The draft becomes
   * durable only on its FIRST prompt, when `sendPrompt` carries THIS id to main's
   * `ensureBoundSession` → `mintAndBind`, which mints `session/new` and persists the
   * record under this preserved id. So an abandoned draft leaves zero residue and
   * vanishes on restart; the sidebar only ever lists prompted Threads.
   */
  function newThread(workspaceId: string): void {
    const threadId = crypto.randomUUID()
    wtDispatch({ type: 'open', workspaceId, threadId })
    navDispatch({ type: 'select-thread', workspaceId, threadId })
  }

  useEffect(() => {
    void runDetect()
    void refreshRecents()
  }, [])

  // Pool eviction (TB5 #50): when main evicts a warm agent (idle timeout or the
  // warm-count cap), drop the Workspaces holding those now-dead agentIds so the
  // next select re-warms lazily (a normal re-connect; history from the store, no
  // user-visible error). By contract the evicted agent is never the selected or
  // mid-turn one, so nothing the user is looking at vanishes. This also caps the
  // `acp:event` listener fan-out (bounded by MAX_WARM_AGENTS) — the prerequisite
  // #53 was waiting on; #53 itself (mounting all live siblings) is NOT done here.
  useEffect(() => {
    return window.api.onAgentEvicted((e) => {
      connDispatch({ type: 'evict', agentIds: new Set(e.agentIds) })
    })
  }, [])

  // Per-Thread status push (#53): main is the single source of truth for the
  // sidebar's streaming / needs-attention indicators — it tracks each Thread's
  // turn + permission lifecycle and pushes a change whenever a flag flips, for ALL
  // live Threads (active or not, since main doesn't depend on a mounted view).
  // Fold each update into the registry; the same-ref guard means a redundant push
  // can't trigger a render, so there's no status->render->report loop.
  //
  // Subscribe FIRST, then pull the current statuses once (a renderer that mounts /
  // dev-reloads mid-turn would otherwise miss an in-flight turn until the next
  // flip). The pull only ADDS a Thread the live channel hasn't already spoken for
  // (`threadId in prev`), so a stale snapshot can't revert a turn-end the push
  // already delivered during the round trip.
  useEffect(() => {
    const off = window.api.onThreadStatus((e) => {
      setStatuses((prev) =>
        setThreadStatus(prev, e.threadId, { streaming: e.streaming, needsAttention: e.needsAttention }),
      )
    })
    void window.api.getThreadStatuses().then((list) => {
      setStatuses((prev) =>
        list.reduce(
          (map, e) =>
            e.threadId in map
              ? map
              : setThreadStatus(map, e.threadId, { streaming: e.streaming, needsAttention: e.needsAttention }),
          prev,
        ),
      )
    })
    return off
  }, [])

  /**
   * Select a Workspace from the sidebar: pin it in the nav reducer and
   * connect-OR-REUSE its warm agent. A never-connected (or errored) Workspace
   * lazily spawns its agent; a warm one (connecting / not-signed-in / connected) is
   * reused as-is — instant, no second spawn or handshake.
   */
  function selectWorkspace(workspaceId: string): void {
    // Restore this Workspace's remembered active Thread (TB3 #48) so the sidebar
    // highlights it and the kept-mounted outlet shows it again; a never-connected
    // Workspace just pins the Workspace (its cold list drives the cold outlet).
    const wts = workspaceThreadStateFor(workspaceThreads, workspaceId)
    if (wts) navDispatch({ type: 'select-thread', workspaceId, threadId: wts.active })
    else navDispatch({ type: 'select-workspace', workspaceId })
    // Ignore a select while this Workspace's connect is already in flight (a fast
    // double-click) — the ref read is synchronous, so both clicks see it.
    if (connectingRef.current.has(workspaceId)) return
    if (shouldConnect(connections[workspaceId])) void connectWorkspace(workspaceId)
  }

  /** Spawn-or-reuse a Workspace's agent and record its connection (keyed by id). */
  async function connectWorkspace(workspaceId: string): Promise<void> {
    const workspace = recents.find((w) => w.id === workspaceId)
    if (!workspace) return
    connectingRef.current.add(workspaceId)
    connDispatch({ type: 'set', workspaceId, state: { status: 'connecting', workspaceDir: workspace.dir } })
    try {
      const result = await window.api.startThread({ workspaceDir: workspace.dir })
      applyConnectResult(workspaceId, routeThreadResult(result), false)
      void refreshRecents()
    } finally {
      connectingRef.current.delete(workspaceId)
    }
  }

  async function openProject(): Promise<void> {
    const workspaceDir = await window.api.openWorkspaceDialog()
    if (!workspaceDir) return
    // Already warm + connected? REUSE it — just select it. Re-opening would mint a
    // junk empty Thread on the (unchanged-agentId) ConnectedWorkspace, which won't
    // remount to show it.
    const warm = recents.find((w) => w.dir === workspaceDir)
    if (warm && connections[warm.id]?.status === 'connected') {
      navDispatch({ type: 'select-workspace', workspaceId: warm.id })
      return
    }
    setOpening(true)
    try {
      const result = await window.api.startThread({ workspaceDir })
      // Main has now persisted the Workspace (even on not-signed-in / error, since
      // it records the open BEFORE the handshake), so re-fetch to learn its minted
      // id, then key the connection by it and select it.
      const list = await window.api.listMetadata()
      setRecents(list)
      const ws = list.find((w) => w.dir === workspaceDir)
      if (!ws) {
        // Degraded (no store / failed list): we can't key or select this
        // connection, so dispose the just-spawned agent rather than leak a warm
        // connected child the renderer can never reach until quit.
        const agentId = agentIdOfResult(result)
        if (agentId) void window.api.stopAgent(agentId)
        return
      }
      navDispatch({ type: 'select-workspace', workspaceId: ws.id })
      applyConnectResult(ws.id, routeThreadResult(result), true)
    } finally {
      setOpening(false)
    }
  }

  // After sign-in (or in-place re-auth) the Workspace's warm agent is already
  // started + signed in; open a Thread on it and land in a connected conversation.
  async function continueToThread(workspaceId: string, agentId: string): Promise<void> {
    applyConnectResult(workspaceId, routeThreadResult(await window.api.openThread({ agentId })), true)
    void refreshRecents()
  }

  /**
   * Continue a reopened Thread from the sidebar's cold list (TB4 #33). Spawn-or-
   * reuse its Workspace agent via `startThread`, passing `continueThreadId` so main
   * opens NO extra Thread and instead seeds the connection with THIS Thread (its
   * first prompt drives the `session/load` resume). Select the Workspace so the
   * outlet routes to its now-connected view.
   */
  async function continueColdThread(thread: ThreadMeta): Promise<void> {
    const workspace = recents.find((w) => w.id === thread.workspaceId)
    if (!workspace) return
    navDispatch({ type: 'select-workspace', workspaceId: workspace.id })
    connDispatch({ type: 'set', workspaceId: workspace.id, state: { status: 'connecting', workspaceDir: workspace.dir } })
    const result = await window.api.startThread({ workspaceDir: workspace.dir, continueThreadId: thread.id })
    // Main opened NO extra Thread — the continued Thread IS the connection Thread, so
    // `applyConnectResult` seeds it live + selects it (its first prompt drives resume).
    applyConnectResult(workspace.id, routeThreadResult(result), true)
    void refreshRecents()
  }

  /** Sign-out / mid-session expiry: drop a Workspace back to its sign-in panel
   *  (same warm agent — never respawned). */
  function toSignInPanel(workspaceId: string, agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    connDispatch({ type: 'set', workspaceId, state: { status: 'not-signed-in', agentId, workspaceDir, authMethods } })
  }

  // The sidebar's pinned top: the Open-project control + a settings affordance that
  // reveals the environment status on demand (#49). The env card is no longer pinned
  // permanently — it lives behind this gear once everything's installed, and is
  // surfaced prominently in the outlet's first-run state when something's missing.
  const sidebarTop = (
    <div className="shell__top">
      <div className="shell__top-row">
        <button className="btn shell__open" onClick={() => void openProject()} disabled={opening}>
          {opening ? 'Connecting…' : 'Open project'}
        </button>
        <button
          className="btn btn--ghost shell__settings"
          aria-label="Environment & settings"
          title="Environment & settings"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
      {showSettings && (
        <Environment detect={detect} loading={loading} onRecheck={() => void runDetect()} />
      )}
    </div>
  )

  const connectedIds = connectedWorkspaceIds(connections)
  const selectedWs = nav.selectedWorkspaceId
  const selected = selectedConnection(connections, selectedWs)

  // Tell main which agent backs the ON-SCREEN Workspace (TB5 #50) so the pool
  // protects it from idle/cap eviction — the Workspace the user is looking at is
  // never evicted out from under them. Null when the selection has no warm agent
  // (idle/connecting/error); main also protects any mid-turn agent independently.
  const selectedAgentId = agentIdOf(selected)
  useEffect(() => {
    void window.api.setActiveAgent(selectedAgentId)
  }, [selectedAgentId])

  // Per-Workspace rolled-up live status for the switcher badges — what flags a
  // BACKGROUND Workspace blocked on a permission prompt (the deferred TB2 finding).
  const wsFlags: Record<string, WorkspaceFlags> = {}
  for (const wid of connectedIds) {
    const wts = workspaceThreadStateFor(workspaceThreads, wid)
    wsFlags[wid] = workspaceFlags(wts?.live ?? NO_LIVE, statuses)
  }

  // The ONE unified Thread list (cold + live merged) for the SELECTED Workspace,
  // plus its New/delete affordances. A connected Workspace merges its live set; a
  // cold/idle one lists its persisted Threads (clicking replays them, no agent).
  let rows: UnifiedThreadRow[] = []
  let protectedThreadId: string | null = null
  let canCreateThread = false
  if (selectedWs) {
    const cold = threadsForWorkspace(recents, selectedWs)
    if (selected.status === 'connected') {
      const conn = selected.thread
      const wts = workspaceThreadStateFor(workspaceThreads, selectedWs)
      rows = deriveUnifiedThreads({
        cold,
        live: liveMetasFor(conn, cold, wts),
        liveThreadIds: wts?.live ?? new Set([conn.threadId]),
        statuses,
      })
      protectedThreadId = conn.threadId
      canCreateThread = true
    } else {
      rows = deriveUnifiedThreads({ cold, live: [], liveThreadIds: NO_LIVE, statuses })
    }
  }

  /** The connected view for a Workspace (SignedInBar + the controlled outlet). */
  function renderConnected(conn: ThreadConnection): ReactNode {
    const wts = workspaceThreadStateFor(workspaceThreads, conn.workspaceId)
    const cold = threadsForWorkspace(recents, conn.workspaceId)
    const activeId = wts?.active ?? conn.threadId
    const activeThread =
      [...liveMetasFor(conn, cold, wts), ...cold].find((t) => t.id === activeId) ?? synthConnectionMeta(conn)
    // Route + seed via the same pure helpers the cold list uses: live-set membership
    // decides live-vs-cold; a session bound this session wins over the persisted cursor.
    const liveIds = wts?.live ?? new Set([conn.threadId])
    const isLive = routeThreadSelection(activeThread, liveIds) === 'live'
    const seed = seedSessionId(activeThread, wts?.bound ?? {})
    return (
      <>
        {/* Key by agentId (like Conversation) so its useReducer seed resets across
            connections — a new agent can't inherit the prior session's sign-out gate. */}
        <SignedInBar
          key={`bar-${conn.agentId}`}
          agentId={conn.agentId}
          authMethods={conn.authMethods}
          signOutAvailable={conn.signOutAvailable}
          onSignedOut={(authMethods) => toSignInPanel(conn.workspaceId, conn.agentId, conn.workspaceDir, authMethods)}
        />
        {/* Key by agentId so per-Workspace state can't bleed across connections.
            A controlled outlet now (TB3 #48): the sidebar drives selection; this just
            renders App's chosen active Thread live or cold. */}
        <ConnectedWorkspace
          key={conn.agentId}
          connection={conn}
          activeThread={activeThread}
          isLive={isLive}
          seedSessionId={seed}
          controls={configFor(workspaceThreads, conn.workspaceId, activeThread.id)}
          onSetConfig={(axis, value, sessionId) =>
            changeThreadConfig(conn.workspaceId, conn.agentId, activeThread.id, axis, value, sessionId)
          }
          onBound={(sessionId, controls) => {
            // Seed the displayed config from the bound session's reported values, then
            // re-assert the user's cached selection over them (#72) — a resume reports
            // defaults, so this restores a prior non-default Mode/Model/effort.
            wtDispatch({ type: 'bind', workspaceId: conn.workspaceId, threadId: activeThread.id, sessionId, controls })
            if (controls) reassertAfterResume(conn.workspaceId, conn.agentId, activeThread.id, sessionId, controls)
          }}
          onContinue={() => {
            wtDispatch({ type: 'open', workspaceId: conn.workspaceId, threadId: activeThread.id })
            navDispatch({ type: 'select-thread', workspaceId: conn.workspaceId, threadId: activeThread.id })
          }}
          onCloseCold={() => selectThreadInWorkspace(conn.workspaceId, conn.threadId)}
          onAuthExpired={(authMethods) => toSignInPanel(conn.workspaceId, conn.agentId, conn.workspaceDir, authMethods)}
        />
      </>
    )
  }

  // The outlet: every connected Workspace stays MOUNTED (hidden unless selected) so
  // its active Thread's turn keeps streaming and a switch-back is instant; the
  // selected Workspace's transient state (connecting / sign-in / error) or its cold
  // Thread renders inline. Routed off the nav selection, so cold clicks route right.
  //
  // Only the ACTIVE Thread per Workspace is mounted, but its sidebar indicators no
  // longer depend on that: main pushes per-Thread `streaming`/`needsAttention` for
  // ALL live Threads (#53), so a NON-active live sibling's in-flight turn or blocked
  // permission surfaces in the sidebar (and its delete gate) without a mounted view.
  const outlet = (
    <>
      {connectedIds.map((wid) => {
        const conn = connections[wid]
        if (conn.status !== 'connected') return null
        return (
          <div key={wid} className="shell__connection" hidden={wid !== selectedWs}>
            {renderConnected(conn.thread)}
          </div>
        )
      })}
      {selected.status === 'connected'
        ? null // rendered (visible) in the keep-mounted map above
        : selected.status !== 'idle'
          ? renderTransientOutlet(selected, {
              continueToThread: (agentId) => void continueToThread(selectedWs ?? '', agentId),
              onRetry: () => selectedWs && void connectWorkspace(selectedWs),
            })
          : renderColdOutlet(
              recents,
              nav,
              {
                onClose: () => navDispatch({ type: 'clear' }),
                onContinue: (thread) => void continueColdThread(thread),
              },
              <EmptyState
                state={firstRunState(detect, recents)}
                detect={detect}
                loading={loading}
                opening={opening}
                onRecheck={() => void runDetect()}
                onOpenProject={() => void openProject()}
              />,
            )}
    </>
  )

  return (
    <div className="app">
      <header className="app__header">
        <h1>Vibe Mistro</h1>
        <span className="app__subtitle">Orchestrator for Mistral Vibe agents · ACP backend</span>
      </header>

      <Shell
        workspaces={recents}
        sidebarTop={sidebarTop}
        nav={nav}
        workspaceFlags={wsFlags}
        rows={rows}
        protectedThreadId={protectedThreadId}
        canCreateThread={canCreateThread}
        outlet={outlet}
        onSelectWorkspace={selectWorkspace}
        onSelectThread={selectThreadInWorkspace}
        onNewThread={() => selectedWs && newThread(selectedWs)}
        onDeleteThread={deleteThread}
      />
    </div>
  )
}

/**
 * The metas for a Workspace's live Threads (TB3 #48), feeding the unified-list
 * merge. A live Thread already in the cold list reuses that meta; one not yet
 * persisted is synthesized so it shows immediately — the agent's auto-opened Thread
 * (before the metadata refresh lands) or a freshly minted draft (its bound session,
 * if any, seeds its live view).
 */
function liveMetasFor(
  conn: ThreadConnection,
  cold: ThreadMeta[],
  wts: WorkspaceThreadState | null,
): ThreadMeta[] {
  const byId = new Map(cold.map((t) => [t.id, t]))
  const ids = wts ? wts.live : new Set([conn.threadId])
  const metas: ThreadMeta[] = []
  for (const id of ids) {
    const existing = byId.get(id)
    if (existing) metas.push(existing)
    else if (id === conn.threadId) metas.push(synthConnectionMeta(conn))
    else
      metas.push({
        id,
        workspaceId: conn.workspaceId,
        sessionId: wts?.bound[id] ?? null,
        title: null,
        createdAt: 0,
        lastActiveAt: 0,
      })
  }
  return metas
}

/** Synthesize the connection's auto-opened Thread meta (when the list lags). */
function synthConnectionMeta(conn: ThreadConnection): ThreadMeta {
  return {
    id: conn.threadId,
    workspaceId: conn.workspaceId,
    sessionId: conn.sessionId,
    title: conn.title,
    createdAt: 0,
    lastActiveAt: 0,
  }
}

/**
 * The pool-minted `agentId` a `startThread` result carries, when any — present on
 * a connected (`thread.agentId`) or not-signed-in (`agentId`) result, absent on a
 * non-auth error (main already disposed that agent). Used to dispose a warm agent
 * the renderer can't key in degraded mode (no store).
 */
function agentIdOfResult(result: StartThreadResult): string | null {
  if (result.ok) return result.thread.agentId
  if (result.kind === 'not-signed-in') return result.agentId
  return null
}

/**
 * The selected Workspace's NON-connected outlet state (connecting / not-signed-in /
 * error). Only the selected Workspace shows a transient view; connected Workspaces
 * render via the keep-mounted map instead.
 */
function renderTransientOutlet(
  connect: ConnectState,
  handlers: { continueToThread: (agentId: string) => void; onRetry: () => void },
): ReactNode {
  switch (connect.status) {
    case 'connecting':
      return (
        <div className="connecting">
          <span className="dot dot--pending" aria-hidden />
          <div className="connecting__title">Connecting…</div>
          <div className="connecting__message">
            Launching <code>vibe-acp</code> in <code>{connect.workspaceDir}</code> and running the
            ACP handshake.
          </div>
        </div>
      )
    case 'not-signed-in':
      return (
        <SignInPanel
          key={connect.agentId}
          agentId={connect.agentId}
          authMethods={connect.authMethods}
          onSignedIn={() => handlers.continueToThread(connect.agentId)}
        />
      )
    case 'error':
      return (
        <div className="alert">
          <div className="alert__title">Couldn’t connect</div>
          <div className="alert__message">{connect.message}</div>
          {connect.hint && <div className="alert__hint">{connect.hint}</div>}
          <button className="btn alert__action" onClick={handlers.onRetry}>
            Retry
          </button>
        </div>
      )
    default:
      return null
  }
}

/**
 * The idle (no live agent) outlet for the selected Workspace: the nav-selected cold
 * Thread replayed read-only from JSONL (TB3) with a Continue affordance (TB4), or a
 * placeholder when nothing is selected. Reached only when the selected Workspace has
 * no connection — so a cold click after another Workspace connected still routes here.
 */
function renderColdOutlet(
  recents: ListMetadataResult,
  nav: { selectedWorkspaceId: string | null; selectedThreadId: string | null },
  handlers: { onClose: () => void; onContinue: (thread: ThreadMeta) => void },
  empty: ReactNode,
): ReactNode {
  const selectedThread = findSelectedThread(recents, nav)
  if (!selectedThread) return empty
  return (
    <ColdThread
      key={selectedThread.id}
      thread={selectedThread}
      onClose={handlers.onClose}
      onContinue={() => handlers.onContinue(selectedThread)}
    />
  )
}

/**
 * The first-run / empty outlet shown when nothing is connected or selected (#49).
 * Driven by the pure `firstRunState`: when `vibe` / `vibe-acp` is missing the env
 * status is surfaced PROMINENTLY here (the user can't proceed until it's installed);
 * when the toolchain's present but no Workspaces exist it nudges Open-project; once
 * everything's set up it's a neutral placeholder (env tucked behind settings).
 */
function EmptyState({
  state,
  detect,
  loading,
  opening,
  onRecheck,
  onOpenProject,
}: {
  state: FirstRunState
  detect: VibeDetectResult | null
  loading: boolean
  opening: boolean
  onRecheck: () => void
  onOpenProject: () => void
}): JSX.Element {
  if (state === 'needs-install') {
    return (
      <div className="empty empty--install">
        <div className="empty__title">Install Mistral Vibe to get started</div>
        <p className="hint">
          vibe-mistro drives the <code>vibe-acp</code> ACP server. Install the Mistral Vibe CLI and{' '}
          <code>vibe-acp</code>, then re-check below.
        </p>
        <Environment detect={detect} loading={loading} onRecheck={onRecheck} />
      </div>
    )
  }
  if (state === 'no-workspaces') {
    return (
      <div className="empty">
        <div className="empty__title">No workspaces yet</div>
        <p className="hint">Open a project to spawn its agent and start a thread.</p>
        <button className="btn" onClick={onOpenProject} disabled={opening}>
          {opening ? 'Connecting…' : 'Open project'}
        </button>
      </div>
    )
  }
  return (
    <div className="shell__empty">
      <p className="hint">
        Select a thread from the sidebar to view it, or open a project to start a live agent.
      </p>
    </div>
  )
}

/** The environment check: whether `vibe` / `vibe-acp` are installed + reachable. */
function Environment({
  detect,
  loading,
  onRecheck,
}: {
  detect: VibeDetectResult | null
  loading: boolean
  onRecheck: () => void
}): JSX.Element {
  return (
    <div className="env">
      <div className="env__title">
        <span>Environment</span>
        <button className="btn btn--ghost" onClick={onRecheck} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {detect && (
        <ul className="status">
          <StatusRow ok={detect.vibeFound} label="vibe CLI" />
          <StatusRow ok={detect.vibeAcpFound} label="vibe-acp (ACP server)" />
          <li className="status__row">
            <span className="status__label">version</span>
            <span className="status__value">{detect.vibeVersion ?? '—'}</span>
          </li>
          {detect.error && <li className="status__error">{detect.error}</li>}
        </ul>
      )}
    </div>
  )
}

/**
 * The not-signed-in panel: clicking Sign-in drives Vibe's delegated browser
 * sign-in via main; on success it bubbles up (`onSignedIn`) so the app opens a
 * Thread on the same retained agent and lands in a connected conversation. The
 * auth lifecycle (signing-in / signed-in / error) is the pure `authReducer`.
 */
function SignInPanel({
  agentId,
  authMethods,
  onSignedIn,
}: {
  agentId: string
  authMethods: AuthMethod[]
  onSignedIn: () => void
}): JSX.Element {
  const [state, dispatch] = useReducer(authReducer, authMethods, initialAuthViewState)
  // Generation counter: bumped on every attempt start and on cancel. Neither the
  // delegated `complete` long-poll nor the blocking `browser-auth` call can be
  // aborted over ACP, so a cancelled (or superseded) attempt's eventual result
  // must be ignored rather than clobber the panel — we only apply a result whose
  // generation is still current. (This guard is method-agnostic: it covers both
  // the delegated primary and the blocking fallback.)
  const attemptRef = useRef(0)
  const view = selectAuthView(state)

  async function signIn(methodId: string): Promise<void> {
    const attempt = ++attemptRef.current
    dispatch({ type: 'sign-in-start' })
    const result = await window.api.signIn({ agentId, methodId })
    if (attempt !== attemptRef.current) return // cancelled/superseded — drop the stale result
    if (result.ok && result.authState === 'signed-in') {
      dispatch({ type: 'sign-in-success' })
      onSignedIn() // continue to a connected Thread on the same agent
    } else {
      dispatch({
        type: 'sign-in-error',
        message: result.ok ? 'Sign-in did not complete. Please try again.' : result.error,
      })
    }
  }

  function cancel(): void {
    attemptRef.current++ // invalidate the in-flight attempt; its result is dropped
    dispatch({ type: 'sign-in-cancel' })
  }

  if (view.kind === 'signed-in') {
    return (
      <div className="signin signin--done">
        <div className="signin__title">Signed in — opening your workspace…</div>
      </div>
    )
  }

  if (view.kind === 'signing-out') {
    return (
      <div className="signin">
        <div className="signin__title">Signing out…</div>
      </div>
    )
  }

  if (view.kind === 'signing-in') {
    return (
      <div className="signin">
        <div className="signin__title">Signing in…</div>
        <div className="signin__message">Complete sign-in in your browser, then return here.</div>
        <button className="btn btn--ghost signin__action" onClick={cancel}>
          Cancel
        </button>
      </div>
    )
  }

  // sign-in or error: both render the (clickable) Sign-in button so the error
  // state stays recoverable.
  return (
    <div className="signin">
      <div className="signin__title">Not signed in to Mistral Vibe</div>
      {view.kind === 'sign-in' && view.description && (
        <div className="signin__message">{view.description}</div>
      )}
      {view.kind === 'error' && <div className="signin__error">{view.message}</div>}
      <button className="btn signin__action" onClick={() => void signIn(view.methodId)}>
        {view.kind === 'error' ? `Retry — ${view.methodName}` : view.methodName}
      </button>
    </div>
  )
}

/**
 * The signed-in indicator shown while connected: status + a Sign-out control
 * gated on `signOutAvailable` (Vibe exposes no account identity, so none is
 * shown). Sign-out returns to the sign-in panel (`onSignedOut`) for an account
 * switch. The sign-out lifecycle is the pure `authReducer`.
 */
function SignedInBar({
  agentId,
  authMethods,
  signOutAvailable,
  onSignedOut,
}: {
  agentId: string
  authMethods: AuthMethod[]
  signOutAvailable: boolean
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element | null {
  const [state, dispatch] = useReducer(
    authReducer,
    signedInAuthViewState(authMethods, signOutAvailable),
  )
  const view = selectAuthView(state)

  async function signOut(): Promise<void> {
    dispatch({ type: 'sign-out-start' })
    const result = await window.api.signOut({ agentId })
    if (result.ok) {
      dispatch({ type: 'sign-out-success' })
      onSignedOut(result.authMethods)
    } else {
      dispatch({ type: 'sign-out-error', message: result.error })
    }
  }

  if (view.kind === 'signing-out') {
    return (
      <div className="signedin">
        <span className="signedin__label">Signing out…</span>
      </div>
    )
  }

  if (view.kind !== 'signed-in') return null

  return (
    <div className="signedin">
      <span className="dot dot--ok" aria-hidden />
      <span className="signedin__label">Signed in to Mistral Vibe</span>
      {view.identity && <span className="signedin__identity">{view.identity}</span>}
      {view.error && <span className="signedin__error">{view.error}</span>}
      <span className="signedin__spacer" />
      {view.signOutAvailable && (
        <button className="btn btn--ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      )}
    </div>
  )
}

/** The persisted Threads under a connected Workspace (by minted id), for its list (TB5). */
function threadsForWorkspace(recents: ListMetadataResult, workspaceId: string): ThreadMeta[] {
  return recents.find((w) => w.id === workspaceId)?.threads ?? []
}

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
