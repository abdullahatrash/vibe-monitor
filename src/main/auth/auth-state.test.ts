import { describe, it, expect } from 'vitest'
import { classifyAuthError, classifyAuthStatus, classifyPersistFailure } from './auth-state'

/**
 * Seam 1: the pure auth-state classifier. It maps an ACP failure/outcome to an
 * `AuthState`. These cases pin the captured shapes from docs/acp-capture.md §8 —
 * crucially that we key the unauthenticated signal on the JSON-RPC *code*
 * (`-32000`, reserved exclusively for `UnauthenticatedError`), NOT the message.
 */

describe('classifyAuthError', () => {
  it('classifies a JSON-RPC -32000 error as not-signed-in', () => {
    expect(classifyAuthError({ code: -32000, message: 'Missing API key for mistral provider.' })).toBe(
      'not-signed-in',
    )
  })

  it('does NOT classify a non--32000 error as not-signed-in', () => {
    // -32603 internal, -31002 configuration: real but unrelated failures. We
    // can't conclude auth state from them, so they are `unknown`, never
    // not-signed-in (the bug the old message regex risked the other way).
    expect(classifyAuthError({ code: -32603, message: 'internal error' })).toBe('unknown')
    expect(classifyAuthError({ code: -31002, message: 'configuration error' })).toBe('unknown')
  })
})

describe('classifyAuthStatus', () => {
  it('maps a signed-out _auth/status result to not-signed-in', () => {
    expect(
      classifyAuthStatus({ authenticated: false, authState: 'signed_out', signOutAvailable: false }),
    ).toBe('not-signed-in')
  })

  it('maps a signed-in _auth/status result to signed-in', () => {
    expect(
      classifyAuthStatus({ authenticated: true, authState: 'os_keyring', signOutAvailable: true }),
    ).toBe('signed-in')
  })

  it('returns unknown for a malformed status missing the authenticated field', () => {
    // Defensive: never guess sign-in state from a shape we don't recognize.
    expect(classifyAuthStatus({})).toBe('unknown')
    expect(classifyAuthStatus({ authState: 'os_keyring' })).toBe('unknown')
  })
})

describe('classifyPersistFailure', () => {
  it('passes a completed persist', () => {
    expect(classifyPersistFailure('completed')).toBeNull()
  })

  it('surfaces the in-band failure detail (no JSON-RPC error accompanies it)', () => {
    // The real shapes from vibe/setup/auth/api_key_persistence.py: the browser
    // flow succeeded but NOTHING was saved (env_var_error) or only the process
    // env was (save_error) — the exact "browser says signed in, app and terminal
    // say signed out" stranding this classifier exists to prevent.
    expect(classifyPersistFailure('env_var_error:MISTRAL_API_KEY')).toBe(
      'env_var_error:MISTRAL_API_KEY',
    )
    expect(classifyPersistFailure('save_error:read-only file system')).toBe(
      'save_error:read-only file system',
    )
  })

  it('does not fail sign-in when the field is absent (older vibe-acp)', () => {
    expect(classifyPersistFailure(undefined)).toBeNull()
    expect(classifyPersistFailure(null)).toBeNull()
  })
})
