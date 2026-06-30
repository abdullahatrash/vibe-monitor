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

> ✅ **Confirmed against vibe-acp 2.18.0** (live capture). The **verbatim** message shapes are in
> [acp-capture.md](./acp-capture.md) — treat that as authoritative; this page is the narrative map.
> A few items remain unverified (trust grant, `session/cancel`). The mode/model/thinking change
> methods and `session/load` are now confirmed (acp-capture §9, §10).

---

## Message directions

### Client → Agent (we send these)

| Method | Purpose |
|---|---|
| `initialize` | Handshake. Agent returns `agentCapabilities` (`loadSession`, `promptCapabilities.image`), `agentInfo`, `authMethods` (`browser-auth`). camelCase params. |
| `session/new` | Create a session for a workspace. Params `{cwd, mcpServers}`. Returns `sessionId`, `modes`, `models`, `configOptions`, `_meta.workspace_trust`. |
| `session/load` | Load/resume an existing session (capability `loadSession:true`). Params `{sessionId, cwd, mcpServers}`; replays history as `session/update`s then resolves session-new-shaped (acp-capture §9). |
| `session/prompt` | Send user input `{sessionId, prompt:[{type:"text",text}]}`; streams `session/update`; resolves with `{stopReason, usage, userMessageId}`. |
| `session/cancel` | Cancel the active turn. **Shape unverified.** |
| `session/set_mode` | Change Mode. Params `{sessionId, modeId}` → `{}`. (acp-capture §10) |
| `session/set_model` | Change Model. Params `{sessionId, modelId}` → `{}`. ⚠️ false-accepts any string; pass only `availableModels` ids. (§10) |
| `session/set_config_option` | Change a config option (Reasoning effort). Params `{sessionId, configId, value}` → `{}` (note `configId`, not `id`). (§10) |

### Agent → Client (we receive / must answer)

| Method | Kind | Purpose |
|---|---|---|
| `session/update` | notification | **The streaming channel** — discriminated by `update.sessionUpdate` (`agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `session_info_update`, `usage_update`, `available_commands_update`). See capture §4. |
| `session/request_permission` | request (must answer) | Approval for a write/command. Params `{sessionId, toolCall:{toolCallId}, options:[…]}`. Reply `{outcome:{outcome:"selected", optionId}}`. Capture §6. |
| `fs/read_text_file` | request (must answer) | **Client serves the read.** `{path, limit, sessionId}` → `{content}`. |
| `fs/write_text_file` | request (must answer) | **Client performs the write.** `{path, content, sessionId}` → `{}`. |

> **The client owns file I/O.** `fs/read_text_file`/`fs/write_text_file` are not optional — the agent
> delegates all reads/edits to us. Slice #1 must implement both or any file tool stalls the turn.

---

## Permission model (`session/request_permission`)

Fires for **writes/commands** in `default` mode — **not for reads** (reads go straight to
`fs/read_text_file`). Each request carries `options:[{kind, name, optionId}]`; render `name` as the
button, reply with `optionId` via `{outcome:{outcome:"selected", optionId}}`. The four `optionId`s:

- `allow_once` — permit this single execution.
- `allow_always` — permit for the rest of the session.
- `allow_always_permanent` — persist across sessions.
- `reject_once` — deny this execution.

`toolCall.toolCallId` links the request to the pending `tool_call` item. → CodexMonitor's approval
toasts; our slices #1 (once-off) / #2 (allow_always + remembered allowlist).

---

## Session lifecycle

1. **initialize** — connect; agent reports capabilities.
2. **authenticate** (optional) — `vibe-setup` flow when credentials are missing.
3. **session/new** or **session/load** — instantiate/resume state.
4. **interaction loop** — `session/prompt` → stream of `session/update` notifications.
5. **permission requests** — `request_permission` mid-turn; client responds.
6. **terminate** — `session/cancel` or natural completion.

**Modes (5):** `default` (approval-gated), `plan` (read-only), `accept-edits` (auto-approves edits
only), `auto-approve` (auto-approves all), `chat` (read-only conversational). Changed via
`session/set_mode {sessionId, modeId}` (acp-capture §10); NOT preserved across `session/load` (resets to
`default`). `auto-approve` ≈ CodexMonitor's auto-approve / Vibe's `--yolo`.

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

**We never store credentials.** Like CodexMonitor with Codex, vibe-mistro delegates all auth and
token storage to the `vibe` binary (`~/.vibe`). We only detect signed-in vs not.

**Over ACP — now captured (see [acp-capture.md](./acp-capture.md) §8):** detect with `_auth/status`
(`initialize` can't reveal auth state); sign in via `authenticate` (`browser-auth-delegated`:
`start → signInUrl → complete`, or blocking `browser-auth`); sign out via `_auth/signOut`. The
unauthenticated error is JSON-RPC code **-32000** (reserved exclusively for unauthenticated). Credentials
live in the OS keyring; we never store them (see [adr/0003](./adr/0003-auth-delegated-to-vibe.md)).

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
