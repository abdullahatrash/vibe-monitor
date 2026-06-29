import { DELEGATED_AUTH_METHOD_ID, type AuthMethod } from '../../../shared/ipc'

/**
 * Pure auth view-state selector (no React, no IPC). Maps the detected
 * `AuthState` plus the agent's advertised `authMethods` to what the renderer
 * renders: a distinct sign-in panel when not signed in, nothing otherwise. Per
 * ADR-0001 the renderer owns this; main classifies + relays the AuthState.
 */

/**
 * The renderer's auth-panel lifecycle phase. `not-signed-in` is the entry (main
 * detected it); `signing-in` is the in-flight browser step; `signed-in` is the
 * success terminal; `error` is a recoverable failure the user can retry from.
 */
export type AuthPhase = 'not-signed-in' | 'signing-in' | 'signed-in' | 'error'

/** Pure view state for the sign-in panel — folded by `authReducer`. */
export interface AuthViewState {
  phase: AuthPhase
  authMethods: AuthMethod[]
  /** Recoverable failure message; set only while `phase === 'error'`. */
  error: string | null
}

export function initialAuthViewState(authMethods: AuthMethod[]): AuthViewState {
  return { phase: 'not-signed-in', authMethods, error: null }
}

export type AuthAction =
  | { type: 'sign-in-start' }
  | { type: 'sign-in-success' }
  | { type: 'sign-in-error'; message: string }
  | { type: 'sign-in-cancel' }

/**
 * Fold a sign-in lifecycle action into the panel's view state. Pure (no React,
 * no IPC). `sign-in-start` is allowed from both `not-signed-in` and `error` so
 * the error state stays recoverable (retry); a failure can never leave the
 * panel stuck in `signing-in`. `sign-in-cancel` is the user's escape hatch out
 * of `signing-in` (the browser long-poll itself can't be aborted — see
 * SignInPanel); it just abandons the attempt and returns to `not-signed-in`.
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

/** Render a recoverable failure — the message plus the method to retry with. */
export interface SignInErrorView {
  kind: 'error'
  message: string
  methodId: string
  methodName: string
}

/** Render nothing auth-related (signed in). */
export interface NoAuthView {
  kind: 'none'
}

export type AuthView = SignInView | SigningInView | SignInErrorView | NoAuthView

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
      return { kind: 'none' }
  }
}
