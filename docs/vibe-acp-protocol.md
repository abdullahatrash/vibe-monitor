# Mistral Vibe ACP protocol (`vibe-acp`)

The backend contract. `vibe-acp` is Mistral Vibe's **Agent Client Protocol (ACP)** server — the
same protocol Zed/JetBrains/Neovim use to drive Vibe. Our `src/main/acp/client.ts` speaks this.

- **Transport:** JSON-RPC 2.0 over **stdin/stdout** (newline-delimited, one JSON object per line).
- **Protocol version:** 1. Server impl name: `@mistralai/mistral-vibe`.
- **Process:** long-lived subprocess; internally a `VibeAcpAgentLoop` manages multiple
  `AcpSessionLoop`s (one per session).
- **Spec:** ACP is an open standard — <https://agentclientprotocol.com>. The method set below is
  what `vibe-acp` implements; confirm exact param shapes against the running binary
  (`vibe-acp` + the ACP schema) before finalizing each method.

> ⚠️ Detail confidence: method **names/directions** below are confirmed from Vibe's ACP server docs;
> exact **param/result field names** should be verified against the live binary as we implement each
> one. Treat this as the map, not the final schema.

---

## Message directions

### Client → Agent (we send these)

| Method | Purpose |
|---|---|
| `initialize` | Handshake; negotiate capabilities. Agent reports `load_session`, `embedded_context`, and `auth_method: vibe-setup` (when client advertises `terminal-auth`). |
| `session/new` | Create a fresh session (per workspace/thread). |
| `session/load` | Load/resume an existing session; reports available models and **modes** (`chat`, `plan`, `auto-approve`). |
| `session/prompt` | Send user input; kicks off the agent turn (streams `session/update` back). |
| `session/cancel` | Cancel the active turn/operation. |
| `set_config_option` | Change behavior mid-session: `mode` (plan/chat), `model`, `thinking` (reasoning level). |
| `fs/read_text_file` | Agent-requested file read served by the client. |
| `fs/write_text_file` | Agent-requested file write served by the client. |

### Agent → Client (we receive / must answer)

| Method | Kind | Purpose |
|---|---|---|
| `session/update` | notification | **The streaming channel.** Reasoning steps, tool calls, status, message deltas. Drives the conversation view. |
| `request_permission` | request (must respond) | Approval for a sensitive tool/operation. We show UI and reply with the chosen option. |

(`fs/read_text_file` / `fs/write_text_file` may also arrive agent→client depending on capability
negotiation — i.e. the agent asks the client to do file IO. Confirm direction at implementation.)

---

## Permission model (`request_permission`)

Each request carries `PermissionOption`s; we render them and respond with one:

- `allow_once` — permit this single execution.
- `allow_always` — permit for the rest of the session.
- `allow_always_permanent` — persist the approval across sessions.
- `reject_once` — deny this execution.

Each option includes `required_permissions` metadata (scope + human-readable label) for display.
→ Maps to CodexMonitor's approval toasts and to our roadmap slice #2.

---

## Session lifecycle

1. **initialize** — connect; agent reports capabilities.
2. **authenticate** (optional) — `vibe-setup` flow when credentials are missing.
3. **session/new** or **session/load** — instantiate/resume state.
4. **interaction loop** — `session/prompt` → stream of `session/update` notifications.
5. **permission requests** — `request_permission` mid-turn; client responds.
6. **terminate** — `session/cancel` or natural completion.

**Modes:** `chat`, `plan`, `auto-approve` (set via `set_config_option { mode }` or chosen at
`session/load`). `auto-approve` ≈ CodexMonitor's auto-approve / Vibe's `--yolo`.

**Errors** (map to user-facing messages): `SessionNotFoundError`, `ConfigurationError`
(bad `~/.vibe/config.toml`), `UnauthenticatedError` (not signed in / no valid credential),
`RateLimitError`.

**Quirk:** history compaction has no native ACP message — Vibe surfaces it as a synthetic
`tool_call` titled "Compacting conversation history…". Render it like CodexMonitor's
`contextCompaction` item.

---

## Authentication (two paths — browser sign-in is the default)

Vibe is **not** API-key-only. Per Mistral's
[api-keys-profiles doc](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles):

1. **Browser-based sign-in — DEFAULT** when the config targets a Mistral-provider model. An
   OAuth-style flow tied to the user's **subscription** (Free / Pro / Team / partner plans). Le Chat
   is now Vibe — *same login*. The CLI provisions + stores credentials; no key pasting.
2. **API key (BYOK)** — the alternative path: `vibe --setup` / `MISTRAL_API_KEY` / `~/.vibe/.env`.
   Required for non-Mistral providers (OpenRouter, …), selected via presets in `config.toml`.

**We never store credentials.** Like CodexMonitor with Codex, vibe-monitor delegates all auth and
token storage to the `vibe` binary (`~/.vibe`). We only detect signed-in vs not.

**Over ACP:** `initialize` advertises `auth_method: vibe-setup` (when the client supports
`terminal-auth`). An in-app sign-in would mirror CodexMonitor's Codex OAuth orchestration
(`account/login/start` → open `authUrl` in the system browser → `account/login/completed`), likely
via ACP's `authenticate` method. ⚠️ **Unconfirmed** — verify the exact ACP auth mechanism against the
live `vibe-acp` binary before building any in-app flow.

**Slice #1 stance:** assume the user is **already authenticated** (browser sign-in *or* API key);
do not build the flow; surface `UnauthenticatedError` with a hint to run `vibe` / `vibe --setup`.
In-app sign-in is a later slice and warrants its own ADR.

---

## Headless alternative (not used by the GUI, good for scripts/CI)

`vibe --prompt "…" --output json|streaming` with `--max-turns N`, `--max-price $`, `--max-tokens N`,
`--enabled-tools <glob|regex>`, `--agent <plan|accept-edits|auto-approve>`, `--trust`, `--yolo`,
`--continue` / `--resume <SESSION_ID>`, `--workdir`, `--add-dir`. Config lives in `~/.vibe/`
(`config.toml`, `.env`). We drive the GUI via `vibe-acp`, but these are useful for tests/automation.

---

## Mapping to our code

- `AcpClient.request('initialize', …)` → handshake on session start.
- `AcpClient.request('session/new'|'session/load', …)` → create/resume.
- `AcpClient.request('session/prompt', …)` → send a message.
- `client.on('notification', …)` for `session/update` → reducer upserts conversation items.
- `client.on('serverRequest', …)` for `request_permission` → approval UI → respond by id.

See [codexmonitor-reference.md](./codexmonitor-reference.md) §5 for the `ConversationItem` shapes the
`session/update` stream should map onto.
