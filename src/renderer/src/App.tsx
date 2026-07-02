import { useEffect, useReducer, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  AuthMethod,
  ListMetadataResult,
  StartThreadResult,
  ThreadConnection,
  ThreadMeta,
  VibeDetectResult,
} from '../../shared/ipc'
import { routeThreadResult } from './connection/routing'
import {
  agentIdOf,
  connectedWorkspaceIds,
  connectionsReducer,
  initialConnections,
  selectedConnection,
  shouldConnect,
} from './connection/connections'
import {
  initialWorkspaceThreads,
  workspaceThreadsReducer,
  workspaceThreadStateFor,
  type WorkspaceThreadState,
} from './connection/workspace-threads'
import { ConnectedWorkspace } from './connection/ConnectedWorkspace'
import { routeThreadSelection, seedSessionId } from './connection/thread-selection'
import { useThreadControls } from './connection/use-thread-controls'
import { useWorkspaceActions } from './connection/use-workspace-actions'
import { resolveActiveControls } from './connection/resolve-controls'
import { setThreadStatus, type ThreadStatusMap } from './conversation/thread-status'
import { setWorkspaceControls, workspaceControlsKey } from './connection/workspace-controls-store'
import { ArrowLeft, ArrowRight, Maximize2, PanelLeft, PanelRight, Terminal } from 'lucide-react'
import { IconButton } from './ui/icon-button'
import { Shell, type WorkspaceFlags } from './shell/Shell'
import { firstRunState } from './shell/first-run'
import { initialNavState, navReducer } from './shell/nav-reducer'
import {
  getSidebarCollapsed,
  setSidebarCollapsed as setSidebarCollapsedStore,
} from './shell/sidebar-collapsed-store'
import { toggleWorkspacePanelVisibility, useWorkspacePanel } from './side-panel/side-panel-store'
import { deriveUnifiedThreads, workspaceFlags, type UnifiedThreadRow } from './shell/unified-threads'
import { EmptyState } from './shell/EmptyState'
import { ColdOutlet, TransientOutlet } from './shell/Outlet'
import { SettingsView } from './settings/SettingsView'

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
 *
 * The Workspace/Thread lifecycle mutations live in `useWorkspaceActions` and the
 * per-Thread agent-controls choreography in `useThreadControls` — App wires live
 * state into them; the auth/settings/empty-state UIs live in their feature slices.
 */
export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState(false)
  // Whether the left sidebar is collapsed (#127): renderer-only UI chrome, seeded
  // from localStorage (default expanded) and persisted best-effort on toggle. It
  // never touches nav/selection/connections — the <aside> stays mounted, its width
  // just animates to 0 so the outlet reclaims the space.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    getSidebarCollapsed(window.localStorage),
  )
  function toggleSidebar(): void {
    setSidebarCollapsed((prev) => {
      const next = !prev
      setSidebarCollapsedStore(window.localStorage, next)
      return next
    })
  }
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

  // The per-Thread agent-controls choreography (#66/#70/#72/#75, ADR-0007): the
  // optimistic-apply/revert/cache idiom + the stale-closure mirror ref live in the hook.
  const controls = useThreadControls(workspaceThreads, wtDispatch)

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
   * Select a Thread from the sidebar (TB3 #48): pin it in nav (the single source of
   * truth) and open it READY TO RESUME — no Continue step (#resume-on-first-prompt):
   *
   * - Connected Workspace: host the Thread live immediately (`open`). Conversation
   *   hydrates its JSONL history for instant reading, the composer is ENABLED, and
   *   its FIRST prompt resumes the stored session via main's `ensureBoundSession`
   *   (`session/load`, re-binding fresh + "context reset" notice on failure) — the
   *   exact lazy binding a draft uses, so reading stays free until you actually send.
   * - No connection yet (cold app start / evicted agent): auto-continue — spawn-or-
   *   reuse the Workspace agent seeded with THIS Thread (`continueColdThread`), the
   *   same call the old Continue button made, just without the button.
   * - Connecting / sign-in / error: nav-select only; the transient outlet resolves.
   */
  function selectThreadInWorkspace(workspaceId: string, threadId: string): void {
    navDispatch({ type: 'select-thread', workspaceId, threadId })
    const status = connections[workspaceId]?.status
    if (status === 'connected') {
      wtDispatch({ type: 'open', workspaceId, threadId })
      return
    }
    if (workspaceThreadStateFor(workspaceThreads, workspaceId)) {
      wtDispatch({ type: 'select', workspaceId, threadId })
    }
    if (status === undefined) {
      const meta = threadsForWorkspace(recents, workspaceId).find((t) => t.id === threadId)
      if (meta) void continueColdThread(meta)
    }
  }

  // The Workspace/Thread lifecycle mutations (delete / remove-project / flags /
  // rename): multi-store reconciliation behind one seam (use-workspace-actions.ts).
  const actions = useWorkspaceActions({
    recents,
    nav,
    connections,
    workspaceThreads,
    navDispatch,
    connDispatch,
    wtDispatch,
    setStatuses,
    refreshRecents,
    selectThreadInWorkspace,
    storage: window.localStorage,
  })

  /**
   * Record a Workspace connect outcome: set its ConnectState and, when connected,
   * (re)seed its per-session live-state with the agent's auto-opened Thread. Pull
   * focus to that Thread when the user is still on this Workspace (`focus`, or the
   * live selection still matches) — so the sidebar highlights the live Thread and
   * the outlet routes to it, without yanking focus from a Workspace switched-to
   * while this connect was in flight.
   */
  function applyConnectResult(workspaceId: string, result: StartThreadResult, focus: boolean): void {
    const state = routeThreadResult(result)
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

  /**
   * Start a new thread in a SPECIFIC project from its sidebar ＋ (#138/#131): the
   * deliberate "start working here" trigger (folding a project is peek-only and never
   * connects). If the project is ALREADY connected, mint a draft on its warm agent
   * (`newThread`); otherwise `selectWorkspace` it — which pins it in nav and
   * spawns/reuses its agent, landing on a live thread to work in. Reuses the existing
   * functions; keeps `selectWorkspace` reachable now that the header fold no longer
   * calls it.
   */
  function newThreadInWorkspace(workspaceId: string): void {
    if (connections[workspaceId]?.status === 'connected') newThread(workspaceId)
    else selectWorkspace(workspaceId)
  }

  /**
   * The sidebar's primary "New chat" — always actionable (no longer greyed out until a
   * project happens to be connected). Targets the selected project, else the most-recent
   * one (`recents` is most-recent-first); if there are NO projects yet, opens the project
   * picker. Reuses `newThreadInWorkspace` (connect-if-needed), so a fresh app can start a
   * chat in one click.
   */
  function startNewChat(): void {
    const target = nav.selectedWorkspaceId ?? recents[0]?.id ?? null
    if (target) newThreadInWorkspace(target)
    else void openProject()
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

  // A Thread's title is auto-generated by vibe-acp from its FIRST prompt and pushed
  // after the fact (never in `session/new`), so a fresh draft is genuinely untitled
  // until then. Main persists the pushed title; re-pull the cold list so the sidebar
  // shows it (the ACTIVE Thread's header already updates live via the reducer). Titles
  // are low-frequency (once per Thread), so a re-pull per push is cheap and correct —
  // and it also lands a just-bound draft that wasn't yet in `recents`.
  useEffect(() => {
    return window.api.onThreadTitle(() => {
      void refreshRecents()
    })
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
      applyConnectResult(workspaceId, result, false)
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
        // Degraded (a failed persist / list): we can't key or select this
        // connection, so dispose the just-spawned agent rather than leak a warm
        // connected child the renderer can never reach until quit.
        const agentId = agentIdOfResult(result)
        if (agentId) void window.api.stopAgent(agentId)
        return
      }
      navDispatch({ type: 'select-workspace', workspaceId: ws.id })
      applyConnectResult(ws.id, result, true)
    } finally {
      setOpening(false)
    }
  }

  // After sign-in (or in-place re-auth) the Workspace's warm agent is already
  // started + signed in; open a Thread on it and land in a connected conversation.
  async function continueToThread(workspaceId: string, agentId: string): Promise<void> {
    applyConnectResult(workspaceId, await window.api.openThread({ agentId }), true)
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
    applyConnectResult(workspace.id, result, true)
    void refreshRecents()
  }

  /** Sign-out / mid-session expiry: drop a Workspace back to its sign-in panel
   *  (same warm agent — never respawned). */
  function toSignInPanel(workspaceId: string, agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    connDispatch({ type: 'set', workspaceId, state: { status: 'not-signed-in', agentId, workspaceDir, authMethods } })
  }

  const connectedIds = connectedWorkspaceIds(connections)
  const selectedWs = nav.selectedWorkspaceId
  const selected = selectedConnection(connections, selectedWs)
  // The selected Workspace's side-panel state (#193): the window-header PanelRight icon
  // reflects + toggles the ACTIVE Workspace's panel directly through the shared
  // side-panel-store (per-Workspace, replacing the old app-global open flag). An empty-
  // string key when nothing's selected resolves to the frozen closed state; the toggle
  // then no-ops (no panel is mounted to show anyway — the panel lives in a connected view).
  const activePanel = useWorkspacePanel(selectedWs ?? '')
  // The selected Workspace's display name, for the empty-state hero headline (#113).
  const selectedWorkspaceName = recents.find((w) => w.id === selectedWs)?.displayName ?? null

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
    } else {
      rows = deriveUnifiedThreads({ cold, live: [], liveThreadIds: NO_LIVE, statuses })
    }
  }

  /** The connected view for a Workspace (the controlled outlet). `busy` is the
   *  Workspace's rolled-up streaming flag (#86) — threaded to the Changes panel so the
   *  commit affordance is disabled while a turn is in flight (the v1 guard). Sign-out now
   *  lives in the Settings page (`AccountSettings`), not a banner atop the chat. */
  function renderConnected(conn: ThreadConnection, isActive: boolean, busy: boolean): ReactNode {
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
      // Key by agentId so per-Workspace state can't bleed across connections.
      // A controlled outlet now (TB3 #48): the sidebar drives selection; this just
      // renders App's chosen active Thread live or cold.
      <ConnectedWorkspace
        key={conn.agentId}
        connection={conn}
        activeThread={activeThread}
        isLive={isLive}
        isActive={isActive}
        busy={busy}
        seedSessionId={seed}
        controls={resolveActiveControls(workspaceThreads, conn, activeThread.id, window.localStorage)}
        onSetConfig={(axis, value, sessionId) => {
          // A real session => the bound IPC path (#70); a null session => a draft
          // pre-pick that only caches (#75), applied to the session on first bind.
          if (sessionId) {
            controls.changeThreadConfig(conn.workspaceId, conn.agentId, activeThread.id, axis, value, sessionId)
          } else {
            controls.preselectDraftConfig(conn.workspaceId, activeThread.id, axis, value)
          }
        }}
        onBound={(sessionId, boundControls) => {
          // Seed the displayed config from the bound session's reported values, then
          // re-assert the user's cached selection over them (#72) — a resume reports
          // defaults, so this restores a prior non-default Mode/Model/effort.
          wtDispatch({ type: 'bind', workspaceId: conn.workspaceId, threadId: activeThread.id, sessionId, controls: boundControls })
          if (boundControls) {
            controls.reassertAfterResume(conn.workspaceId, conn.agentId, activeThread.id, sessionId, boundControls)
            // Cache the bound session's option lists per Workspace (#153) so the NEXT
            // never-bound draft here shows the picker before its own first prompt binds.
            setWorkspaceControls(
              window.localStorage,
              workspaceControlsKey(conn.workspaceId, conn.workspaceDir),
              boundControls,
            )
          }
        }}
        onContinue={() => {
          wtDispatch({ type: 'open', workspaceId: conn.workspaceId, threadId: activeThread.id })
          navDispatch({ type: 'select-thread', workspaceId: conn.workspaceId, threadId: activeThread.id })
        }}
        onCloseCold={() => selectThreadInWorkspace(conn.workspaceId, conn.threadId)}
        onAuthExpired={(authMethods) => toSignInPanel(conn.workspaceId, conn.agentId, conn.workspaceDir, authMethods)}
      />
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
  // The on-demand Settings page (#130): a top-level outlet view, routed by the nav
  // reducer (`nav.view === 'settings'`), that hosts the env/CLI detection status the
  // sidebar gear used to toggle. It swaps the conversation/cold/empty outlet WITHOUT
  // unmounting the connected Workspaces — they stay mounted-but-hidden so a background
  // turn keeps streaming, and closing Settings returns to exactly the same view.
  // <main> is full-bleed now (the side panel reaches the window edges, t3code-style),
  // so each NON-connected view re-adds the old p-6 breathing room via a wrapper here;
  // the connected view spends it inside its chat column (ConnectedWorkspace) instead.
  const inSettings = nav.view === 'settings'
  const outlet = (
    <>
      {connectedIds.map((wid) => {
        const conn = connections[wid]
        if (conn.status !== 'connected') return null
        return (
          // h-full: complete the height chain from <main> down to `.conv` (100%)
          // so the transcript scrolls internally and the Composer stays pinned.
          <div key={wid} className="h-full" hidden={inSettings || wid !== selectedWs}>
            {renderConnected(conn.thread, !inSettings && wid === selectedWs, wsFlags[wid]?.streaming ?? false)}
          </div>
        )
      })}
      {inSettings ? (
        <div className="p-6">
          <SettingsView
          detect={detect}
          loading={loading}
          onRecheck={() => void runDetect()}
          onClose={() => navDispatch({ type: 'close-settings' })}
          account={
            // The signed-in account for the selected Workspace's warm agent, when
            // one is connected — else null (Account shows "not connected"). Guarded
            // behind the connected check so `selected.thread` is safe to read.
            selected.status === 'connected'
              ? {
                  agentId: selected.thread.agentId,
                  authMethods: selected.thread.authMethods,
                  signOutAvailable: selected.thread.signOutAvailable,
                }
              : null
          }
          onSignedOut={(authMethods) => {
            // After sign-out drop that Workspace to its sign-in panel (same warm
            // agent) and close Settings, landing the user on the sign-in view.
            if (selected.status !== 'connected') return
            toSignInPanel(
              selected.thread.workspaceId,
              selected.thread.agentId,
              selected.thread.workspaceDir,
              authMethods,
            )
            navDispatch({ type: 'close-settings' })
          }}
        />
        </div>
      ) : selected.status === 'connected' ? null : ( // connected: rendered (visible) in the keep-mounted map above
        // h-full so a cold Thread's `.conv` (height: 100%) keeps its internal scroll.
        <div className="h-full p-6">
          {selected.status !== 'idle' ? (
            <TransientOutlet
              connect={selected}
              onContinueToThread={(agentId) => void continueToThread(selectedWs ?? '', agentId)}
              onRetry={() => selectedWs && void connectWorkspace(selectedWs)}
            />
          ) : (
            <ColdOutlet
              recents={recents}
              nav={nav}
              onClose={() => navDispatch({ type: 'clear' })}
              onContinue={(thread) => void continueColdThread(thread)}
              empty={
                <EmptyState
                  state={firstRunState(detect, recents)}
                  detect={detect}
                  loading={loading}
                  opening={opening}
                  workspaceName={selectedWorkspaceName}
                  onRecheck={() => void runDetect()}
                  onOpenProject={() => void openProject()}
                />
              }
            />
          )}
        </div>
      )}
    </>
  )

  // On macOS the window uses `titleBarStyle: 'hiddenInset'` (main/index.ts), so the OS
  // draws the real traffic lights inset over the top-left of the content. Reserve room
  // for them instead of drawing our own fake set (which duplicated them into two rows).
  const isMac = navigator.userAgent.includes('Macintosh')

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      {/* Window chrome (#113): a draggable top bar. Back/forward and the top-right
          layout-mode icons are STATIC placeholders (#future) — styled but non-functional.
          The bar stays `-webkit-app-region: drag` so the window moves; every interactive
          control opts back out with `[-webkit-app-region:no-drag]`. On macOS we pad the
          left edge so the OS traffic lights don't collide with our controls. */}
      <header
        className="flex h-11 flex-none items-center gap-2 border-b border-border px-3 [-webkit-app-region:drag]"
        style={isMac ? { paddingLeft: 78 } : undefined}
      >
        {/* placeholder — back / forward navigation (#future) */}
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <IconButton size="icon-sm" aria-label="Back" title="Back">
            <ArrowLeft className="size-4" aria-hidden />
          </IconButton>
          <IconButton size="icon-sm" aria-label="Forward" title="Forward">
            <ArrowRight className="size-4" aria-hidden />
          </IconButton>
        </div>
        {/* Sidebar collapse toggle (#127): controls the left sidebar, so it sits in the
            header's LEFT region. Always visible (the header never hides), usable in both
            states; opts out of the drag region like every other header control. */}
        <div className="ml-2 flex items-center [-webkit-app-region:no-drag]">
          <IconButton
            size="icon-sm"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleSidebar}
          >
            <PanelLeft className="size-4" aria-hidden />
          </IconButton>
        </div>
        <div className="flex-1" />
        {/* Right-region layout controls: the side-panel toggle is LIVE (#193, the design's
            header affordance — toggles the ACTIVE Workspace's panel visibility via the
            store); Terminal/Expand stay placeholders (#future). */}
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <IconButton
            size="icon-sm"
            aria-label={activePanel.isOpen ? 'Close side panel' : 'Open side panel'}
            title={activePanel.isOpen ? 'Close side panel' : 'Open side panel'}
            onClick={() => {
              if (selectedWs) toggleWorkspacePanelVisibility(selectedWs)
            }}
          >
            <PanelRight className="size-4" aria-hidden />
          </IconButton>
          <IconButton size="icon-sm" aria-label="Toggle terminal" title="Toggle terminal">
            <Terminal className="size-4" aria-hidden />
          </IconButton>
          <IconButton size="icon-sm" aria-label="Expand" title="Expand">
            <Maximize2 className="size-4" aria-hidden />
          </IconButton>
        </div>
      </header>

      <Shell
        collapsed={sidebarCollapsed}
        workspaces={recents}
        nav={nav}
        workspaceFlags={wsFlags}
        rows={rows}
        protectedThreadId={protectedThreadId}
        outlet={outlet}
        opening={opening}
        onOpenProject={() => void openProject()}
        onNewThread={startNewChat}
        actions={{
          selectThread: selectThreadInWorkspace,
          newThreadInWorkspace,
          deleteThread: actions.deleteThread,
          removeWorkspace: actions.removeWorkspace,
          setThreadFlags: actions.setThreadFlags,
          renameThread: actions.renameThread,
        }}
        onOpenSettings={() => navDispatch({ type: 'open-settings' })}
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
 * the renderer can't key when the Workspace record couldn't be resolved.
 */
function agentIdOfResult(result: StartThreadResult): string | null {
  if (result.ok) return result.thread.agentId
  if (result.kind === 'not-signed-in') return result.agentId
  return null
}

/** The persisted Threads under a connected Workspace (by minted id), for its list (TB5). */
function threadsForWorkspace(recents: ListMetadataResult, workspaceId: string): ThreadMeta[] {
  return recents.find((w) => w.id === workspaceId)?.threads ?? []
}
