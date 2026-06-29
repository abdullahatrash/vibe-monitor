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
 * Whether `_auth/status` reports sign-out is available (`signOutAvailable`).
 * Gates the renderer's Sign-out control — only `true` enables it (acp-capture §8;
 * `_auth/signOut` errors -32602 when it's false).
 */
export function extractSignOutAvailable(status: unknown): boolean {
  return (status as { signOutAvailable?: unknown } | null)?.signOutAvailable === true
}
