# Authentication is delegated to the `vibe` binary; vibe-monitor never stores credentials

vibe-monitor does not implement authentication or store any credentials. Vibe owns auth: it keeps the
credential in the **OS keyring** (`authState: "os_keyring"`) and exposes the whole surface over ACP
extension methods, which vibe-monitor merely drives and reflects:

- **Detect** with `_auth/status` → `{ authenticated, authState, signOutAvailable }`. Auth state is NOT
  derivable from `initialize` (its `authMethods` list is always present), so `auth/status` is the
  source of truth. A mid-session `UnauthenticatedError` (JSON-RPC code **-32000**, which Vibe reserves
  exclusively for unauthenticated — see `docs/acp-capture.md` §8) is treated as expiry.
- **Sign in** via the **`browser-auth-delegated`** method (`authenticate(start)` → `signInUrl` → open in
  the system browser → `authenticate(complete, attemptId)`), mirroring CodexMonitor's
  `login/start → open authUrl → complete`. The blocking agent-driven `browser-auth` is the fallback.
- **Sign out** via `_auth/signOut` (gated on `signOutAvailable`); it clears the keyring entry.

This is the auth-specific application of ADR-0002's thin-orchestrator stance: agent capabilities
(including credential storage) belong to Vibe, not the shell.

## Considered options

- **Store/manage credentials in vibe-monitor** (e.g. our own keychain entry or token cache) — rejected.
  It would duplicate secrets insecurely, diverge from Vibe's source of truth, and break the moment Vibe
  rotates/relocates them. Vibe already owns the keyring entry.
- **Delegate entirely to the `vibe` binary** (chosen) — we only trigger sign-in/out and read
  `auth/status`. We never see a token.

## Consequences

- vibe-monitor has no credential storage and no secrets at rest. Signing out is Vibe's keyring removal;
  we just call `_auth/signOut`.
- We depend on Vibe's ACP auth extension methods (`_auth/status`, `_auth/signOut`, `authenticate`).
  These are `_`-prefixed extension methods (unstable surface) — pin behavior against the captured
  shapes in `docs/acp-capture.md` §8 and re-verify on Vibe upgrades.
- BYOK (a `MISTRAL_API_KEY` env var or `~/.vibe/.env`) authenticates without our sign-in flow; we treat
  any `authenticated: true` from `auth/status` as signed in regardless of `authState`.
