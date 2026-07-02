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
  draftControls,
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
import {
  getWorkspaceControls,
  setWorkspaceControls,
  workspaceControlsKey,
} from './connection/workspace-controls-store'
import { ArrowLeft, ArrowRight, Maximize2, PanelLeft, PanelRight, Terminal } from 'lucide-react'
import { Button } from './ui/button'
import { IconButton } from './ui/icon-button'
import { Card } from './ui/card'
import { Shell, type WorkspaceFlags } from './shell/Shell'
import { Logo } from './shell/logo'
import { LogoSnakeSpinner } from './shell/logo-snake-spinner'
import { heroHeadline } from './shell/hero-headline'
import { firstRunState, type FirstRunState } from './shell/first-run'
import { findSelectedThread, initialNavState, navReducer, type NavState } from './shell/nav-reducer'
import {
  getSidebarCollapsed,
  setSidebarCollapsed as setSidebarCollapsedStore,
} from './shell/sidebar-collapsed-store'
import {
  getSidePanelOpen,
  setSidePanelOpen as setSidePanelOpenStore,
} from './side-panel/side-panel-open-store'
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
  // Whether the right SIDE PANEL is open (#187 follow-up): the header's PanelRight icon
  // toggles it (the sidebar toggle's mirror), CLOSED by default. App-global chrome —
  // WHICH Surface shows inside stays per-Workspace (surface-state-store). A Surface
  // shortcut (⌘P/⌃⇧G) can also open/close it via `setSidePanelOpenState`.
  const [sidePanelOpen, setSidePanelOpen] = useState(() => getSidePanelOpen(window.localStorage))
  function setSidePanelOpenState(open: boolean): void {
    setSidePanelOpen(open)
    setSidePanelOpenStore(window.localStorage, open)
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
   * Remove a Workspace from the sidebar ("Remove project", Codex-style). Main stops
   * its warm agent (if any — allowed even mid-turn) and removes OUR records (the
   * Workspace + Thread metadata + JSONL); it NEVER deletes files on disk. Here we
   * reconcile local state so the project disappears cleanly:
   *  - If it was the selected Workspace, clear the nav selection (lands on the empty
   *    state); leave the selection untouched when removing a non-selected project.
   *  - Drop its connection and per-Workspace live-state. Both are idempotent: for a
   *    CONNECTED project main disposed the agent and pushed `agent:evicted`, whose
   *    handler already dropped the connection by agentId — so `clear` is a no-op then
   *    (no double-removal), and it covers the cold/unconnected case that evict misses.
   *  - Drop each removed Thread's persisted composer draft + renderer status, mirroring
   *    `deleteThread` — so a removed project leaves no orphaned localStorage/status keys.
   *  - `refreshRecents()` LAST, dropping it from the persisted list the sidebar renders.
   */
  async function removeWorkspace(workspaceId: string): Promise<void> {
    await window.api.removeWorkspace(workspaceId)
    // Snapshot the removed Workspace's Thread ids from the CURRENT list, before the
    // refresh drops it, so we can clear their renderer-local residue below.
    const removedThreadIds = recents.find((w) => w.id === workspaceId)?.threads.map((t) => t.id) ?? []
    if (nav.selectedWorkspaceId === workspaceId) navDispatch({ type: 'clear' })
    connDispatch({ type: 'clear', workspaceId })
    wtDispatch({ type: 'remove-workspace', workspaceId })
    if (removedThreadIds.length > 0) {
      setStatuses((prev) => removedThreadIds.reduce((acc, id) => clearThreadStatus(acc, id), prev))
      for (const id of removedThreadIds) clearDraft(window.localStorage, id)
    }
    await refreshRecents()
  }

  /**
   * Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive). A SAFE
   * metadata op — no session teardown — so it runs on any row (active or cold-peek).
   * Best-effort in main (ADR-0005); we refresh the recents list so the new flag
   * reflects in the sidebar's derivation (`orderByPin` / `partitionArchived`). A
   * `{ok:false}` (store failure) leaves the list as-is — the toggle is a no-op.
   */
  async function setThreadFlags(
    threadId: string,
    flags: { pinned?: boolean; archived?: boolean },
  ): Promise<void> {
    const result = await window.api.setThreadFlags({ threadId, ...flags })
    if (!result.ok) return
    await refreshRecents()
  }

  /**
   * Rename a Thread. Main owns the title in OUR store, and additionally syncs the
   * vibe-acp side when the Thread is live — so we pass the hosting `agentId` (when its
   * Workspace is connected) and the Thread's bound `sessionId`; main no-ops the ACP
   * call for a cold Thread. Refresh the cold list on success so the sidebar re-labels
   * (the setter holds list position, so the Thread doesn't jump). A `{ok:false}`
   * (empty title / store failure) leaves the label unchanged.
   */
  async function renameThread(thread: ThreadMeta, title: string): Promise<void> {
    const conn = connections[thread.workspaceId]
    const agentId = conn ? agentIdOf(conn) : null
    const result = await window.api.setThreadTitle({
      threadId: thread.id,
      title,
      agentId: agentId ?? undefined,
      sessionId: thread.sessionId,
    })
    if (!result.ok) return
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
   * Pre-select an agent control on a New-thread DRAFT (#75), before its first prompt
   * binds a session. A draft has no live session, so there's NO IPC — we only cache
   * the pick into the in-memory `selected` map (keyed by `threadId`). The display
   * updates because the draft's picker reads `draftControls(connection, selected)`, and
   * because this writes the SAME cache `changeThreadConfig` writes on a bound Thread,
   * the EXISTING `reassertAfterResume` (#72) applies the pre-pick to the session the
   * instant the first prompt mints it — no second apply path, and no residue (the cache
   * evaporates with the draft / on restart, ADR-0007).
   */
  function preselectDraftConfig(
    workspaceId: string,
    threadId: string,
    axis: ThreadConfigAxis,
    value: string,
  ): void {
    wtDispatch({ type: 'cache-selection', workspaceId, threadId, axis, value })
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

  const connectedIds = connectedWorkspaceIds(connections)
  const selectedWs = nav.selectedWorkspaceId
  const selected = selectedConnection(connections, selectedWs)
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
          sidePanelOpen={sidePanelOpen}
          onSidePanelOpenChange={setSidePanelOpenState}
          seedSessionId={seed}
          controls={
            // A bound Thread sources its OWN live config (#70); a draft (no config
            // seeded) shows the connection's option lists + defaults, overlaid with any
            // cached pre-pick (#75). CAVEAT: a CONTINUED (reopened, not-yet-bound) Thread
            // also has no config, so it shows the connection DEFAULTS too — honest for
            // Mode (session/load resets it to default) but the MODEL can persist across
            // a resume (acp-capture §10), so a reopened Thread may briefly show the
            // default model until its first prompt's bind reports the real one and
            // self-corrects. We don't eagerly resume to learn it (#33 defers load to the
            // first prompt); Model isn't trust-relevant (it doesn't gate writes), so the
            // transient pre-prompt mismatch is accepted.
            // A never-bound draft's connection advertises all-null controls (ADR-0011
            // opens no session until the first prompt), so before falling back to the
            // connection we try the per-Workspace cache (#153) — the last bound session's
            // option lists — so the picker shows immediately instead of after send.
            configFor(workspaceThreads, conn.workspaceId, activeThread.id) ??
            draftControls(
              getWorkspaceControls(
                window.localStorage,
                workspaceControlsKey(conn.workspaceId, conn.workspaceDir),
              ) ?? connectionControlsOf(conn),
              selectedFor(workspaceThreads, conn.workspaceId, activeThread.id),
            )
          }
          onSetConfig={(axis, value, sessionId) => {
            // A real session => the bound IPC path (#70); a null session => a draft
            // pre-pick that only caches (#75), applied to the session on first bind.
            if (sessionId) changeThreadConfig(conn.workspaceId, conn.agentId, activeThread.id, axis, value, sessionId)
            else preselectDraftConfig(conn.workspaceId, activeThread.id, axis, value)
          }}
          onBound={(sessionId, controls) => {
            // Seed the displayed config from the bound session's reported values, then
            // re-assert the user's cached selection over them (#72) — a resume reports
            // defaults, so this restores a prior non-default Mode/Model/effort.
            wtDispatch({ type: 'bind', workspaceId: conn.workspaceId, threadId: activeThread.id, sessionId, controls })
            if (controls) {
              reassertAfterResume(conn.workspaceId, conn.agentId, activeThread.id, sessionId, controls)
              // Cache the bound session's option lists per Workspace (#153) so the NEXT
              // never-bound draft here shows the picker before its own first prompt binds.
              setWorkspaceControls(
                window.localStorage,
                workspaceControlsKey(conn.workspaceId, conn.workspaceDir),
                controls,
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
  // sidebar gear used to toggle (reusing the same `Environment` component + `detect`).
  // It swaps the conversation/cold/empty outlet WITHOUT unmounting the connected
  // Workspaces — they stay mounted-but-hidden so a background turn keeps streaming, and
  // closing Settings (or picking a project/thread) returns to exactly the same view.
  const inSettings = nav.view === 'settings'
  const outlet = (
    <>
      {connectedIds.map((wid) => {
        const conn = connections[wid]
        if (conn.status !== 'connected') return null
        return (
          <div key={wid} hidden={inSettings || wid !== selectedWs}>
            {renderConnected(conn.thread, !inSettings && wid === selectedWs, wsFlags[wid]?.streaming ?? false)}
          </div>
        )
      })}
      {inSettings ? (
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
      ) : selected.status === 'connected' ? null : ( // connected: rendered (visible) in the keep-mounted map above
        selected.status !== 'idle'
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
                workspaceName={selectedWorkspaceName}
                onRecheck={() => void runDetect()}
                onOpenProject={() => void openProject()}
              />,
            )
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
        {/* Right-region layout controls: the side-panel toggle is LIVE (#187 follow-up,
            the design's header affordance); Terminal/Expand stay placeholders (#future). */}
        <div className="flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          <IconButton
            size="icon-sm"
            aria-label={sidePanelOpen ? 'Close side panel' : 'Open side panel'}
            title={sidePanelOpen ? 'Close side panel' : 'Open side panel'}
            onClick={() => setSidePanelOpenState(!sidePanelOpen)}
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
        onSelectThread={selectThreadInWorkspace}
        onNewThread={startNewChat}
        onNewThreadInWorkspace={newThreadInWorkspace}
        onDeleteThread={deleteThread}
        onRemoveWorkspace={removeWorkspace}
        onSetThreadFlags={setThreadFlags}
        onRenameThread={renameThread}
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
 * Project a connection's advertised agent-controls (#75): the connect-time option
 * lists + DEFAULT current values, never optimistically mutated (a pick lands in
 * `workspace-threads.config`, not here — #70). Used to seed a draft's picker so it
 * shows the agent defaults a default-mint would produce.
 */
function connectionControlsOf(conn: ThreadConnection): ThreadAgentControls {
  return { modes: conn.modes, models: conn.models, reasoningEffort: conn.reasoningEffort }
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
        <div className="mx-auto mt-14 flex max-w-[420px] flex-col items-center gap-2 text-center">
          <span className="dot dot--pending" aria-hidden />
          <div className="text-sm font-semibold text-text-strong">Connecting…</div>
          <div className="text-[13px] leading-relaxed text-muted">
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
  nav: NavState,
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
  workspaceName,
  onRecheck,
  onOpenProject,
}: {
  state: FirstRunState
  detect: VibeDetectResult | null
  loading: boolean
  opening: boolean
  /** The selected Workspace's name, emphasized in the idle hero headline (or null). */
  workspaceName: string | null
  onRecheck: () => void
  onOpenProject: () => void
}): JSX.Element {
  if (state === 'needs-install') {
    return (
      <div className="flex max-w-[460px] flex-col items-start gap-3">
        <div className="text-[15px] font-semibold text-text-strong">
          Install Mistral Vibe to get started
        </div>
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
      <div className="flex max-w-[460px] flex-col items-start gap-3">
        <div className="text-[15px] font-semibold text-text-strong">No workspaces yet</div>
        <p className="hint">Open a project to spawn its agent and start a thread.</p>
        <Button onClick={onOpenProject} disabled={opening}>
          {opening ? 'Connecting…' : 'Open project'}
        </Button>
      </div>
    )
  }
  // idle — the empty-state hero: a centered logo + a dynamic headline with the
  // selected Workspace name in orange (`--accent-emphasis`).
  const headline = heroHeadline(workspaceName)
  return (
    <div className="mx-auto flex h-full max-w-[830px] flex-col items-center justify-center gap-6 text-center">
      <Logo size={52} />
      <h1 className="text-[37px] font-semibold tracking-[-0.6px] text-text-strong">
        {headline.lead}
        {headline.name && <span className="text-accent-emphasis">{headline.name}</span>}
        {headline.tail}
      </h1>
      <p className="hint">
        Select a thread from the sidebar to view it, or open a project to start a live agent.
      </p>
    </div>
  )
}

/**
 * The Settings page (#130): an on-demand, nav-routed outlet view that replaces the
 * old sidebar gear. A titled panel with a back/close affordance (`onClose` dispatches
 * `close-settings`, so you can leave even with nothing selected) hosting the existing
 * `Environment` env/CLI status. Future settings land here. This is an ADDITIONAL place
 * to check the toolchain — NOT a replacement for the first-run `EmptyState`, which still
 * surfaces a missing toolchain prominently in the outlet when nothing's installed.
 */
function SettingsView({
  detect,
  loading,
  onRecheck,
  onClose,
  account,
  onSignedOut,
}: {
  detect: VibeDetectResult | null
  loading: boolean
  onRecheck: () => void
  onClose: () => void
  /** The selected Workspace's signed-in account, or null when none is connected. */
  account: AccountInfo | null
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back" title="Back" onClick={onClose}>
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h1 className="text-[19px] font-semibold tracking-tight text-text-strong">Settings</h1>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-faint">Account</h2>
        <AccountSettings
          // Key by agentId so the auth reducer's seed resets per connection — a new
          // agent can't inherit the prior session's sign-out gate/in-flight state.
          key={account ? `account-${account.agentId}` : 'account-none'}
          account={account}
          onSignedOut={onSignedOut}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-faint">Environment</h2>
        <Environment detect={detect} loading={loading} onRecheck={onRecheck} />
      </section>
    </div>
  )
}

/** The selected Workspace's connected agent + its advertised auth, for the Account section. */
interface AccountInfo {
  agentId: string
  authMethods: AuthMethod[]
  signOutAvailable: boolean
}

/**
 * The Settings > Account section (moved off the old chat banner). Shows the signed-in
 * status for the selected Workspace's warm agent + a design-system Sign-out control
 * gated on `signOutAvailable`, mirroring the old `SignedInBar`'s pure `authReducer` /
 * `signOut` lifecycle but styled with tokens + `Button` (no legacy banner BEM). Sign-out
 * still calls `window.api.signOut({ agentId })` and, on success, routes that Workspace
 * to its sign-in panel via `onSignedOut` (which also closes Settings). When no Workspace
 * is connected (`account` null) it shows a muted hint and offers no Sign-out.
 */
function AccountSettings({
  account,
  onSignedOut,
}: {
  account: AccountInfo | null
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  const [state, dispatch] = useReducer(
    authReducer,
    signedInAuthViewState(account?.authMethods ?? [], account?.signOutAvailable ?? false),
  )
  const view = selectAuthView(state)

  async function signOut(): Promise<void> {
    if (!account) return
    dispatch({ type: 'sign-out-start' })
    const result = await window.api.signOut({ agentId: account.agentId })
    if (result.ok) {
      dispatch({ type: 'sign-out-success' })
      onSignedOut(result.authMethods)
    } else {
      dispatch({ type: 'sign-out-error', message: result.error })
    }
  }

  if (!account) {
    return (
      <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
        Not connected — open a project to manage your session.
      </div>
    )
  }

  const signingOut = view.kind === 'signing-out'
  return (
    <div className="flex flex-col gap-2.5 rounded-[9px] border border-border p-3">
      <div className="flex items-center gap-2 text-[13px]">
        {!signingOut && <span className="size-[7px] shrink-0 rounded-full bg-ok" aria-hidden />}
        <span className="font-semibold text-text-strong">
          {signingOut ? 'Signing out…' : 'Signed in to Mistral Vibe'}
        </span>
        {view.kind === 'signed-in' && view.identity && (
          <span className="text-muted">{view.identity}</span>
        )}
        <span className="flex-1" />
        {view.kind === 'signed-in' && view.signOutAvailable && (
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </div>
      {view.kind === 'signed-in' && view.error && (
        <div className="text-[13px] text-bad">{view.error}</div>
      )}
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
    <div className="flex flex-col gap-2.5 rounded-[9px] border border-border p-3">
      <div className="flex items-center justify-between text-[13px] font-semibold text-text-strong">
        <span>Environment</span>
        <Button variant="ghost" size="xs" onClick={onRecheck} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </Button>
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

  // #79: OBSERVE current auth state without re-running the browser flow — recovers
  // an out-of-band `vibe` CLI sign-in, the blocking fallback, or a delegated
  // `complete` whose result we lost. Bumps the attempt generation so any stale
  // in-flight sign-in result is dropped (same guard as `signIn`/`cancel`).
  async function checkStatus(): Promise<void> {
    const attempt = ++attemptRef.current
    dispatch({ type: 'check-start' })
    const result = await window.api.checkAuthStatus({ agentId })
    if (attempt !== attemptRef.current) return // superseded — drop the stale result
    if (result.ok && result.authState === 'signed-in') {
      dispatch({ type: 'sign-in-success' })
      onSignedIn() // continue to a connected Thread on the same agent
    } else if (result.ok) {
      dispatch({
        type: 'sign-in-error',
        message: 'Still not signed in. Finish signing in (in your browser or via `vibe`), then check again.',
      })
    } else {
      dispatch({ type: 'sign-in-error', message: result.error })
    }
  }

  if (view.kind === 'signed-in') {
    return (
      <SignInCard>
        <SignInLoading label="Signed in — opening your workspace…" />
      </SignInCard>
    )
  }

  if (view.kind === 'signing-out') {
    return (
      <SignInCard>
        <SignInLoading label="Signing out…" />
      </SignInCard>
    )
  }

  if (view.kind === 'signing-in') {
    return (
      <SignInCard>
        <SignInLoading label="Signing in…" />
        <p className="text-[13px] leading-relaxed text-muted">
          Complete sign-in in your browser, then return here.
        </p>
        <Button variant="outline" size="sm" className="self-start" onClick={cancel}>
          Cancel
        </Button>
      </SignInCard>
    )
  }

  if (view.kind === 'checking') {
    return (
      <SignInCard>
        <SignInLoading label="Checking sign-in status…" />
      </SignInCard>
    )
  }

  // sign-in or error: both render the (clickable) Sign-in button so the error
  // state stays recoverable, plus a re-check that OBSERVES auth state without
  // re-running the browser flow (#79) — for an out-of-band `vibe` CLI sign-in.
  return (
    <SignInCard>
      <div className="text-sm font-semibold text-text-strong">Not signed in to Mistral Vibe</div>
      {view.kind === 'sign-in' && view.description && (
        <p className="text-[13px] leading-relaxed text-muted">{view.description}</p>
      )}
      {view.kind === 'error' && <p className="text-[13px] leading-relaxed text-bad">{view.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" onClick={() => void signIn(view.methodId)}>
          {view.kind === 'error' ? `Retry — ${view.methodName}` : view.methodName}
        </Button>
        <Button variant="ghost" onClick={() => void checkStatus()}>
          Already signed in? Check status
        </Button>
      </div>
    </SignInCard>
  )
}

/** Centered card chrome shared by every {@link SignInPanel} state (sibling of the
 * connecting/error connect-states). Token surface + rounded card, no legacy BEM. */
function SignInCard({ children }: { children: ReactNode }): JSX.Element {
  return <Card className="mx-auto mt-14 w-full max-w-[420px] gap-3">{children}</Card>
}

/** A branded-spinner + label row for the panel's in-flight states (signing-in /
 * checking / signing-out / opening). Copy is unchanged; only the look. */
function SignInLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 text-sm font-semibold text-text-strong">
      {/* Spinner is decorative here — the visible label carries the accessible name,
          so hide the spinner's own role=img to avoid a double screen-reader announce. */}
      <span aria-hidden className="inline-flex">
        <LogoSnakeSpinner size={16} />
      </span>
      <span>{label}</span>
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
