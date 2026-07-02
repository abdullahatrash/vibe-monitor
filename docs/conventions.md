# vibe-mistro conventions

Our decisions, synthesized from the three references. When they disagree, this doc wins.

## Scope boundary

vibe-mistro is a **thin orchestrator** over an external agent (`vibe-acp`). The model loop, tool
selection, and code intelligence (LSP-style lookups, search, edits) belong to **Vibe** — we render
its tool-call output, we don't reimplement it. No language servers, no embedded model. This is the
structural difference from opencode (which *is* the agent). See
[adr/0002](./adr/0002-thin-orchestrator-boundary.md).

## Stack

- **Electron + electron-vite**, main/preload/renderer split. **React 19 + TypeScript** in the
  renderer. **Bun** for package management + tooling (Electron runs its own Node at runtime — don't
  rely on `Bun.*` APIs in shipped main-process code).
- `node` for native install steps comes from nvm (`~/.nvm/versions/node/v22.22.1/bin`); prepend to
  PATH for `bun install`/`bun run build` in this environment.

## Process responsibilities

- **main** (`src/main`) — all Node/OS/process work: spawn & supervise `vibe-acp`, ACP transport,
  persistence, git/gh, fs, shell-env. This is CodexMonitor's Rust backend, in TS.
- **preload** (`src/preload`) — typed bridge only. Exposes one `VibeMistroApi` via `contextBridge`.
- **renderer** (`src/renderer`) — UI only, no Node. Feature-Sliced Design (below).

Security: `contextIsolation: true`, `nodeIntegration: false`, sandbox where feasible, no `fs` in the
renderer — everything through IPC.

## IPC (from opencode)

- **One typed contract.** Channel names + payload types live in `src/shared/ipc/` — domain modules
  behind one barrel, so both sides import `shared/ipc` — feeding the single `VibeMistroApi`
  interface. No stringly-typed channels in feature code.
- Three shapes: `invoke` (request/response), `send` (fire-and-forget), `on`+unsubscribe (streaming).
- **Subscriptions always return an unsubscribe fn**; clean up on `webContents` destroyed + app quit.
- When handlers multiply, register them via `registerIpc(deps)` **dependency injection** (testable).
- Stream all ACP events over the single `acp:event` channel, tagged by `sessionId`.

## Backend management (from opencode, adapted to stdio)

- One `AcpClient` (= one `vibe-acp` child) per workspace session, held in `Map<sessionId, AcpClient>`.
- Treat the `initialize` response as the **readiness signal**; **race start against early exit** so a
  failed spawn rejects instead of hanging; **graceful stop with a kill-timeout**; **serialize child
  errors** to the renderer.
- Always spawn/detect with the resolved **shell-env** PATH (`src/main/shell-env.ts`).

## Persistence

- `electron-store`, **lazy-created** in a `Map`, **after** `app.setPath('userData', …)`. Separate
  stores per domain (`settings`, `workspaces`). Key constants in one place — no inline strings.
- Renderer-only UI state (panel sizes, drafts, scroll, expand/collapse) stays in `localStorage`,
  keyed like CodexMonitor (`threadDrafts:<ws>:<thread>`, etc.).
- Expose store access over IPC; renderer never touches disk directly.

## Renderer architecture (from CodexMonitor)

- **Feature-Sliced Design.** Each feature owns `components/`, `hooks/`, `utils/`, `types.ts`. No
  cross-slice imports except via `src/renderer/src/types.ts` and a `services/` layer.
- **Thread state = a reducer with slices** (items, lifecycle, config, queue). Keyed by
  workspace/thread. Reuse CodexMonitor's `ThreadState`/`ConversationItem`/`ThreadSummary` shapes,
  renaming Codex methods to ACP.
- **Event router hook**: subscribe once to `acp:event`, `switch` on the ACP method, dispatch typed
  reducer actions. Optimistic processing flag set on send, cleared on turn completion.
- **Per-kind row renderers** for the conversation (message/reasoning/tool/diff/permission/…).

## ACP specifics

- Methods/flow in [vibe-acp-protocol.md](./vibe-acp-protocol.md). Verify exact param field names
  against the live `vibe-acp` binary as each method is implemented; don't hardcode unverified shapes.
- Map `session/update` notifications → conversation items; `request_permission` → approval UI.

## Git/GitHub

- Shell out to `git` and `gh` from main via `child_process` (auth/SSH work out of the box); optional
  `simple-git` for reads. Same command surface as CodexMonitor.

## Naming & style

- Files `kebab-case`; functions verb-prefixed (`spawnSession`, `registerIpc`); constants
  `SCREAMING_SNAKE`; **named exports**. `strict` TS, no unused locals/params (already enforced).
- **Log, don't swallow.** Add `electron-log` at the logging milestone; until then `console` in main
  is fine but surface failures to the renderer.

## Roadmap

The build order lives in [codexmonitor-reference.md](./codexmonitor-reference.md#8-suggested-build-order-for-vibe-mistro)
and the repo `README.md`. Next up: **slice #1 — ACP handshake + single conversation.**
