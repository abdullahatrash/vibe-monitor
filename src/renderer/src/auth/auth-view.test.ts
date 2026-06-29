import { describe, it, expect } from 'vitest'
import { authReducer, initialAuthViewState, selectAuthView } from './auth-view'
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
    // Its keys are exactly the lifecycle fields, nothing credential-shaped.
    expect(Object.keys(state).sort()).toEqual(['authMethods', 'error', 'phase'])
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

  it('shows a signing-in view during the browser step', () => {
    const state = authReducer(initialAuthViewState([DELEGATED]), { type: 'sign-in-start' })
    expect(selectAuthView(state)).toEqual({ kind: 'signing-in' })
  })

  it('shows no auth panel once signed in', () => {
    let state = authReducer(initialAuthViewState([DELEGATED]), { type: 'sign-in-start' })
    state = authReducer(state, { type: 'sign-in-success' })
    expect(selectAuthView(state)).toEqual({ kind: 'none' })
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
