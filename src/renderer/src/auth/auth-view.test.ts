import { describe, it, expect } from 'vitest'
import {
  authReducer,
  initialAuthViewState,
  selectAuthView,
  signedInAuthViewState,
} from './auth-view'
import type { AuthMethod } from '../../../shared/ipc'

/**
 * Seam 3: the pure auth view-state selector. It maps the detected `AuthState`
 * (+ the agent's advertised `authMethods`) to what the renderer shows — a
 * sign-in panel when not signed in, nothing otherwise. Per ADR-0001 the
 * renderer owns this view state; main only classifies + relays.
 */

const BROWSER_AUTH: AuthMethod = {
  id: 'browser-auth',
  name: 'Sign in through Mistral AI Studio',
  description: 'Sign into Mistral Vibe through your Mistral AI Studio account.',
}

const DELEGATED: AuthMethod = {
  id: 'browser-auth-delegated',
  name: 'Sign in through Mistral AI Studio',
}

describe('authReducer', () => {
  it('transitions not-signed-in → signing-in on sign-in-start', () => {
    const state = authReducer(initialAuthViewState([BROWSER_AUTH]), { type: 'sign-in-start' })
    expect(state.phase).toBe('signing-in')
    expect(state.error).toBeNull()
  })

  it('transitions signing-in → signed-in on success without persisting any credential', () => {
    let state = authReducer(initialAuthViewState([BROWSER_AUTH]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-success' })
    expect(state.phase).toBe('signed-in')
    // ADR-0003: we only reflect state — the view state carries no token/secret.
    // Its keys are exactly the lifecycle/display fields, nothing credential-shaped.
    expect(Object.keys(state).sort()).toEqual([
      'authMethods',
      'error',
      'identity',
      'phase',
      'signOutAvailable',
    ])
  })

  it('transitions signing-in → error on failure, carrying a recoverable message', () => {
    let state = authReducer(initialAuthViewState([BROWSER_AUTH]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-error', message: 'Sign-in failed.' })
    expect(state.phase).toBe('error')
    expect(state.error).toBe('Sign-in failed.')
  })

  it('allows retry from error (sign-in-start clears the error → signing-in)', () => {
    let state = authReducer(initialAuthViewState([BROWSER_AUTH]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-error', message: 'boom' })
    state = authReducer(state, { type: 'sign-in-start' })
    expect(state.phase).toBe('signing-in')
    expect(state.error).toBeNull()
  })

  it('returns signing-in → not-signed-in on cancel (escape hatch, never stranded)', () => {
    let state = authReducer(initialAuthViewState([BROWSER_AUTH]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-cancel' })
    expect(state.phase).toBe('not-signed-in')
    expect(state.error).toBeNull()
  })

  it('signs out: signed-in → signing-out → not-signed-in (account switch entry)', () => {
    let state = signedInAuthViewState([BROWSER_AUTH, DELEGATED], true)
    expect(state.phase).toBe('signed-in')
    state = authReducer(state, { type: 'sign-out-start' })
    expect(state.phase).toBe('signing-out')
    state = authReducer(state, { type: 'sign-out-success' })
    // Back to not-signed-in so the same panel can sign a (possibly different)
    // account back in — the authMethods are preserved for that.
    expect(state.phase).toBe('not-signed-in')
    expect(state.authMethods).toEqual([BROWSER_AUTH, DELEGATED])
    expect(state.error).toBeNull()
  })

  it('keeps the user signed in (recoverably) when sign-out fails', () => {
    let state = authReducer(signedInAuthViewState([BROWSER_AUTH], true), { type: 'sign-out-start' })
    state = authReducer(state, { type: 'sign-out-error', message: 'Sign-out failed.' })
    expect(state.phase).toBe('signed-in')
    expect(state.error).toBe('Sign-out failed.')
  })
})

describe('selectAuthView', () => {
  it('shows a sign-in panel preferring the delegated method when not signed in', () => {
    // Both methods are advertised (same display name); we must pick the
    // client-driven `browser-auth-delegated`, not just authMethods[0].
    const view = selectAuthView(initialAuthViewState([BROWSER_AUTH, DELEGATED]))
    expect(view).toEqual({
      kind: 'sign-in',
      methodId: 'browser-auth-delegated',
      methodName: 'Sign in through Mistral AI Studio',
      description: null,
    })
  })

  it('falls back to browser-auth when the delegated method is not advertised (#17)', () => {
    // Older vibe-acp doesn't honor the delegated opt-in, so only the blocking
    // `browser-auth` method is advertised. The selector must pick it — that id
    // is what flows to main's `signIn`, driving the blocking fallback.
    const view = selectAuthView(initialAuthViewState([BROWSER_AUTH]))
    expect(view).toMatchObject({ kind: 'sign-in', methodId: 'browser-auth' })
  })

  it('prefers a drivable method over an undrivable one the agent lists first (#17)', () => {
    // If the agent advertises a method main's `signIn` can't drive (e.g. an
    // env-var/api-key method) BEFORE `browser-auth`, the selector must still pick
    // the drivable `browser-auth`, not authMethods[0] — otherwise `signIn` would
    // refuse the chosen method and strand the user.
    const apiKey: AuthMethod = { id: 'api-key', name: 'API key' }
    const view = selectAuthView(initialAuthViewState([apiKey, BROWSER_AUTH]))
    expect(view).toMatchObject({ kind: 'sign-in', methodId: 'browser-auth' })
  })

  it('shows a signing-in view during the browser step', () => {
    const state = authReducer(initialAuthViewState([DELEGATED]), { type: 'sign-in-start' })
    expect(selectAuthView(state)).toEqual({ kind: 'signing-in' })
  })

  it('shows a signed-in indicator with the sign-out control gated on signOutAvailable', () => {
    const state = signedInAuthViewState([DELEGATED], true)
    expect(selectAuthView(state)).toEqual({
      kind: 'signed-in',
      signOutAvailable: true,
      identity: null, // Vibe exposes no identity — omitted gracefully
      error: null,
    })
  })

  it('hides the sign-out control when signOutAvailable is false', () => {
    const view = selectAuthView(signedInAuthViewState([DELEGATED], false))
    expect(view).toMatchObject({ kind: 'signed-in', signOutAvailable: false })
  })

  it('surfaces an account identity in the signed-in view when one is present', () => {
    // Forward-compatible: if Vibe ever supplies identity, the selector shows it.
    const state = { ...signedInAuthViewState([DELEGATED], true), identity: 'jane@acme.test' }
    expect(selectAuthView(state)).toMatchObject({ kind: 'signed-in', identity: 'jane@acme.test' })
  })

  it('shows a signing-out view during the sign-out step', () => {
    const state = authReducer(signedInAuthViewState([DELEGATED], true), { type: 'sign-out-start' })
    expect(selectAuthView(state)).toEqual({ kind: 'signing-out' })
  })

  it('shows a recoverable error view (with the method to retry) on failure', () => {
    let state = authReducer(initialAuthViewState([BROWSER_AUTH, DELEGATED]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-error', message: 'Sign-in failed.' })
    expect(selectAuthView(state)).toEqual({
      kind: 'error',
      message: 'Sign-in failed.',
      methodId: 'browser-auth-delegated',
      methodName: 'Sign in through Mistral AI Studio',
    })
  })

  it('falls back to a generic sign-in label when no authMethods are advertised', () => {
    // Defensive: never strand the user without a way back in if authMethods is empty.
    expect(selectAuthView(initialAuthViewState([]))).toEqual({
      kind: 'sign-in',
      methodId: '',
      methodName: 'Sign in',
      description: null,
    })
  })
})
