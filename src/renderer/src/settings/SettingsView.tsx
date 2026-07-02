import { useReducer, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { AuthMethod, VibeDetectResult } from '../../../shared/ipc'
import { authReducer, selectAuthView, signedInAuthViewState } from '../auth/auth-view'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { Environment } from './Environment'

/** The selected Workspace's connected agent + its advertised auth, for the Account section. */
export interface AccountInfo {
  agentId: string
  authMethods: AuthMethod[]
  signOutAvailable: boolean
}

/**
 * The Settings page (#130): an on-demand, nav-routed outlet view that replaces the
 * old sidebar gear. A titled panel with a back/close affordance (`onClose` dispatches
 * `close-settings`, so you can leave even with nothing selected) hosting the existing
 * `Environment` env/CLI status. Future settings land here. This is an ADDITIONAL place
 * to check the toolchain — NOT a replacement for the first-run `EmptyState`, which still
 * surfaces a missing toolchain prominently in the outlet when nothing's installed.
 */
export function SettingsView({
  detect,
  loading,
  onRecheck,
  onClose,
  account,
  onSignedOut,
}: {
  detect: VibeDetectResult | null
  loading: boolean
  onRecheck: () => void
  onClose: () => void
  /** The selected Workspace's signed-in account, or null when none is connected. */
  account: AccountInfo | null
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
      <div className="flex items-center gap-2">
        <IconButton aria-label="Back" title="Back" onClick={onClose}>
          <ArrowLeft className="size-4" aria-hidden />
        </IconButton>
        <h1 className="text-[19px] font-semibold tracking-tight text-text-strong">Settings</h1>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-faint">Account</h2>
        <AccountSettings
          // Key by agentId so the auth reducer's seed resets per connection — a new
          // agent can't inherit the prior session's sign-out gate/in-flight state.
          key={account ? `account-${account.agentId}` : 'account-none'}
          account={account}
          onSignedOut={onSignedOut}
        />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-faint">Environment</h2>
        <Environment detect={detect} loading={loading} onRecheck={onRecheck} />
      </section>
    </div>
  )
}

/**
 * The Settings > Account section (moved off the old chat banner). Shows the signed-in
 * status for the selected Workspace's warm agent + a design-system Sign-out control
 * gated on `signOutAvailable`, mirroring the old `SignedInBar`'s pure `authReducer` /
 * `signOut` lifecycle but styled with tokens + `Button` (no legacy banner BEM). Sign-out
 * still calls `window.api.signOut({ agentId })` and, on success, routes that Workspace
 * to its sign-in panel via `onSignedOut` (which also closes Settings). When no Workspace
 * is connected (`account` null) it shows a muted hint and offers no Sign-out.
 */
function AccountSettings({
  account,
  onSignedOut,
}: {
  account: AccountInfo | null
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  const [state, dispatch] = useReducer(
    authReducer,
    signedInAuthViewState(account?.authMethods ?? [], account?.signOutAvailable ?? false),
  )
  const view = selectAuthView(state)

  async function signOut(): Promise<void> {
    if (!account) return
    dispatch({ type: 'sign-out-start' })
    const result = await window.api.signOut({ agentId: account.agentId })
    if (result.ok) {
      dispatch({ type: 'sign-out-success' })
      onSignedOut(result.authMethods)
    } else {
      dispatch({ type: 'sign-out-error', message: result.error })
    }
  }

  if (!account) {
    return (
      <div className="rounded-[9px] border border-border p-3 text-[13px] text-muted">
        Not connected — open a project to manage your session.
      </div>
    )
  }

  const signingOut = view.kind === 'signing-out'
  return (
    <div className="flex flex-col gap-2.5 rounded-[9px] border border-border p-3">
      <div className="flex items-center gap-2 text-[13px]">
        {!signingOut && <span className="size-[7px] shrink-0 rounded-full bg-ok" aria-hidden />}
        <span className="font-semibold text-text-strong">
          {signingOut ? 'Signing out…' : 'Signed in to Mistral Vibe'}
        </span>
        {view.kind === 'signed-in' && view.identity && (
          <span className="text-muted">{view.identity}</span>
        )}
        <span className="flex-1" />
        {view.kind === 'signed-in' && view.signOutAvailable && (
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        )}
      </div>
      {view.kind === 'signed-in' && view.error && (
        <div className="text-[13px] text-bad">{view.error}</div>
      )}
    </div>
  )
}
