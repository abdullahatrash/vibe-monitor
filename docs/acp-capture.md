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
  "clientInfo":{"name":"vibe-monitor","version":"0.0.1"}}}
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
  "prompt":[{"type":"text","text":"Create a new file called note.txt containing: vibe-monitor works."}]}}
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
