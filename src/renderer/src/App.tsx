import { useEffect, useState, type JSX } from 'react'
import type { AuthMethod, ThreadConnection, VibeDetectResult } from '../../shared/ipc'
import { selectAuthView } from './auth/auth-view'
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
            <SignInPanel authMethods={connect.authMethods} />
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
 * the generic-error alert. Renders the agent's advertised sign-in method name
 * and a Sign-in button. The button is intentionally inert here — its click
 * handler is wired in #12 (browser-auth-delegated).
 */
function SignInPanel({ authMethods }: { authMethods: AuthMethod[] }): JSX.Element | null {
  const view = selectAuthView({ authState: 'not-signed-in', authMethods })
  if (view.kind !== 'sign-in') return null
  return (
    <div className="signin">
      <div className="signin__title">Not signed in to Mistral Vibe</div>
      {view.description && <div className="signin__message">{view.description}</div>}
      <button className="btn signin__action" onClick={() => {}}>
        {view.methodName}
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
