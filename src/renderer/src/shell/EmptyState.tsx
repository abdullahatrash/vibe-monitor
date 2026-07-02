import type { JSX } from 'react'
import type { VibeDetectResult } from '../../../shared/ipc'
import { INSTALL_DOCS_URL, INSTALL_HINT } from '../../../shared/install-guidance'
import { Button } from '../ui/button'
import { CodeText } from '../ui/code-text'
import { Environment } from '../settings/Environment'
import { Logo } from './logo'
import { heroHeadline } from './hero-headline'
import type { FirstRunState } from './first-run'

/**
 * The first-run / empty outlet shown when nothing is connected or selected (#49).
 * Driven by the pure `firstRunState`: when `vibe` / `vibe-acp` is missing the env
 * status is surfaced PROMINENTLY here (the user can't proceed until it's installed);
 * when the toolchain's present but no Workspaces exist it nudges Open-project; once
 * everything's set up it's a neutral placeholder (env tucked behind settings).
 */
export function EmptyState({
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
        {/* Same canonical copy as the spawn-error hint + the persistent banner
            (shared/install-guidance) — one root cause, one message. */}
        <p className="hint">
          vibe-mistro drives the <code>vibe-acp</code> ACP server. <CodeText text={INSTALL_HINT} />{' '}
          <a className="underline" href={INSTALL_DOCS_URL} target="_blank" rel="noreferrer">
            Install guide
          </a>
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
