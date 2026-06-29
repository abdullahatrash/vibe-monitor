import { useEffect, useReducer, useRef, useState, type JSX } from 'react'
import type { AuthMethod, ThreadConnection, VibeDetectResult } from '../../shared/ipc'
import { authReducer, initialAuthViewState, selectAuthView } from './auth/auth-view'
import { Conversation } from './conversation/Conversation'

type ConnectState =
  | { status: 'idle' }
  | { status: 'connecting'; workspaceDir: string }
  | { status: 'connected'; thread: ThreadConnection }
  | { status: 'not-signed-in'; agentId: string; workspaceDir: string; authMethods: AuthMethod[] }
  | { status: 'error'; message: string; hint: string | null }

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
    const result = await window.api.startThread({ workspaceDir })
    if (result.ok) {
      setConnect({ status: 'connected', thread: result.thread })
    } else if (result.kind === 'not-signed-in') {
      setConnect({
        status: 'not-signed-in',
        agentId: result.agentId,
        workspaceDir: result.workspaceDir,
        authMethods: result.authMethods,
      })
    } else {
      setConnect({ status: 'error', message: result.error, hint: result.hint })
    }
  }

  const connecting = connect.status === 'connecting'

  return (
    <div className="app">
      <header className="app__header">
        <h1>Vibe Monitor</h1>
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
            // Key by agentId so the Conversation's useReducer state can't bleed
            // across Threads — a new Thread gets a fresh reducer, not the old one.
            <Conversation key={connect.thread.agentId} thread={connect.thread} />
          )}
        </section>
      </main>
    </div>
  )
}

/**
 * The not-signed-in panel: visibly distinct from the binary-missing status and
 * the generic-error alert. Clicking Sign-in drives Vibe's delegated browser
 * sign-in via main (#12) — the system browser opens, and on success the panel
 * transitions to a signed-in confirmation. The auth lifecycle (signing-in /
 * signed-in / error) is the pure `authReducer`; this component is the glue.
 */
function SignInPanel({
  agentId,
  authMethods,
}: {
  agentId: string
  authMethods: AuthMethod[]
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

  if (view.kind === 'none') {
    // Reaching `none` in this panel means we just signed in. This terminal
    // confirmation is #12's end state; opening a Thread from here (routing
    // Open-project through sign-in) is #13.
    return (
      <div className="signin signin--done">
        <div className="signin__title">Signed in to Mistral Vibe</div>
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

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
