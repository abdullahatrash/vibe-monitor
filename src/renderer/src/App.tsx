import { useEffect, useState, type JSX } from 'react'
import type { ThreadConnection, VibeDetectResult } from '../../shared/ipc'

type ConnectState =
  | { status: 'idle' }
  | { status: 'connecting'; workspaceDir: string }
  | { status: 'connected'; thread: ThreadConnection }
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

          {connect.status === 'error' && (
            <div className="alert">
              <div className="alert__title">Couldn’t connect</div>
              <div className="alert__message">{connect.message}</div>
              {connect.hint && <div className="alert__hint">{connect.hint}</div>}
            </div>
          )}

          {connect.status === 'connected' && <ThreadPanel thread={connect.thread} />}
        </section>
      </main>
    </div>
  )
}

function ThreadPanel({ thread }: { thread: ThreadConnection }): JSX.Element {
  return (
    <div className="thread">
      <div className="thread__head">
        <span className="dot dot--ok" aria-hidden />
        <span className="thread__title">{thread.title ?? 'Untitled Thread'}</span>
        <span className="badge">connected</span>
      </div>

      <ul className="status">
        <li className="status__row">
          <span className="status__label">workspace</span>
          <span className="status__value mono">{thread.workspaceDir}</span>
        </li>
        <li className="status__row">
          <span className="status__label">sessionId</span>
          <span className="status__value mono">{thread.sessionId}</span>
        </li>
      </ul>

      {thread.modes && (
        <ChipRow
          label="modes"
          items={thread.modes.availableModes.map((m) => m.id)}
          current={thread.modes.currentModeId}
        />
      )}
      {thread.models && (
        <ChipRow
          label="models"
          items={thread.models.availableModels.map((m) => m.modelId)}
          current={thread.models.currentModelId}
        />
      )}
    </div>
  )
}

function ChipRow({
  label,
  items,
  current,
}: {
  label: string
  items: string[]
  current: string
}): JSX.Element {
  return (
    <div className="chips">
      <span className="chips__label">{label}</span>
      <div className="chips__list">
        {items.map((item) => (
          <span key={item} className={item === current ? 'chip chip--active' : 'chip'}>
            {item}
          </span>
        ))}
      </div>
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
