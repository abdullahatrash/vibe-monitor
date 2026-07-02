import type { AuthState } from '../../shared/ipc'

/**
 * Pure auth-state classification for Mistral Vibe (docs/acp-capture.md §8).
 *
 * The unauthenticated signal is the JSON-RPC error *code* `-32000`, which Vibe
 * reserves EXCLUSIVELY for `UnauthenticatedError`. We deliberately do not match
 * on the message: the real text is "Missing API key for <provider> provider",
 * which a "sign in / unauthenticated" word-match would miss. (This replaces the
 * earlier message-regex heuristic in WorkspaceAgent.)
 */

/** JSON-RPC error code Vibe reserves exclusively for `UnauthenticatedError`. */
export const UNAUTHENTICATED_CODE = -32000

/** Map an ACP request failure to an `AuthState`. */
export function classifyAuthError(error: unknown): AuthState {
  const code = (error as { code?: unknown } | null)?.code
  if (code === UNAUTHENTICATED_CODE) return 'not-signed-in'
  return 'unknown'
}

/**
 * Map an `_auth/status` result (`{authenticated, authState, signOutAvailable}`)
 * to an `AuthState`. Any `authenticated:true` is signed in regardless of
 * `authState` (covers BYOK env/api-key, not just `os_keyring`) — see ADR-0003.
 */
export function classifyAuthStatus(status: unknown): AuthState {
  const authenticated = (status as { authenticated?: unknown } | null)?.authenticated
  if (authenticated === true) return 'signed-in'
  if (authenticated === false) return 'not-signed-in'
  return 'unknown'
}

/**
 * Vibe's `authenticate` responses report credential-persist failures IN-BAND:
 * `_meta[method].persistResult` is `"completed"` on success, or an error detail
 * (`"env_var_error:…"`, `"save_error:…"`) with NO JSON-RPC error — the browser
 * flow itself succeeded but the key was never saved to env/keyring
 * (vibe/setup/auth/api_key_persistence.py). Ignoring it leaves every follow-up
 * `_auth/status` signed out with only a vague "did not complete" to show for it.
 * Returns the failure detail to surface, or null when the persist succeeded —
 * or when the field is absent (older vibe-acp), which must not fail sign-in.
 * This reads a save-status string, never a credential (ADR-0003 still holds).
 */
export function classifyPersistFailure(persistResult: unknown): string | null {
  if (typeof persistResult !== 'string' || persistResult === 'completed') return null
  return persistResult
}

/**
 * Whether `_auth/status` reports sign-out is available (`signOutAvailable`).
 * Gates the renderer's Sign-out control — only `true` enables it (acp-capture §8;
 * `_auth/signOut` errors -32602 when it's false).
 */
export function extractSignOutAvailable(status: unknown): boolean {
  return (status as { signOutAvailable?: unknown } | null)?.signOutAvailable === true
}
