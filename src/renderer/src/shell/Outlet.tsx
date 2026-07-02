import type { JSX, ReactNode } from 'react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { ConnectState } from '../connection/routing'
import { SignInPanel } from '../auth/SignInPanel'
import { ColdThread } from '../conversation/ColdThread'
import { findSelectedThread, type NavState } from './nav-reducer'

/**
 * The selected Workspace's NON-connected outlet state (connecting / not-signed-in /
 * error). Only the selected Workspace shows a transient view; connected Workspaces
 * render via App's keep-mounted map instead.
 */
export function TransientOutlet({
  connect,
  onContinueToThread,
  onRetry,
}: {
  connect: ConnectState
  onContinueToThread: (agentId: string) => void
  onRetry: () => void
}): JSX.Element | null {
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
          onSignedIn={() => onContinueToThread(connect.agentId)}
        />
      )
    case 'error':
      return (
        <div className="alert">
          <div className="alert__title">Couldn’t connect</div>
          <div className="alert__message">{connect.message}</div>
          {connect.hint && <div className="alert__hint">{connect.hint}</div>}
          <button className="btn alert__action" onClick={onRetry}>
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
 * Thread replayed read-only from JSONL (TB3) with a Continue affordance (TB4), or the
 * `empty` placeholder when nothing is selected. Reached only when the selected Workspace
 * has no connection — so a cold click after another Workspace connected still routes here.
 */
export function ColdOutlet({
  recents,
  nav,
  onClose,
  onContinue,
  empty,
}: {
  recents: ListMetadataResult
  nav: NavState
  onClose: () => void
  onContinue: (thread: ThreadMeta) => void
  empty: ReactNode
}): ReactNode {
  const selectedThread = findSelectedThread(recents, nav)
  if (!selectedThread) return empty
  return (
    <ColdThread
      key={selectedThread.id}
      thread={selectedThread}
      onClose={onClose}
      onContinue={() => onContinue(selectedThread)}
    />
  )
}
