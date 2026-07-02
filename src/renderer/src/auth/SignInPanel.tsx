import { useReducer, useRef, type JSX, type ReactNode } from 'react'
import type { AuthMethod } from '../../../shared/ipc'
import { authReducer, initialAuthViewState, selectAuthView } from './auth-view'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { LogoSnakeSpinner } from '../shell/logo-snake-spinner'

/**
 * The not-signed-in panel: clicking Sign-in drives Vibe's delegated browser
 * sign-in via main; on success it bubbles up (`onSignedIn`) so the app opens a
 * Thread on the same retained agent and lands in a connected conversation. The
 * auth lifecycle (signing-in / signed-in / error) is the pure `authReducer`.
 */
export function SignInPanel({
  agentId,
  authMethods,
  onSignedIn,
  onRestartAgent,
}: {
  agentId: string
  authMethods: AuthMethod[]
  onSignedIn: () => void
  /**
   * Stale-cache recovery: Vibe caches keyring reads per-process, so this warm
   * agent can keep reporting signed-out after an out-of-band sign-in (terminal
   * or another process). Disposes the agent and re-runs the connect flow — the
   * fresh process re-reads the keychain. Offered from the recoverable error
   * state (a failed sign-in or a still-not-signed-in check).
   */
  onRestartAgent: () => void
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
        // ok-but-not-signed-in: Vibe said the browser flow AND the credential
        // save succeeded, yet its status still reports signed out — a state its
        // source says is unreachable, so point at the recovery affordances
        // rather than a bare "try again".
        message: result.ok
          ? 'Vibe reported sign-in complete, but its status still shows signed out. Try "Already signed in? Check status", or sign in with `vibe` in a terminal.'
          : result.error,
      })
    }
  }

  function cancel(): void {
    attemptRef.current++ // invalidate the in-flight attempt; its result is dropped
    dispatch({ type: 'sign-in-cancel' })
  }

  // #79: OBSERVE current auth state without re-running the browser flow — recovers
  // an out-of-band `vibe` CLI sign-in, the blocking fallback, or a delegated
  // `complete` whose result we lost. Bumps the attempt generation so any stale
  // in-flight sign-in result is dropped (same guard as `signIn`/`cancel`).
  async function checkStatus(): Promise<void> {
    const attempt = ++attemptRef.current
    dispatch({ type: 'check-start' })
    const result = await window.api.checkAuthStatus({ agentId })
    if (attempt !== attemptRef.current) return // superseded — drop the stale result
    if (result.ok && result.authState === 'signed-in') {
      dispatch({ type: 'sign-in-success' })
      onSignedIn() // continue to a connected Thread on the same agent
    } else if (result.ok) {
      dispatch({
        type: 'sign-in-error',
        message:
          'Still not signed in. Finish signing in (in your browser or via `vibe`), then check again — or use "Restart agent" if you signed in elsewhere and it isn\'t picked up.',
      })
    } else {
      dispatch({ type: 'sign-in-error', message: result.error })
    }
  }

  if (view.kind === 'signed-in') {
    return (
      <SignInCard>
        <SignInLoading label="Signed in — opening your workspace…" />
      </SignInCard>
    )
  }

  if (view.kind === 'signing-out') {
    return (
      <SignInCard>
        <SignInLoading label="Signing out…" />
      </SignInCard>
    )
  }

  if (view.kind === 'signing-in') {
    return (
      <SignInCard>
        <SignInLoading label="Signing in…" />
        <p className="text-[13px] leading-relaxed text-muted">
          Complete sign-in in your browser, then return here.
        </p>
        <Button variant="outline" size="sm" className="self-start" onClick={cancel}>
          Cancel
        </Button>
      </SignInCard>
    )
  }

  if (view.kind === 'checking') {
    return (
      <SignInCard>
        <SignInLoading label="Checking sign-in status…" />
      </SignInCard>
    )
  }

  // sign-in or error: both render the (clickable) Sign-in button so the error
  // state stays recoverable, plus a re-check that OBSERVES auth state without
  // re-running the browser flow (#79) — for an out-of-band `vibe` CLI sign-in.
  return (
    <SignInCard>
      <div className="text-sm font-semibold text-text-strong">Not signed in to Mistral Vibe</div>
      {view.kind === 'sign-in' && view.description && (
        <p className="text-[13px] leading-relaxed text-muted">{view.description}</p>
      )}
      {view.kind === 'error' && <p className="text-[13px] leading-relaxed text-bad">{view.message}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" onClick={() => void signIn(view.methodId)}>
          {view.kind === 'error' ? `Retry — ${view.methodName}` : view.methodName}
        </Button>
        <Button variant="ghost" onClick={() => void checkStatus()}>
          Already signed in? Check status
        </Button>
        {view.kind === 'error' && (
          <Button
            variant="ghost"
            onClick={onRestartAgent}
            title="Stop and respawn this Workspace's agent — a fresh process re-reads the keychain, picking up a sign-in done in a terminal or another window"
          >
            Restart agent
          </Button>
        )}
      </div>
    </SignInCard>
  )
}

/** Centered card chrome shared by every {@link SignInPanel} state (sibling of the
 * connecting/error connect-states). Token surface + rounded card, no legacy BEM. */
function SignInCard({ children }: { children: ReactNode }): JSX.Element {
  return <Card className="mx-auto mt-14 w-full max-w-[420px] gap-3">{children}</Card>
}

/** A branded-spinner + label row for the panel's in-flight states (signing-in /
 * checking / signing-out / opening). Copy is unchanged; only the look. */
function SignInLoading({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 text-sm font-semibold text-text-strong">
      {/* Spinner is decorative here — the visible label carries the accessible name,
          so hide the spinner's own role=img to avoid a double screen-reader announce. */}
      <span aria-hidden className="inline-flex">
        <LogoSnakeSpinner size={16} />
      </span>
      <span>{label}</span>
    </div>
  )
}
