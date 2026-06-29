# T3 Code reference — patterns to learn from

A study of **[pingdotgg/t3code](https://github.com/pingdotgg/t3code)** ("T3 Code", by Ping Labs / Theo),
a GUI for **multiple** CLI coding agents (Codex, Claude, Cursor, OpenCode, Grok). We drive **one** agent —
Mistral Vibe over ACP — so this doc reads t3code through that lens: **what's directly transferable** vs.
**what's overkill** for a single-provider Electron + ACP app.

> Cloned read-only at `/Users/abdullahatrash/mistral/t3code` (a sibling reference repo, like
> [codexmonitor-reference.md](./codexmonitor-reference.md) and [opencode-electron-patterns.md](./opencode-electron-patterns.md)).
> Paths below are relative to that checkout. t3code is a `pnpm` + **Effect-TS** monorepo; it is far larger and
> more ambitious than us — treat it as a catalogue of patterns, not a blueprint to copy wholesale.

## TL;DR — the one thing to actually steal

`packages/effect-acp` is an **Effect-TS wrapper of the exact ACP protocol we hand-rolled** in
`src/main/acp/client.ts`, and `apps/server/src/provider/acp/` shows how to spawn the agent, resume a
session (`session/load`), and **normalize `session/update` into a typed event union**. If we ever revisit
our ACP layer, read these first. Everything else here is "nice to know, mostly bigger than we need."

---

## How t3code is shaped (and how it differs from us)

| | **t3code** | **us (Vibe Mistro)** |
|---|---|---|
| Scope | many agents (Codex/Claude/Cursor/OpenCode/Grok) | one agent (Mistral Vibe) |
| Process model | **client/server**: a Node WS server wraps the agent; UI is a web app over WebSocket | **Electron IPC**: main wraps the agent; renderer over preload bridge |
| Desktop | Electron spawns the server as a **child process**; `BrowserWindow` loads `http://localhost:port` | electron-vite main/preload/renderer, renderer loaded from file |
| State backbone | **Effect-TS** services/layers + Schema; **SQLite event-sourcing** (CQRS) | plain TS, renderer `useReducer`, no DB yet |
| Auth | **defers to each CLI's own `login`**; detects via probe on a 5-min poll | **in-app** browser sign-in (`browser-auth-delegated`) + `_auth/status`/`_auth/signOut` |

The headline structural difference: **t3code's "backend" is a real server**, not Electron main. The Electron
app is a thin process-manager + native bridge; the same server also powers the web and mobile clients. We
collapse that server into Electron main. Most of t3code's heaviest machinery (multi-environment connection
catalog, relay/SSH/Tailscale, multi-provider registry, event-sourcing) exists to serve that bigger surface.

---

## 1. Code structure

**Monorepo (`pnpm` + `vite-plus`, Node 24, Effect 4 beta):**

- `apps/server` (pkg `t3`) — the only backend. WebSocket RPC server, serves the built web app as static
  files, owns a **SQLite event store** (`@effect/sql-sqlite-bun`), spawns/manages agent subprocesses, does
  all provider protocol work. Entry `apps/server/src/bin.ts` (Effect CLI: `start`/`serve`/`auth`/`project`/`connect`).
- `apps/web` (pkg `@t3tools/web`) — React 19 + Vite SPA. All UI. Connects to the server over WebSocket.
- `apps/desktop` (pkg `@t3tools/desktop`) — Electron 41 wrapper. **Spawns `t3` server as a child process**,
  opens a `BrowserWindow` at `http://127.0.0.1:<port>`. Does **not** embed the server.
- `apps/mobile` — Expo/React Native, reuses `client-runtime`.
- `packages/contracts` (`@t3tools/contracts`) — **Schema-only, zero runtime logic, no barrel**. Effect Schema
  for provider events, WS protocol, model/session types. Both server and clients import from here.
- `packages/shared` — runtime utils, **35+ explicit subpath exports** (`@t3tools/shared/git`, `/shell`, …), no barrel.
- `packages/client-runtime` — shared client code (web+mobile): connection lifecycle, RPC, state atoms.
- `packages/effect-acp` — **Effect-TS wrapper of ACP** (`AcpClient` host-side, `AcpAgent` agent-side). Schema
  generated from the ACP OpenAPI spec. Exports `./client`, `./agent`, `./schema`, `./rpc`, `./protocol`, `./terminal`.
- `packages/effect-codex-app-server` — same idea for Codex's proprietary app-server JSON-RPC.
- `packages/ssh`, `packages/tailscale` — remote-server connectivity (desktop only).

**The provider abstraction (how one UI drives many agents):** a two-level identity in
`packages/contracts/src/providerInstance.ts` — `ProviderDriverKind` (which implementation: `"codex"`,
`"claudeAgent"`, `"cursor"`, `"grok"`, `"opencode"`; an **open** brand so unknown forks parse gracefully)
vs. `ProviderInstanceId` (a user-defined routing key; threads reference *this*, allowing `codex_personal`
vs `codex_work`). Each driver implements one SPI:

- `ProviderDriver` (`apps/server/src/provider/ProviderDriver.ts`) — `driverKind`, `configSchema`,
  `create()` → `ProviderInstance`. Drivers are **plain values**, not Effect services, so many instances coexist.
- `ProviderAdapterShape` (`apps/server/src/provider/Services/ProviderAdapter.ts`) — the common contract every
  agent implements: `startSession` / `sendTurn` / `interruptTurn` / `respondToRequest` / `respondToUserInput`
  / `stopSession` / `readThread` / `streamEvents: Stream<ProviderRuntimeEvent>`.
- Registered in `apps/server/src/provider/builtInDrivers.ts`. Each adapter wraps a different transport:
  Codex → `effect-codex-app-server`; **Cursor & Grok → `effect-acp`** (the ACP ones, closest to us); Claude →
  Anthropic Agent SDK; OpenCode → OpenCode SDK.

**Effect-TS is pervasive** — the whole app is a Layer DAG. Idioms a reader needs: `Context.Service` +
`Layer.effect` for every service; `Effect.gen(function*(){ yield* dep })`; `Stream` for event sources;
`PubSub` for fan-out; `Ref` for state; `Schema.TaggedErrorClass`/`Schema.brand`; `Cache`/`Schedule` for
polling. Powerful but a real learning curve.

> **For us:** `effect-acp` and the `ProviderAdapterShape` *surface* are worth studying. The `ProviderDriver`
> SPI, the instance registry, the `DriverKind`/`InstanceId` split, and the Effect machinery are **overkill** —
> we hardcode one agent. Our `WorkspaceAgent` already *is* a single-provider adapter.

---

## 2. Auth — they defer to the CLI; we're more capable

**t3code never triggers interactive sign-in.** For every provider it runs a lightweight **probe** on a
**5-minute poll, outside any active session**, and surfaces an actionable message if signed out:

- Codex: spawn `codex app-server`, JSON-RPC `account/read` → `account` populated? (`CodexProvider.ts:287,432`)
- Claude: Agent-SDK `query()` init probe, read `account.tokenSource`/`subscriptionType` (`ClaudeProvider.ts:548`)
- Cursor: `agent about --format json` → `userEmail`/`subscriptionTier` (`CursorProvider.ts:822`) → "Run `agent login`"
- OpenCode: count connected upstream providers (auth inferred, no login concept)

The result is a `ServerProviderAuth` snapshot: **`{ status: "authenticated" | "unauthenticated" | "unknown", email?, label?, type? }`** (`contracts/src/server.ts:53`), embedded in the per-provider `ServerProvider`
snapshot pushed over WS. The UI hardcodes the ACP `authMethodId` per provider and **ignores the advertised
`InitializeResponse.authMethods` list** — it does not drive a method-picker. **Credentials are never stored
by t3code**; each CLI owns its keychain/home dir (t3code only sets `HOME` to isolate instances).

**ACP specifics** (`packages/effect-acp`): `authenticate({ methodId })` → empty `{}` response (fire-and-forget;
the agent handles auth). The ACP schema reserves **error `-32000` = "Authentication required"**. There is **no
ACP-standard `_auth/status` / `_auth/signOut`** — those are Vibe extensions; t3code CLI-probes instead.

> **For us:** Validations and one borrow.
> - Our three-state `AuthState` (`signed-in`/`not-signed-in`/`unknown`) matches their `ServerProviderAuth.status`
>   exactly — **"unknown" means "can't tell yet," not "signed out"**; we already model this.
> - Our `-32000` classifier is corroborated by their ACP schema (`-32000` = auth required).
> - Hardcoding `browser-auth-delegated` and ignoring the advertised `authMethods` list is **exactly their
>   approach** — good, we're not missing a method-picker we should have built.
> - **Borrow:** their **probe-on-a-timer, decoupled from the session** is cleaner than our "detect once during
>   `start()`." A periodic `_auth/status` refresh would catch expiry without waiting for a turn to fail
>   (complements our mid-session `-32000` handling from #13).
> - We are **more capable** than t3code on auth: we built *in-app* `browser-auth-delegated` sign-in; they just
>   say "run `X login`." Don't regress to their model. Their `email`/`label`/`type` enrichment is something we
>   *can't* match (Vibe's `_auth/status` exposes no identity — confirmed in `docs/acp-capture.md` §8).

---

## 3. Threads / sessions — the model to (selectively) copy

**Thread vs. Session are distinct** (`contracts/src/orchestration.ts:271,344`): a **Thread** is the permanent,
user-visible record (title, messages, activities, checkpoints, model selection); an **OrchestrationSession**
is the ephemeral live runtime (`status: idle|starting|running|ready|interrupted|stopped|error`, `activeTurnId`,
`lastError`). The Session is rebuilt from SQLite on restart and embedded into the Thread snapshot. This mirrors
our own glossary (Thread = user-facing conversation; ACP session = protocol handle) — they just persist it.

**One process per session.** ACP is inherently 1:1 process↔session. `AcpSessionRuntime.ts` spawns the
subprocess; a `NotStarted | Starting{deferred} | Started` state machine shares one in-flight `Deferred` so
concurrent `start()` calls can't double-spawn (`:250`). **Resume** sends `session/load{sessionId,cwd,mcpServers}`
with a **`SessionLoadGate`** that suppresses replayed `session/update` during re-hydration, waiting for either
the RPC response **or a 2-second idle gap in replays**, whichever comes first (`:547`). Per-thread binding
(incl. the ACP `sessionId` as `resumeCursor`) is persisted in a SQLite `provider_session_runtime` row.

**WebSocket protocol — snapshot-then-stream** (`contracts/src/orchestration.ts:25`, `apps/server/src/ws.ts`):
`subscribeThread` emits `{kind:"snapshot", snapshot:{snapshotSequence, thread}}` first, then per-event diffs.
`replayEvents({fromSequenceExclusive})` lets a reconnecting client catch up. Commands (`dispatchCommand`) are
a closed set: `thread.turn.start/interrupt`, `thread.approval.respond`, `thread.user-input.respond`,
`thread.checkpoint.revert`, `thread.session.stop`, …

**Robustness (a stated core priority) — the techniques worth knowing:**

- **Global monotonic `sequence`** on every persisted event; client reports last-seen sequence on reconnect → server returns missed events.
- **Command idempotency:** every client command carries a `commandId`; a `command_receipts` table returns the stored result instead of re-executing (kills duplicate turns on reconnect).
- **Streaming buffer discipline:** `content.delta` accumulates per message; on `request.opened`/`user-input.requested` it **flushes buffered text first** so the user sees complete text before a pause.
- **Session recovery:** adopt in-memory session → else resume via persisted `resumeCursor` → else fresh; recoverable resume errors ("not found") fall back to a fresh start (`ProviderService.ts:355`, `CodexSessionRuntime.ts:421`).
- **Session reaper:** sweep every 5 min, stop sessions idle > 30 min, **never kill a thread with an active turn** (`ProviderSessionReaper.ts`).
- **Drainable workers** for graceful shutdown (flush in-flight events before scope close).

> **For us — adopt the model, skip the event-sourcing:** Keep **Thread (permanent) vs Session (ephemeral)**;
> persist the **ACP `sessionId` as a resume cursor** and `session/load` it on restart; spawn **one process per
> Thread**; use **snapshot-then-stream** when the renderer (re)connects; copy the **`session/load` idle-gap**
> trick and the **never-reap-an-active-turn** rule. The suggested minimal shape:
>
> ```
> Thread(id, title, createdAt, status, activeTurnId, lastError, resumeSessionId, lastSeenAt, sequence)
> Message(id, threadId, role, content, turnId, createdAt)
> Event(sequence AUTOINCREMENT, threadId, type, payload JSON, occurredAt)   -- optional but enables reconnect catch-up
> ```
>
> **Overkill for us:** the full **CQRS event store + projection pipeline** (it powers multi-thread branching,
> checkpoint/revert, plan flows), the **PubSub domain-event bus** (we have IPC), `worktreePath`/`branch`/git
> checkpoints, `interactionMode`/`runtimeMode` (unless Vibe exposes them). A single `session` row per Thread +
> an append-only message log is enough until we add history/persistence as a deliberate slice.

---

## 4. UI — patterns that survive shrinking to one provider

**`apps/web`:** React 19 + Vite, **TanStack Router** (file-based, code-gen `routeTree.gen.ts`). Shell:
`__root.tsx` → `CommandPalette > AppSidebarLayout > Outlet`; sidebar always mounted, content swaps. Routes:
`_chat.index` (new), `_chat.$environmentId.$threadId` (active), `_chat.draft.$draftId` (unsent), plus settings/pair.

**State — two systems, cleanly split:**
- **Effect atoms** (`@effect/atom-react`) for **server-synced** data. A WS subscription stream feeds a **pure
  reducer** `applyThreadDetailEvent(thread, event)` → `{kind:"updated"|"deleted"|"unchanged"}` whose result is
  written to a `SubscriptionRef`, which notifies atom subscribers (`packages/client-runtime/src/state/threadReducer.ts`).
- **Zustand** (some `persist`ed) for **ephemeral UI**: composer drafts, panel layout, terminal UI, selection.

**Conversation rendering** (`apps/web/src/components/chat/MessagesTimeline.tsx`): raw thread →
`deriveTimelineEntries` → `deriveMessagesTimelineRows` (groups tool calls, fold toggles, injects a "working"
sentinel) → **`useStableRows()` structural sharing** (recycle unchanged row object refs) → **`LegendList`**
virtualized list (`maintainVisibleContentPosition`, `anchoredEndSpace` keep the viewport pinned while text
streams in). Row kinds: user/assistant message, tool-call "work" group, turn-fold, proposed-plan, "working"
(a **live timer that mutates `textContent` directly to avoid per-second React commits**). Streaming = append
chunk to existing message in the reducer → ref update → re-render; assistant row shows a cursor while
`streaming`.

**Composer** (`ChatComposer.tsx`, Lexical-based): `/ @ ##` trigger parsing (`detectComposerTrigger`),
optimistic send (`LocalDispatchSnapshot` shows the message immediately, clears on server ack), and an
**approval mode** — when a permission request is pending, the textarea is replaced by Approve/Decline that
dispatch `respondToThreadApproval`. Interrupt button while running.

**Styling:** Tailwind v4 + **Base UI** (headless, not Radix/shadcn) wrapped with `cva`; semantic CSS-variable
tokens via `@theme inline`, `.dark` variant, `data-slot` attributes, `lucide-react` icons.

> **For us — adopt the patterns, not the stack:**
> - The **pure `event → {updated|deleted|unchanged}` reducer feeding a subscribable ref** is exactly our
>   `src/renderer/src/conversation/reducer.ts` shape — validates our design and shows how to scale it.
> - **`useStableRows` structural sharing** + a virtualized list (LegendList) + the **`textContent` live-timer
>   trick** are cheap wins when streaming gets fast.
> - **Optimistic send with a local snapshot cleared on ack**, and **composer "approval mode"** for permission
>   prompts, map directly onto our permission flow.
> - **Zustand for UI state / reducer(atoms) for server state** is a clean split worth keeping as we grow.
> - **Overkill:** multi-environment `environmentId` scoping on every atom, the 7-level provider-instance model
>   picker, draft→server "promotion," DnD-sortable threads, and the full Effect-atom runtime. A plain
>   `useReducer` + a WS/IPC `useEffect` (what we have) is fine; reach for Lexical only if we need rich mention chips.

---

## 5. Shortlist — what to actually take

**High value, low cost (do when the need arises):**
1. Read `packages/effect-acp` + `apps/server/src/provider/acp/{AcpSessionRuntime,AcpCoreRuntimeEvents}.ts`
   before any rework of our ACP layer — especially the **`session/update` → typed-event normalization** and the
   **`session/load` resume + idle-gap** logic.
2. **Persist the ACP `sessionId` as a resume cursor**; `session/load` on restart instead of starting fresh.
3. **Snapshot-then-stream** + **global `sequence`** + **`commandId` idempotency** when we add persistence/reconnect.
4. **Never reap a Thread with an active turn**; **flush buffered text before a permission pause**.
5. **Probe `_auth/status` on a timer**, decoupled from `start()` (complements #13's mid-session `-32000`).
6. UI: **structural-sharing rows**, **virtualized timeline**, **optimistic send**, **composer approval mode**.

**Deliberately not adopting (too big for one agent):** the provider driver/instance registry, CQRS
event-sourcing + projection pipeline, multi-environment connection catalog, relay/SSH/Tailscale, Clerk
cloud auth, and the server-as-subprocess desktop topology (our Electron-IPC model is simpler and correct for us).

**Decision we already got right, confirmed by t3code:** delegate auth/credentials entirely to the agent binary
(ADR-0003); model auth as a 3-state value; classify unauthenticated on code `-32000`; hardcode the ACP auth
method. We even go further than t3code with in-app `browser-auth-delegated` sign-in.
