/**
 * Auth domain of the shared IPC contract (ADR-0003): sign-in / sign-out / re-check
 * channels + their payload types. Auth is delegated entirely to Vibe — we never store
 * credentials. Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The auth channel entries, merged into the single `IPC` const in `./index`. */
export const authChannels = {
  /** Drive Vibe's browser sign-in on a not-signed-in agent (`authenticate`). */
  signIn: 'auth:sign-in',
  /** Sign out the agent's session (`_auth/signOut`). */
  signOut: 'auth:sign-out',
  /** Re-query an agent's `_auth/status` without re-running sign-in (#79). */
  checkAuthStatus: 'auth:check-status',
} as const

/**
 * The `authMethods` id for Vibe's client-driven (delegated) browser sign-in
 * (acp-capture §8) — the ADR-0003 primary path. The only method `signIn` drives.
 */
export const DELEGATED_AUTH_METHOD_ID = 'browser-auth-delegated'

/**
 * The `authMethods` id for Vibe's agent-driven (blocking) browser sign-in
 * (acp-capture §8) — the ADR-0003 fallback used when the delegated method is
 * not advertised. A single `authenticate({methodId})` call; the agent opens the
 * browser and blocks until the user finishes.
 */
export const BLOCKING_AUTH_METHOD_ID = 'browser-auth'

/**
 * Whether the user is signed in to Mistral Vibe. `unknown` covers states we
 * can't conclude from the available signal (e.g. a non-auth error). Main
 * classifies; the renderer renders (ADR-0001, ADR-0003).
 */
export type AuthState = 'signed-in' | 'not-signed-in' | 'unknown'

/** An advertised sign-in method from the `initialize` response (`authMethods`). */
export interface AuthMethod {
  id: string
  name: string
  description?: string
}

/** Trigger browser sign-in on the not-signed-in agent retained from startThread. */
export interface SignInArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) to authenticate. */
  agentId: string
  /** The `authMethods` id to sign in with (prefer `browser-auth-delegated`). */
  methodId: string
}

/**
 * Result of a sign-in attempt. `authState` is the post-sign-in state (re-queried
 * via `_auth/status`); failures are recoverable — the renderer can retry.
 */
export type SignInResult =
  | { ok: true; authState: AuthState }
  | { ok: false; error: string }

/** Sign out the agent's session; the agent stays alive for a re-sign-in. */
export interface SignOutArgs {
  /** Id of the Workspace agent to sign out. */
  agentId: string
}

/**
 * Result of a sign-out. On success `authState` is the post-sign-out state
 * (not-signed-in) and `authMethods` lets the renderer show the sign-in panel for
 * an account switch. Failures are recoverable — the user stays signed in.
 */
export type SignOutResult =
  | { ok: true; authState: AuthState; authMethods: AuthMethod[] }
  | { ok: false; error: string }

/**
 * Re-query an agent's current `_auth/status` without re-running sign-in (#79).
 * Lets the panel OBSERVE auth state — picking up an out-of-band `vibe` CLI
 * sign-in, the blocking fallback, or a delegated `complete` whose result we lost.
 */
export interface CheckAuthStatusArgs {
  /** Id of the Workspace agent to re-query. */
  agentId: string
}

/**
 * Result of a re-check. `signOutAvailable` seeds the signed-in indicator when the
 * check lands signed-in (mirrors `SignOutResult`'s gate). Failures are recoverable.
 */
export type CheckAuthStatusResult =
  | { ok: true; authState: AuthState; signOutAvailable: boolean }
  | { ok: false; error: string }
