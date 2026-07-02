import type { JSX } from 'react'
import type { VibeDetectResult } from '../../../shared/ipc'
import { Button } from '../ui/button'

/** The environment check: whether `vibe` / `vibe-acp` are installed + reachable. */
export function Environment({
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

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
