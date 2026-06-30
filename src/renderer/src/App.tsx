import { useEffect, useReducer, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  AuthMethod,
  ListMetadataResult,
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
  connectedWorkspaceIds,
  connectionsReducer,
  initialConnections,
  selectedConnection,
  shouldConnect,
} from './connection/connections'
import { ConnectedWorkspace } from './connection/ConnectedWorkspace'
import { ColdThread } from './conversation/ColdThread'
import { Shell } from './shell/Shell'
import { findSelectedThread, initialNavState, navReducer } from './shell/nav-reducer'

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
  // Navigation (decision 2): WHICH Workspace/Thread the user is looking at —
  // lifted here so the connect flow (Open project, Continue, sign-in) can drive it.
  const [nav, navDispatch] = useReducer(navReducer, initialNavState)
  // Per-Workspace connection registry (decision 3): one ConnectState per warm
  // Workspace, so switching between two is instant and both keep streaming.
  const [connections, connDispatch] = useReducer(connectionsReducer, initialConnections)
  // Persisted Workspaces + Threads (ADR-0005), listed cold on launch from
  // metadata alone — no agent spawned, no transcript loaded.
  const [recents, setRecents] = useState<ListMetadataResult>([])

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
   * Delete a persisted Thread (TB6): main removes its metadata + JSONL and
   * best-effort closes any live session; we then re-fetch so it disappears from
   * the list. The shell derives its selected (cold) Thread from `recents`, so a
   * deleted-and-selected Thread collapses to the placeholder on its own. Gated in
   * the sidebar to NON-connected Workspaces, so we never delete a Thread a warm
   * agent is hosting out from under it.
   */
  async function deleteThread(thread: ThreadMeta): Promise<void> {
    await window.api.deleteThread(thread.id)
    await refreshRecents()
  }

  useEffect(() => {
    void runDetect()
    void refreshRecents()
  }, [])

  /**
   * Select a Workspace from the sidebar: pin it in the nav reducer and
   * connect-OR-REUSE its warm agent. A never-connected (or errored) Workspace
   * lazily spawns its agent; a warm one (connecting / not-signed-in / connected) is
   * reused as-is — instant, no second spawn or handshake.
   */
  function selectWorkspace(workspaceId: string): void {
    navDispatch({ type: 'select-workspace', workspaceId })
    if (shouldConnect(connections[workspaceId])) void connectWorkspace(workspaceId)
  }

  /** Spawn-or-reuse a Workspace's agent and record its connection (keyed by id). */
  async function connectWorkspace(workspaceId: string): Promise<void> {
    const workspace = recents.find((w) => w.id === workspaceId)
    if (!workspace) return
    connDispatch({ type: 'set', workspaceId, state: { status: 'connecting', workspaceDir: workspace.dir } })
    const result = await window.api.startThread({ workspaceDir: workspace.dir })
    connDispatch({ type: 'set', workspaceId, state: routeThreadResult(result) })
    void refreshRecents()
  }

  async function openProject(): Promise<void> {
    const workspaceDir = await window.api.openWorkspaceDialog()
    if (!workspaceDir) return
    setOpening(true)
    try {
      const result = await window.api.startThread({ workspaceDir })
      // Main has now persisted the Workspace (even on not-signed-in / error, since
      // it records the open BEFORE the handshake), so re-fetch to learn its minted
      // id, then key the connection by it and select it.
      const list = await window.api.listMetadata()
      setRecents(list)
      const ws = list.find((w) => w.dir === workspaceDir)
      if (!ws) return // degraded (no store) — nothing to key/select
      connDispatch({ type: 'set', workspaceId: ws.id, state: routeThreadResult(result) })
      navDispatch({ type: 'select-workspace', workspaceId: ws.id })
    } finally {
      setOpening(false)
    }
  }

  // After sign-in (or in-place re-auth) the Workspace's warm agent is already
  // started + signed in; open a Thread on it and land in a connected conversation.
  async function continueToThread(workspaceId: string, agentId: string): Promise<void> {
    connDispatch({ type: 'set', workspaceId, state: routeThreadResult(await window.api.openThread({ agentId })) })
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
    connDispatch({ type: 'set', workspaceId: workspace.id, state: routeThreadResult(result) })
    void refreshRecents()
  }

  /** Sign-out / mid-session expiry: drop a Workspace back to its sign-in panel
   *  (same warm agent — never respawned). */
  function toSignInPanel(workspaceId: string, agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    connDispatch({ type: 'set', workspaceId, state: { status: 'not-signed-in', agentId, workspaceDir, authMethods } })
  }

  // The sidebar's pinned top: the environment check + the Open-project control.
  const sidebarTop = (
    <div className="shell__top">
      <Environment detect={detect} loading={loading} onRecheck={() => void runDetect()} />
      <button className="btn shell__open" onClick={() => void openProject()} disabled={opening}>
        {opening ? 'Connecting…' : 'Open project'}
      </button>
    </div>
  )

  const connectedIds = connectedWorkspaceIds(connections)
  const selected = selectedConnection(connections, nav.selectedWorkspaceId)

  /** The connected view for a Workspace (SignedInBar + ConnectedWorkspace). */
  function renderConnected(thread: ThreadConnection): ReactNode {
    return (
      <>
        {/* Key by agentId (like Conversation) so its useReducer seed resets across
            connections — a new agent can't inherit the prior session's sign-out gate. */}
        <SignedInBar
          key={`bar-${thread.agentId}`}
          agentId={thread.agentId}
          authMethods={thread.authMethods}
          signOutAvailable={thread.signOutAvailable}
          onSignedOut={(authMethods) =>
            toSignInPanel(thread.workspaceId, thread.agentId, thread.workspaceDir, authMethods)
          }
        />
        {/* Key by agentId so per-Workspace Thread state can't bleed across
            connections. Hosts multiple Threads on the one agent + switching (TB5). */}
        <ConnectedWorkspace
          key={thread.agentId}
          connection={thread}
          threads={threadsForWorkspace(recents, thread.workspaceId)}
          refreshRecents={refreshRecents}
          onAuthExpired={(authMethods) =>
            toSignInPanel(thread.workspaceId, thread.agentId, thread.workspaceDir, authMethods)
          }
        />
      </>
    )
  }

  // The outlet: every connected Workspace stays MOUNTED (hidden unless selected) so
  // its background turn keeps streaming and a switch-back is instant; the selected
  // Workspace's transient state (connecting / sign-in / error) or its cold Thread
  // renders inline. Routed off the nav selection, so cold clicks always route right.
  const outlet = (
    <>
      {connectedIds.map((wid) => {
        const conn = connections[wid]
        if (conn.status !== 'connected') return null
        return (
          <div key={wid} className="shell__connection" hidden={wid !== nav.selectedWorkspaceId}>
            {renderConnected(conn.thread)}
          </div>
        )
      })}
      {selected.status === 'connected'
        ? null // rendered (visible) in the keep-mounted map above
        : selected.status !== 'idle'
          ? renderTransientOutlet(selected, {
              continueToThread: (agentId) => void continueToThread(nav.selectedWorkspaceId ?? '', agentId),
            })
          : renderColdOutlet(recents, nav, {
              onClose: () => navDispatch({ type: 'clear' }),
              onContinue: (thread) => void continueColdThread(thread),
            })}
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
        connectedWorkspaceIds={connectedIds}
        outlet={outlet}
        onSelectWorkspace={selectWorkspace}
        onSelectThread={(workspaceId, threadId) => navDispatch({ type: 'select-thread', workspaceId, threadId })}
        onDeleteThread={deleteThread}
      />
    </div>
  )
}

/**
 * The selected Workspace's NON-connected outlet state (connecting / not-signed-in /
 * error). Only the selected Workspace shows a transient view; connected Workspaces
 * render via the keep-mounted map instead.
 */
function renderTransientOutlet(
  connect: ConnectState,
  handlers: { continueToThread: (agentId: string) => void },
): ReactNode {
  switch (connect.status) {
    case 'connecting':
      return (
        <p className="hint">
          Launching <code>vibe-acp</code> in <code>{connect.workspaceDir}</code> and running the ACP
          handshake…
        </p>
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
): ReactNode {
  const selectedThread = findSelectedThread(recents, nav)
  if (!selectedThread) {
    return (
      <div className="shell__empty">
        <p className="hint">
          Select a thread from the sidebar to view it, or open a project to start a live agent.
        </p>
      </div>
    )
  }
  return (
    <ColdThread
      key={selectedThread.id}
      thread={selectedThread}
      onClose={handlers.onClose}
      onContinue={() => handlers.onContinue(selectedThread)}
    />
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
