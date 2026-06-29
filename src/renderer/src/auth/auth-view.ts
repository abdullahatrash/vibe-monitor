import { DELEGATED_AUTH_METHOD_ID, type AuthMethod } from '../../../shared/ipc'

/**
 * Pure auth view-state selector (no React, no IPC). Maps the detected
 * `AuthState` plus the agent's advertised `authMethods` to what the renderer
 * renders: a distinct sign-in panel when not signed in, nothing otherwise. Per
 * ADR-0001 the renderer owns this; main classifies + relays the AuthState.
 */

/**
 * The renderer's auth lifecycle phase. `not-signed-in` is the entry (main
 * detected it); `signing-in` is the in-flight browser step; `signed-in` is
 * signed in (shows the indicator + sign-out); `signing-out` is the in-flight
 * sign-out; `error` is a recoverable sign-in failure the user can retry from.
 */
export type AuthPhase = 'not-signed-in' | 'signing-in' | 'signed-in' | 'signing-out' | 'error'

/** Pure view state for the auth panel/indicator — folded by `authReducer`. */
export interface AuthViewState {
  phase: AuthPhase
  authMethods: AuthMethod[]
  /** Whether Vibe reports sign-out is available — gates the Sign-out control. */
  signOutAvailable: boolean
  /**
   * Account identity to show beside the signed-in indicator, when known. Vibe's
   * `_auth/status` exposes none today (acp-capture §8), so this is always null;
   * the field exists so the selector omits identity gracefully (and is ready if
   * Vibe ever adds one) — we never fetch identity ourselves.
   */
  identity: string | null
  /** Recoverable failure message; set on a sign-in `error` or a failed sign-out. */
  error: string | null
}

/** Seed the not-signed-in entry (panel) with the advertised sign-in methods. */
export function initialAuthViewState(authMethods: AuthMethod[]): AuthViewState {
  return { phase: 'not-signed-in', authMethods, signOutAvailable: false, identity: null, error: null }
}

/** Seed the signed-in entry (indicator + sign-out), gated on `signOutAvailable`. */
export function signedInAuthViewState(
  authMethods: AuthMethod[],
  signOutAvailable: boolean,
): AuthViewState {
  return { phase: 'signed-in', authMethods, signOutAvailable, identity: null, error: null }
}

export type AuthAction =
  | { type: 'sign-in-start' }
  | { type: 'sign-in-success' }
  | { type: 'sign-in-error'; message: string }
  | { type: 'sign-in-cancel' }
  | { type: 'sign-out-start' }
  | { type: 'sign-out-success' }
  | { type: 'sign-out-error'; message: string }

/**
 * Fold an auth lifecycle action into the view state. Pure (no React, no IPC).
 * `sign-in-start` is allowed from both `not-signed-in` and `error` so the error
 * state stays recoverable (retry); a failure can never leave the panel stuck in
 * `signing-in`. `sign-in-cancel` is the user's escape hatch out of `signing-in`
 * (the browser long-poll can't be aborted — see SignInPanel). `sign-out-success`
 * returns to `not-signed-in` so the same panel can sign a different account back
 * in (account switch); `sign-out-error` keeps the user signed-in (recoverable).
 */
export function authReducer(state: AuthViewState, action: AuthAction): AuthViewState {
  switch (action.type) {
    case 'sign-in-start':
      return { ...state, phase: 'signing-in', error: null }
    case 'sign-in-success':
      return { ...state, phase: 'signed-in', error: null }
    case 'sign-in-error':
      return { ...state, phase: 'error', error: action.message }
    case 'sign-in-cancel':
      return { ...state, phase: 'not-signed-in', error: null }
    case 'sign-out-start':
      return { ...state, phase: 'signing-out', error: null }
    case 'sign-out-success':
      return { ...state, phase: 'not-signed-in', signOutAvailable: false, identity: null, error: null }
    case 'sign-out-error':
      return { ...state, phase: 'signed-in', error: action.message }
  }
}

/** Render a sign-in panel — the method name + a clickable Sign-in button. */
export interface SignInView {
  kind: 'sign-in'
  methodId: string
  methodName: string
  description: string | null
}

/** Render the in-flight browser step (a spinner / progress, no button). */
export interface SigningInView {
  kind: 'signing-in'
}

/**
 * Render the signed-in indicator. `signOutAvailable` gates the Sign-out button;
 * `identity` is shown beside it when known (null today — omitted gracefully);
 * `error` carries a failed sign-out message (the user stays signed in).
 */
export interface SignedInView {
  kind: 'signed-in'
  signOutAvailable: boolean
  identity: string | null
  error: string | null
}

/** Render the in-flight sign-out step. */
export interface SigningOutView {
  kind: 'signing-out'
}

/** Render a recoverable failure — the message plus the method to retry with. */
export interface SignInErrorView {
  kind: 'error'
  message: string
  methodId: string
  methodName: string
}

export type AuthView =
  | SignInView
  | SigningInView
  | SignedInView
  | SigningOutView
  | SignInErrorView

/**
 * Pick the sign-in method to drive: prefer the delegated method (the one main's
 * `signIn` accepts), else the first advertised, else a generic fallback so the
 * user is never stranded.
 */
function preferredMethod(authMethods: AuthMethod[]): { id: string; name: string; description: string | null } {
  const method = authMethods.find((m) => m.id === DELEGATED_AUTH_METHOD_ID) ?? authMethods[0]
  return {
    id: method?.id ?? '',
    name: method?.name ?? 'Sign in',
    description: method?.description ?? null,
  }
}

/** Project the auth view-state to what the renderer shows. */
export function selectAuthView(state: AuthViewState): AuthView {
  const method = preferredMethod(state.authMethods)
  switch (state.phase) {
    case 'not-signed-in':
      return { kind: 'sign-in', methodId: method.id, methodName: method.name, description: method.description }
    case 'signing-in':
      return { kind: 'signing-in' }
    case 'error':
      return { kind: 'error', message: state.error ?? 'Sign-in failed.', methodId: method.id, methodName: method.name }
    case 'signed-in':
      return {
        kind: 'signed-in',
        signOutAvailable: state.signOutAvailable,
        identity: state.identity,
        error: state.error,
      }
    case 'signing-out':
      return { kind: 'signing-out' }
  }
}
