import { useEffect, useReducer, useRef, useState, type JSX } from 'react'
import type { AuthMethod, VibeDetectResult } from '../../shared/ipc'
import {
  authReducer,
  initialAuthViewState,
  selectAuthView,
  signedInAuthViewState,
} from './auth/auth-view'
import { routeThreadResult, type ConnectState } from './connection/routing'
import { Conversation } from './conversation/Conversation'

export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [connect, setConnect] = useState<ConnectState>({ status: 'idle' })

  async function runDetect(): Promise<void> {
    setLoading(true)
    const result = await window.api.detectVibe()
    setDetect(result)
    setLoading(false)
  }

  useEffect(() => {
    void runDetect()
  }, [])

  async function openProject(): Promise<void> {
    const workspaceDir = await window.api.openWorkspaceDialog()
    if (!workspaceDir) return
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.startThread({ workspaceDir })))
  }

  // After sign-in (or in-place re-auth) the agent is already started + signed in;
  // open a Thread on it and land in a connected conversation.
  async function continueToThread(agentId: string, workspaceDir: string): Promise<void> {
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.openThread({ agentId })))
  }

  /** Sign-out / mid-session expiry: drop back to the sign-in panel (same agent). */
  function toSignInPanel(agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    setConnect({ status: 'not-signed-in', agentId, workspaceDir, authMethods })
  }

  const connecting = connect.status === 'connecting'

  return (
    <div className="app">
      <header className="app__header">
        <h1>Vibe Mistro</h1>
        <span className="app__subtitle">Orchestrator for Mistral Vibe agents · ACP backend</span>
      </header>

      <main className="app__main">
        <section className="card">
          <div className="card__title">
            <span>Environment</span>
            <button className="btn" onClick={() => void runDetect()} disabled={loading}>
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
        </section>

        <section className="card">
          <div className="card__title">
            <span>Workspace</span>
            <button className="btn" onClick={() => void openProject()} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Open project'}
            </button>
          </div>

          {connect.status === 'idle' && (
            <p className="hint">Open a project folder to start a Vibe agent and connect a Thread.</p>
          )}

          {connect.status === 'connecting' && (
            <p className="hint">
              Launching <code>vibe-acp</code> in <code>{connect.workspaceDir}</code> and running the
              ACP handshake…
            </p>
          )}

          {connect.status === 'not-signed-in' && (
            <SignInPanel
              key={connect.agentId}
              agentId={connect.agentId}
              authMethods={connect.authMethods}
              onSignedIn={() => void continueToThread(connect.agentId, connect.workspaceDir)}
            />
          )}

          {connect.status === 'error' && (
            <div className="alert">
              <div className="alert__title">Couldn’t connect</div>
              <div className="alert__message">{connect.message}</div>
              {connect.hint && <div className="alert__hint">{connect.hint}</div>}
            </div>
          )}

          {connect.status === 'connected' && (
            <>
              {/* Key by agentId (like Conversation) so its useReducer seed resets
                  across connections — a new agent can't inherit the prior
                  session's sign-out gate. */}
              <SignedInBar
                key={connect.thread.agentId}
                agentId={connect.thread.agentId}
                authMethods={connect.thread.authMethods}
                signOutAvailable={connect.thread.signOutAvailable}
                onSignedOut={(authMethods) =>
                  toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
                }
              />
              {/* Key by agentId so the Conversation's reducer can't bleed across Threads. */}
              <Conversation
                key={connect.thread.agentId}
                thread={connect.thread}
                onAuthExpired={(authMethods) =>
                  toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
                }
              />
            </>
          )}
        </section>
      </main>
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
  // Generation counter: bumped on every attempt start and on cancel. The
  // delegated `complete` long-poll can't be aborted over ACP, so a cancelled (or
  // superseded) attempt's eventual result must be ignored rather than clobber
  // the panel — we only apply a result whose generation is still current.
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

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
