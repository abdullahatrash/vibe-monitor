import { useEffect, useState, type JSX } from 'react'
import type { VibeDetectResult } from '../../shared/ipc'

export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)

  async function runDetect(): Promise<void> {
    setLoading(true)
    const result = await window.api.detectVibe()
    setDetect(result)
    setLoading(false)
  }

  useEffect(() => {
    void runDetect()
  }, [])

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

        <p className="hint">
          Next: wire the ACP handshake (initialize → session/new → session/prompt) and stream
          agent events into a conversation view.
        </p>
      </main>
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
