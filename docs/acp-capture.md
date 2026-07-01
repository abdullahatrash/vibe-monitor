# ACP capture — real `vibe-acp` 2.18.0 traffic

Ground-truth JSON-RPC captured by driving `vibe-acp` directly (stdio) on 2026-06-29, vibe 2.18.0.
These supersede any guessed shapes in [vibe-acp-protocol.md](./vibe-acp-protocol.md). Field names are
**verbatim**.

Capture method: a Node probe spawned `vibe-acp`, sent `initialize` → `session/new` → `session/prompt`,
served the agent's `fs/*` requests, and answered `session/request_permission`. (Scripts were
throwaway; the loop is reproducible.)

---

## 1. `initialize` (client → agent)

**Request**
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}},
  "clientInfo":{"name":"vibe-mistro","version":"0.0.1"}}}
```

**Response (result)**
```json
{"agentCapabilities":{"loadSession":true,
  "promptCapabilities":{"audio":false,"embeddedContext":true,"image":true},
  "sessionCapabilities":{"close":{},"fork":{},"list":{}}},
 "agentInfo":{"name":"@mistralai/mistral-vibe","title":"Mistral Vibe","version":"2.18.0"},
 "authMethods":[{"id":"browser-auth","name":"Sign in through Mistral AI Studio",
   "description":"Sign into Mistral Vibe through your Mistral AI Studio account."}],
 "protocolVersion":1}
```
Notes: ACP-standard **camelCase**. `image:true` → image attachments supported. `authMethods` confirms
browser sign-in (`browser-auth`). `loadSession:true` + `sessionCapabilities.{list,fork,close}` →
resume/fork/list are available.

---

## 2. `session/new` (client → agent)

**Request**: `{"id":2,"method":"session/new","params":{"cwd":"<abs path>","mcpServers":[]}}`

**Response (result)** — abridged:
```json
{"sessionId":"8b7044cf-19d1-7a23-8da1-929c81b23170",
 "_meta":{"workspace_trust":{"status":"untrusted","details":null}},
 "modes":{"currentModeId":"default","availableModes":[
   {"id":"default","name":"Default","description":"Requires approval for tool executions"},
   {"id":"plan","name":"Plan","description":"Read-only agent for exploration and planning"},
   {"id":"accept-edits","name":"Accept Edits","description":"Auto-approves file edits only"},
   {"id":"auto-approve","name":"Auto Approve","description":"Auto-approves all tool executions"},
   {"id":"chat","name":"Chat","description":"Read-only conversational mode for questions and discussions"}]},
 "models":{"currentModelId":"mistral-medium-3.5","availableModels":[
   {"modelId":"mistral-medium-3.5","name":"mistral-medium-3.5"},
   {"modelId":"devstral-small","name":"devstral-small"},
   {"modelId":"local","name":"local"}]},
 "configOptions":[ {"id":"mode",...}, {"id":"model",...}, {"id":"thinking", "currentValue":"high",
   "options":[{"value":"off"},{"value":"low"},{"value":"medium"},{"value":"high"},{"value":"max"}]} ]}
```
Notes: `sessionId` is a UUID. **5 modes** (default is the approval-gated one — the mode slice #1 uses).
`configOptions` mirror modes/model + a `thinking` (reasoning effort) select. `_meta.workspace_trust`
reported `untrusted` for a fresh temp dir — but reads **and** writes still succeeded this session, so
trust appears informational here, not a hard gate. (Method to *grant* trust / *change* mode not yet
captured — verify before building a mode picker or trust UI.)

---

## 3. `session/prompt` (client → agent)

**Request**
```json
{"id":3,"method":"session/prompt","params":{"sessionId":"<uuid>",
  "prompt":[{"type":"text","text":"Create a new file called note.txt containing: vibe-mistro works."}]}}
```

**Final response (result)** — arrives when the turn ends:
```json
{"stopReason":"end_turn",
 "usage":{"inputTokens":20888,"outputTokens":159,"totalTokens":21047},
 "userMessageId":"d2ae134c-..."}
```

---

## 4. `session/update` notifications (agent → client)

Shape: `{"method":"session/update","params":{"sessionId":"<uuid>","update":{"sessionUpdate":"<type>", ...}}}`.
Discriminator is **`update.sessionUpdate`**. Types observed:

| `sessionUpdate` | Payload (verbatim keys) | Meaning |
|---|---|---|
| `session_info_update` | `{title}` | Thread title (auto-derived from first prompt) |
| `agent_thought_chunk` | `{content:{type:"text",text}, messageId}` | **Reasoning** delta — accumulate by `messageId` |
| `agent_message_chunk` | `{content:{type:"text",text}, messageId}` | **Assistant answer** delta — accumulate by `messageId` |
| `tool_call` | `{toolCallId, kind, status, title, _meta:{tool_name}, locations:[{path}], rawInput, content:[…]}` | Tool started/updated (`kind`: `read`, `edit`, …; `status`: `pending`→`completed`) |
| `tool_call_update` | `{toolCallId, status, content:[…], rawOutput, locations, kind}` | Tool progress/result keyed by `toolCallId` |
| `usage_update` | `{used, size, cost:{amount,currency}}` | Live context usage (`used`/`size`) + running cost |
| `available_commands_update` | `{availableCommands:[{name, description, input?}]}` | Slash commands / skills |

`tool_call.content` entries seen: `{type:"diff", path, newText}` (edits) and
`{type:"content", content:{type:"text",text}}` (read output).

---

## 5. Client-served requests (agent → client) — **we must implement these**

The agent delegates file I/O to the client. Our main process answers these by `id`:

**`fs/read_text_file`**
```json
{"id":0,"method":"fs/read_text_file","params":{"path":"<abs>","limit":2001,"sessionId":"<uuid>"}}
→ result: {"content":"<file text>"}
```

**`fs/write_text_file`**
```json
{"id":1,"method":"fs/write_text_file","params":{"path":"<abs>","content":"<text>","sessionId":"<uuid>"}}
→ result: {}
```
Implication: **the client performs the actual edits.** Slice #1 must implement both, or any
read/write tool stalls the turn.

---

## 6. `session/request_permission` (agent → client) — the approval gate

Fires for **writes/commands** in `default` mode (NOT for reads — reads go straight to
`fs/read_text_file`).

**Request**
```json
{"id":0,"method":"session/request_permission","params":{
  "sessionId":"<uuid>",
  "toolCall":{"toolCallId":"EcjzekVw0"},
  "options":[
    {"kind":"allow_once","name":"Allow once","optionId":"allow_once"},
    {"kind":"allow_always","name":"Allow for remainder of this session","optionId":"allow_always"},
    {"kind":"allow_always","name":"Always allow","optionId":"allow_always_permanent"},
    {"kind":"reject_once","name":"Deny","optionId":"reject_once"}]}}
```

**Response (selected)**
```json
{"id":0,"result":{"outcome":{"outcome":"selected","optionId":"allow_once"}}}
```
Render `option.name` as the button label; reply with `option.optionId`. Link to the pending tool via
`toolCall.toolCallId`. (Cancel/deny path: `reject_once`; a `{"outcome":{"outcome":"cancelled"}}` form
likely exists — verify if/when we add a cancel affordance.)

---

## 7. Observed write turn — end-to-end order

1. `tool_call` (kind `edit`, tool_name `write_file`, status `pending`, `content:[{type:"diff",path,newText}]`)
2. `session/request_permission` → client replies `{outcome:{outcome:"selected",optionId:"allow_once"}}`
3. `fs/write_text_file` (client writes, replies `{}`)
4. `tool_call_update` (status `completed`, `rawOutput:{bytes_written,…}`)
5. `usage_update`
6. `session/prompt` **response** (`stopReason:"end_turn"`, usage)

Read turn is the same minus the permission step.

---

## What this changes for slice #1

- **New requirement:** implement `fs/read_text_file` + `fs/write_text_file` handlers in main — the agent
  relies on the client for file I/O.
- **Permission:** wire `session/request_permission` → renderer queue → respond `{outcome:{outcome:
  "selected", optionId}}`. Map the 4 `options` to buttons by `name`/`optionId`. Reads won't prompt.
- **Reducer items:** reasoning = `agent_thought_chunk`, message = `agent_message_chunk` (both keyed by
  `messageId`); tools keyed by `toolCallId`. Title from `session_info_update`; context ring + cost from
  `usage_update`.
- **Default mode** (not "chat") is correct for slice #1 — it gates writes/commands behind the prompt.
- **Still to verify:** method to change mode / grant workspace trust; `session/load` (resume) and
  `session/cancel` shapes.

---

## 8. Authentication (captured 2026-06-29, vibe-acp 2.18.0)

Captured by driving `vibe-acp` after deleting the macOS Keychain credential (signed out), then
re-authenticating. Corroborated by reading Vibe's installed source (`site-packages/vibe/acp/`,
which is plain Python).

### Auth state is NOT in `initialize`
`initialize` is byte-identical signed-in vs signed-out — `authMethods:[{id:"browser-auth", …}]` is
always present. So you cannot detect auth state from the handshake. Use `auth/status` (below).

### `_auth/status` — clean detection (ACP extension method)
Extension methods are sent with a leading `_` on the wire (ACP strips it before dispatch):
```
>>> {"id":20,"method":"_auth/status"}
<<< {"id":20,"result":{"authenticated":false,"authState":"signed_out","signOutAvailable":false}}   // signed out
<<< {"id":40,"result":{"authenticated":true, "authState":"os_keyring","signOutAvailable":true }}    // signed in
```
`authState` values seen: `signed_out`, `os_keyring`. (Source implies others for BYOK env/api-key.)
**This is the detection call** — no need to force an error.

### The real `UnauthenticatedError`
When signed out, `session/new` fails (the error surfaces there, not at `session/prompt`):
```
>>> {"id":2,"method":"session/new","params":{"cwd":"…","mcpServers":[]}}
<<< {"id":2,"error":{"code":-32000,"message":"Missing API key for mistral provider.","data":null}}
```
**`-32000` is reserved EXCLUSIVELY for `UnauthenticatedError` in Vibe** (per `vibe/acp/exceptions.py`):
other Vibe errors use `-31xxx` application codes (rate-limited `-31001`, configuration `-31002`,
conversation-limit `-31003`, context-too-long `-31004`, refusal `-31005`, compaction-failed `-31006`,
invalid-image `-31007`, images-unsupported `-31008`) and standard JSON-RPC `-326xx`
(`-32601` method-not-found, `-32602` invalid-params, `-32603` internal). So **code `-32000` is the
reliable unauthenticated signal** — this REVERSES the TB1 decision (#2) that dropped the `-32000`
check on the (then-unconfirmed) assumption it was a generic code. The message is framed as
"Missing API key for <provider> provider", which a "sign in / unauthenticated" regex would miss — so
classify on the **code**, not the message.

### `authenticate` — two modes
```
authenticate(method_id, **kwargs) -> AuthenticateResponse
```
1. **`browser-auth` (agent-driven, blocking)** — the AGENT opens the browser and blocks until the user
   completes sign-in, then persists the key to the OS keyring:
   ```
   >>> {"id":30,"method":"authenticate","params":{"methodId":"browser-auth"}}
   <<< {"id":30,"result":{"_meta":{"browser-auth":{"persistResult":"completed","status":"completed"}}}}
   ```
2. **`browser-auth-delegated` (client-driven, two-step)** — ✅ **live-confirmed 2026-06-29** (probe was
   non-destructive: only `start` was called, never `complete`, so nothing was signed in/out and the
   keyring was untouched). Advertised only if the client opts in via `clientCapabilities._meta`
   (`field_meta` in `vibe/acp/acp_agent_loop.py::_supports_delegated_browser_auth`). The CLIENT opens the URL.
   ```
   // initialize MUST advertise the capability or the method is absent from authMethods:
   initialize.params.clientCapabilities = { fs:{…}, _meta:{ "browser-auth-delegated": true } }
   // → initialize.result.authMethods then includes BOTH:
   //   {id:"browser-auth", name:"Sign in through Mistral AI Studio"}
   //   {id:"browser-auth-delegated", name:"Sign in through Mistral AI Studio"}

   // start — returns IMMEDIATELY (non-blocking); client then opens signInUrl in the system browser:
   >>> {"id":2,"method":"authenticate","params":{"methodId":"browser-auth-delegated","action":"start"}}
   <<< {"id":2,"result":{"_meta":{"browser-auth-delegated":{
         "attemptId":"fb067327-…",
         "expiresAt":"2026-06-29T11:22:26.037185Z",
         "signInUrl":"https://console.mistral.ai/codestral/cli/authenticate?process_id=fb067327-…"}}}}

   // complete — call AFTER the user finishes in the browser; THIS is the call that awaits/persists
   // (source: _complete_delegated_browser_auth). Unknown/expired attemptId → InvalidRequestError (-32602):
   >>> authenticate({methodId:"browser-auth-delegated", action:"complete", attemptId})
   <<< {_meta:{"browser-auth-delegated":{attemptId, persistResult, status:"completed"}}}
   ```
   Source facts (`acp_agent_loop.py`): `start` calls `start_attempt()` (mints the URL, stores a pending
   attempt by `attemptId`); `complete` requires that `attemptId` (else `InvalidRequestError`), calls
   `complete_attempt()` (blocks until the browser flow resolves), then persists to the keyring. So `start`
   is cheap/non-blocking and `complete` is the long-poll — orchestrate accordingly.
   **This delegated mode is the right fit for vibe-mistro** (we open the URL via the system opener,
   show progress, stay non-blocking) — it mirrors CodexMonitor's `login/start → open authUrl → complete`,
   and is the **primary** path per ADR-0003 (blocking `browser-auth` is the fallback).

### `_auth/signOut` — sign out (ACP extension method)
Removes the API key from the keyring; errors if `signOutAvailable` is false:
```
>>> {"id":N,"method":"_auth/signOut"}
<<< {"id":N,"result":{}}
```

### Credentials live in the OS keyring
`authState:"os_keyring"`. A fresh empty `VIBE_HOME` stays authenticated; there was no `MISTRAL_API_KEY`
in the environment. vibe-mistro never stores credentials — Vibe owns them (keyring). See ADR-0003.

### Bonus (resolves earlier unknowns)
Vibe also exposes these ACP extension methods (all `_`-prefixed on the wire): `trust/status`,
`trust/decision` (the workspace-trust grant we flagged as unconfirmed), `session/set_title`,
`session/delete`.

### What this means for the auth slices (#11–#13)
- **#11 Detect:** call `_auth/status` after `initialize`; classify on `authenticated`/`authState`.
  Treat a `-32000` error mid-session as expiry → re-detect/offer sign-in.
- **#12 Sign in:** advertise the `browser-auth-delegated` capability, `authenticate(start)` → open
  `signInUrl` via the system opener → `authenticate(complete, attemptId)`. (Fallback: blocking
  `browser-auth`.)
- **#13 Sign out / status:** `_auth/signOut`, gated on `signOutAvailable`; show `authState`.

## 9. `session/load` — resume behaviour (captured 2026-06-29 via the #29 spike, vibe-acp 2.18.0)

Captured live by `scripts/spike-session-load.ts` against the real binary (signed-in user,
`authState: os_keyring`). The probe created a session (`session/new` + a trivial prompt),
then resumed it from a **fresh process**. This is the protocol truth TB4 (#33) builds on.

### `agentCapabilities.loadSession: true`
`initialize` advertises `loadSession: true` — so we may call `session/load`. Gate the resume
path on this flag (fall straight to (b) re-bind if a future build drops it).

### Resume SUCCEEDS — `session/load` (client → agent)
Request params mirror `session/new` but carry the prior `sessionId`:

```json
{ "sessionId": "4d8e9017-925b-e223-27d0-5b2107d5dbdd", "cwd": "/tmp/vibe-spike", "mcpServers": [] }
```

Two things happen, in this order:

1. **History is replayed OVER THE WIRE as `session/update` notifications, BEFORE the result
   resolves.** Observed replay for a one-turn session (5 notifications):
   `user_message_chunk` → `agent_thought_chunk` → `agent_message_chunk` → `usage_update`
   → `available_commands_update`. Each carries the original `messageId`s. Note the replayed
   `usage_update` reports `used: 0` / `cost: 0` (replay, not a re-charge).
2. **The `session/load` result resolves** with the SAME shape as `session/new`
   (`configOptions`, `models`, `modes`, `_meta.workspace_trust`) **except there is NO
   `sessionId` field** in the result — the caller already knows the id it loaded.

> **Design consequence for TB4:** because WE own the JSONL transcript and replay it through
> our reducer on reopen, the wire-replayed `session/update` notifications during `session/load`
> are DUPLICATES of history we already have. TB4 must **suppress/ignore** the notifications
> that arrive between the `session/load` request and its result (don't tee them, don't render
> them) — otherwise the conversation doubles. The result resolving is the "resume complete"
> signal; live streaming resumes only on the NEXT user prompt.

### Resume FAILS — unknown/expired session id
`session/load` with a `sessionId` the agent doesn't know rejects with a JSON-RPC error:

```json
{ "code": -32602, "message": "Session not found: <id>", "data": { "session_id": "<id>" } }
```

> **This `-32602` ("Session not found") is the exact signal the (b) re-bind branch keys on.**
> On it (or any `session/load` rejection), TB4 falls back to binding a FRESH session
> (`session/new`) under the SAME Thread id, keeping our JSONL history visible — Vibe loses its
> agent-side context, we don't lose the user's visible transcript. Match on `code === -32602`
> AND/OR a `Session not found` message; treat any other load error as re-bind too (fail safe).

### Infra gotcha — the spike runs under `node`, NOT `bun`
Bun 1.3.8's `node:child_process` does **not** deliver `stdin.write()` to a piped child, so
vibe-acp never receives `initialize` and the handshake times out at 30s with no stderr/exit.
The same `AcpClient` code works instantly under `node` (initialize replies in ~0.9s) and under
Electron (which is why the app itself was unaffected). To re-run the probe:
`bun build scripts/spike-session-load.ts --target=node --outfile=/tmp/spike.mjs && node /tmp/spike.mjs --phase=all --cwd=/tmp/vibe-spike`.

## 10. Agent controls — change Mode / Model / Reasoning effort (captured 2026-06-30 via the #65 spike, vibe-acp 2.18.0)

`session/new` (§2) returns the current values + options as `modes`, `models`, and `configOptions`
(ids `mode` / `model` / `thinking`). The **5 modes** are `default` (requires approval for tool
executions), `plan` (read-only — exploration/planning), `accept-edits` (auto-approves file edits only),
`auto-approve` (auto-approves all tool executions), `chat` (read-only conversational). `thinking` is a
select of `off` / `low` / `medium` / `high` / `max`. There are **three distinct setters** — confirmed on
the wire AND against the agent source (`acp/schema.py`):

| Axis | Method | Params | Response |
|---|---|---|---|
| Mode | `session/set_mode` | `{ sessionId, modeId }` | `{}` |
| Model | `session/set_model` | `{ sessionId, modelId }` | `{}` |
| Reasoning effort | `session/set_config_option` | `{ sessionId, configId, value }` | `{}` |

```jsonc
// e.g. switch to plan mode:
{"jsonrpc":"2.0","id":3,"method":"session/set_mode","params":{"sessionId":"…","modeId":"plan"}}
// → {"jsonrpc":"2.0","id":3,"result":{}}
```

Gotchas (cost real guesses — captured so the picker doesn't repeat them):
- The config-option param is **`configId`, NOT `id`** (`{id, value}` returns `-32602` Invalid params).
  `session/set_config_option` is the GENERIC setter; `thinking` goes through it.
- `set_config_option` (no `session/` prefix) does **not** exist (`-32601`). Mode/Model have **dedicated**
  methods (`session/set_mode` / `session/set_model`) — they do NOT go through `set_config_option`.
- `session/set_model` **false-accepts any string** as a `modelId` (returns `{}` for `"off"`) without
  validating against `availableModels` — so a successful `{}` is NOT proof the value was valid. Pass only
  ids from `models.availableModels`.

### Q3 — no change-notification
A successful change emits **no** `session/update` (no `current_mode_update`/`current_model_update`); the
empty `{}` result is the only signal. **The renderer must update the displayed current value
optimistically** and revert on an error response (ADR-0007).

### Q2 — Mode does NOT survive `session/load`
Set `mode=plan`, prompted (to persist the session), then `session/load` in a fresh process →
`modes.currentModeId` came back **`default`**, not `plan`. So Vibe does **not** persist the Mode across a
resume. (`currentModelId` did come back as the set value in this run, but treat persistence as
unreliable.) ⇒ ADR-0007's fallback applies: the picker must **cache the selected Mode (and Model)
per-Thread and re-assert via the setters after `session/load`**, since display-from-session-state alone
would silently revert to `default` on every reopen.

### Infra — same `node`-not-`bun` gotcha as §9
Run the probe built to a node target: `bun build scripts/spike-config-option.ts --target=node --outfile=/tmp/spike-config.mjs && node /tmp/spike-config.mjs`. `--skip-q2` skips the credit-costing prompt+reload. Safe under the house rules — it touches only `session/*` (no `authenticate`/`_auth`).

---

## 11. Image attachments — `session/prompt` content-block shape (captured 2026-07-01 via the composer-extras image spike, vibe-acp 2.18.3)

`promptCapabilities.image:true` (§1) is real, but the block shape is a **trap**: `session/prompt`
`prompt[]` accepts a distinct **image content block**, and the field is **`mime_type` (snake_case)** — the
ACP-conventional camelCase `mimeType` is *silently accepted but blind* (the image never reaches the model).

**USE THIS (verified — model named the image's colour):**
```json
{"type":"image","data":"<BARE base64, no data: prefix>","mime_type":"image/png"}
```

**DO NOT USE — `mimeType` (camelCase):** the request SUCCEEDS (no error, `attachment_counts:{image:1}`) but the
vision model answers "I cannot see images." Reproduced twice. `data` must be **bare base64** (a `data:` URI in
either `data` or a `uri` field is rejected `-32602`).

**Full content-block union** (leaked verbatim by a `-32602` pydantic error when probing wrong shapes):
- `TextContentBlock` — `{type:"text", text}`
- `ImageContentBlock` — `{type:"image", data, mime_type}` (bare base64)
- `AudioContentBlock` — `{type:"audio", data, mime_type}` (advertised `audio:false`, so unused)
- `ResourceContentBlock`/resource_link — `{type:"resource_link", name, uri}`
- `EmbeddedResourceContentBlock` — `{type:"resource", resource}` (pairs with `embeddedContext:true`)

**Model vision support is per-model, gated BEFORE the model call** — an unsupported model returns app-code
**`-31008`** ("Model `X` does not support images. Switch model…"), NOT `-32602`. Of this account's models only
**`mistral-medium-3.5`** ingested the image; **`devstral-small`** and **`local`** → `-31008`. ⇒ the composer
must **gate/warn on image attach when the current Model isn't vision-capable** (and there's no capability flag
in `availableModels` — discovered only by attempting, or by a hardcoded allow-list we keep in sync). Invalid
image *data* (right shape, bad bytes) is a separate app code **`-31007`**.

### Infra — same `node`-not-`bun` gotcha as §9/§10
`bun build scripts/spike-image-block.ts --target=node --outfile=/tmp/spike-image.mjs && node /tmp/spike-image.mjs`.
The probe generates a solid-colour PNG in pure Node, sweeps candidate block shapes on an image-capable model, and
uses the model naming the colour as the true round-trip test. Read-only (`chat` mode); touches only
`session/*` + `_auth/status` — safe under the house rules.
