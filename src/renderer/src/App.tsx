import { useEffect, useReducer, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  AuthMethod,
  ListMetadataResult,
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
import { ConnectedWorkspace } from './connection/ConnectedWorkspace'
import { Shell } from './shell/Shell'

/**
 * Thin glue (ADR-0006): App owns IPC/data wiring — detection, the persisted
 * Workspace/Thread metadata, and the connect flow — and renders the persistent
 * `<Shell>`. The shell owns navigation (its pure nav reducer) and the two-pane
 * layout; App feeds it the cold list, the sidebar's top controls, and the
 * connection-active outlet, plus the connect-flow callbacks.
 *
 * Connection/auth states (connecting / not-signed-in / error / connected) still
 * route as before, but now INTO the outlet (`connectionOutlet`) rather than
 * swapping the whole view — the sidebar stays put. TB4 (#49) moves these inline.
 */
export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [connect, setConnect] = useState<ConnectState>({ status: 'idle' })
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
   * deleted-and-selected Thread collapses to the placeholder on its own.
   */
  async function deleteThread(thread: ThreadMeta): Promise<void> {
    await window.api.deleteThread(thread.id)
    await refreshRecents()
  }

  useEffect(() => {
    void runDetect()
    void refreshRecents()
  }, [])

  async function openProject(): Promise<void> {
    const workspaceDir = await window.api.openWorkspaceDialog()
    if (!workspaceDir) return
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.startThread({ workspaceDir })))
    // Main has now persisted the Workspace (and any Thread); reflect it in the list.
    void refreshRecents()
  }

  // After sign-in (or in-place re-auth) the agent is already started + signed in;
  // open a Thread on it and land in a connected conversation.
  async function continueToThread(agentId: string, workspaceDir: string): Promise<void> {
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.openThread({ agentId })))
  }

  /**
   * Continue a reopened Thread from the sidebar's cold list (TB4 #33). No agent
   * runs for a cold-list Thread, so we spawn its Workspace agent via `startThread`,
   * passing `continueThreadId` so main opens NO extra Thread and instead seeds the
   * connection with THIS Thread (its first prompt drives the `session/load`
   * resume). The connection thread IS the continued one, so it lands selected +
   * live with no separate plumbing. The Workspace dir comes from the cold list (a
   * `ThreadMeta` carries only `workspaceId`).
   */
  async function continueColdThread(thread: ThreadMeta): Promise<void> {
    const workspace = recents.find((w) => w.id === thread.workspaceId)
    if (!workspace) return
    setConnect({ status: 'connecting', workspaceDir: workspace.dir })
    setConnect(
      routeThreadResult(
        await window.api.startThread({ workspaceDir: workspace.dir, continueThreadId: thread.id }),
      ),
    )
    void refreshRecents()
  }

  /** Sign-out / mid-session expiry: drop back to the sign-in panel (same agent). */
  function toSignInPanel(agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    setConnect({ status: 'not-signed-in', agentId, workspaceDir, authMethods })
  }

  const connecting = connect.status === 'connecting'

  // The sidebar's pinned top: the environment check + the Open-project control.
  const sidebarTop = (
    <div className="shell__top">
      <Environment detect={detect} loading={loading} onRecheck={() => void runDetect()} />
      <button className="btn shell__open" onClick={() => void openProject()} disabled={connecting}>
        {connecting ? 'Connecting…' : 'Open project'}
      </button>
    </div>
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
        connectionOutlet={renderConnectionOutlet(connect, {
          continueToThread,
          toSignInPanel,
          refreshRecents,
          threads: connect.status === 'connected' ? threadsForWorkspace(recents, connect.thread.workspaceId) : [],
        })}
        onContinueColdThread={(thread) => void continueColdThread(thread)}
        onDeleteThread={deleteThread}
      />
    </div>
  )
}

/**
 * The connection-active outlet (everything but `idle`). Routed exactly as before,
 * now rendered INTO the shell outlet rather than swapping the whole view — the
 * sidebar persists across it. `null` on `idle` hands the outlet back to the shell's
 * nav-selected cold Thread (or placeholder). TB4 (#49) folds these inline.
 */
function renderConnectionOutlet(
  connect: ConnectState,
  handlers: {
    continueToThread: (agentId: string, workspaceDir: string) => void
    toSignInPanel: (agentId: string, workspaceDir: string, authMethods: AuthMethod[]) => void
    refreshRecents: () => Promise<void>
    threads: ThreadMeta[]
  },
): ReactNode | null {
  switch (connect.status) {
    case 'idle':
      return null
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
          onSignedIn={() => handlers.continueToThread(connect.agentId, connect.workspaceDir)}
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
    case 'connected':
      return (
        <>
          {/* Key by agentId (like Conversation) so its useReducer seed resets
              across connections — a new agent can't inherit the prior session's
              sign-out gate. */}
          <SignedInBar
            key={connect.thread.agentId}
            agentId={connect.thread.agentId}
            authMethods={connect.thread.authMethods}
            signOutAvailable={connect.thread.signOutAvailable}
            onSignedOut={(authMethods) =>
              handlers.toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
            }
          />
          {/* Key by agentId so the per-Workspace Thread state can't bleed across
              connections. Hosts multiple Threads on the one agent + switching (TB5). */}
          <ConnectedWorkspace
            key={connect.thread.agentId}
            connection={connect.thread}
            threads={handlers.threads}
            refreshRecents={handlers.refreshRecents}
            onAuthExpired={(authMethods) =>
              handlers.toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
            }
          />
        </>
      )
  }
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
