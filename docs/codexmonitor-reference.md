# CodexMonitor reference

CodexMonitor (`/Users/abdullahatrash/mistral/CodexMonitor`) is a Tauri app: **React/TypeScript
frontend** in `src/`, **Rust backend** in `src-tauri/src/`. It orchestrates `codex app-server`
processes. This doc is our feature roadmap source + a map of how each piece is built, so we can
re-implement the *concept* in Electron/TS.

> **Translation rule of thumb:** their React `src/` mostly carries over (patterns, not files);
> their Rust `src-tauri/` becomes our Electron **main process** (`src/main`). Tauri `invoke()` +
> `emit()` becomes Electron `ipcMain.handle()` + `webContents.send()`.

---

## 1. Complete feature inventory

### Workspaces & threads
- Create/list/add/rename/remove workspaces, persisted to `workspaces.json`.
- Worktrees & clones — isolated working copies under a `worktrees/<id>` folder, with git setup.
- Threads: start, resume, fork, compact, archive, rename — one set per workspace.
- Thread state: active thread, processing/running, unread, review mode, processing duration.
- Per-thread message drafts (localStorage), cursor-paginated thread lists with sort (recent/alpha).

### Composer & agent controls
- Image attachments: picker, drag/drop, paste (HEIC/HEIF converted via `/usr/bin/sips` on macOS).
- Follow-up behavior while a run is active: **Queue** vs **Steer** (with a per-message override key).
- Autocomplete: skills (`$`), prompts (`/prompts:`), reviews (`/review`), file paths (`@`).
- Model picker, collaboration modes, reasoning effort, access mode, service tier (`/fast`).
- Context-usage ring (token utilization).

### Git & GitHub
- Diff stats, staged/unstaged diffs, stage/unstage/revert (file + all), commit log w/ ahead-behind.
- Branch list, checkout, create; multi-repo root discovery.
- GitHub via `gh`: issue list, PR list/diff/comments; "Ask PR" injects PR context into a new thread.
- Init repo + create GitHub repo flows.

### Files & prompts
- File tree with search, type icons, "Reveal in Finder/Explorer", drag-to-composer.
- Prompt library: global (`~/.codex/prompts`) + per-workspace, `.md` with frontmatter;
  create/edit/delete/move, run in current/new thread.

### UI & experience
- Resizable sidebar/right/plan/terminal/debug panels, sizes persisted in localStorage.
- Responsive desktop/tablet/phone layouts.
- Usage/credits meter, in-app updates (toast-driven), sound notifications.
- macOS overlay title bar + vibrancy, reduced-transparency toggle.
- Debug panel (log/event inspector), system tray (recent threads, quick actions).

### Dictation, terminal, remote
- Dictation: hold-to-talk, live waveform, Whisper model download/cache/remove.
- Terminal dock: multiple PTY tabs per workspace, streamed output (experimental).
- Remote backend: optional daemon (TCP/JSON-RPC over Tailnet) — `codex-monitor-daemon` +
  `codex-monitor-daemonctl` binaries, token auth, reconnect logic. (Lowest priority for us.)

---

## 2. How the Codex backend is driven (→ our main process)

**Spawn** (`src-tauri/src/backend/app_server.rs`): one `codex app-server` per workspace via
`tokio::process::Command`, stdio piped. Binary resolved from settings or PATH; `build_codex_path_env()`
enriches PATH with homebrew/`~/.cargo/bin`/`~/.bun/bin`/nvm. **(We solve the same PATH problem with
`shell-env.ts`, already implemented.)**

**Handshake:** first message is an `initialize` request with `clientInfo` + `capabilities`.

**Protocol:** line-delimited JSON-RPC 2.0 over stdio — requests `{id, method, params}`, responses
`{id, result|error}`, and server→client notifications `{method, params}`. (Identical shape to our
`AcpClient`; only method names differ — see [vibe-acp-protocol.md](./vibe-acp-protocol.md).)

**Outgoing requests** (Codex names, for comparison): `thread/start|resume|fork|list|archive|
compact/start|name/set|read`, `turn/start|steer|interrupt`, `review/start`, `account/*`,
`model/list`, `skills/list`, `collaborationMode/list`, `mcpServerStatus/list`.

**Streamed notifications** drive the conversation UI: `thread/*` (started/closed/status/tokenUsage),
`turn/*` (started/completed/plan/diff), `item/*` (started/completed + deltas:
`agentMessage/delta`, `reasoning/*Delta`, `commandExecution/outputDelta`, `fileChange/outputDelta`),
and approval requests (`item/commandExecution/requestApproval`, `item/permissions/requestApproval`).

**Lifecycle:** sessions held in a `HashMap<workspaceId, WorkspaceSession>`; a stdout reader loop
parses lines, extracts thread/workspace IDs, and forwards each as an `AppServerEvent{workspace_id,
message}` Tauri event. On exit, child process trees are killed.

→ **Our equivalent:** `Map<sessionId, AcpClient>` in `src/main`, each `AcpClient` (already built)
spawns `vibe-acp`, frames JSON-RPC, correlates by id, and re-emits notifications. The main process
forwards them to the renderer over a single streaming IPC channel.

---

## 3. State & IPC (→ Electron IPC)

- **Command surface:** ~300 Tauri commands registered in `src-tauri/src/lib.rs`, each wrapped in a
  typed async fn in `src/services/tauri.ts`. → We mirror this with a typed preload API
  (see opencode patterns) and `ipcMain.handle` handlers.
- **Events:** an **event hub** (`src/services/events.ts`) lazily starts a Tauri `listen()` on first
  subscriber and stops on last — worth copying for our streaming `acp:event` channel.
- **Thread state:** a reducer (`src/features/threads/hooks/useThreadsReducer.ts`) split into slices
  (items, lifecycle, config, queue, snapshots). Big `ThreadState` keyed by workspace/thread:
  `itemsByThread`, `threadsByWorkspace`, `threadStatusById`, `activeTurnIdByThread`,
  `turnDiffByThread`, `approvals`, `tokenUsageByThread`, etc. → **Adopt this reducer shape directly**
  (it's framework-portable React).

---

## 4. Persistence

- App-data dir via Tauri (`~/.local/share/com.anthropic.CodexMonitor/` etc.).
- `workspaces.json` — array of workspace entries (id, name, path, parentId, kind, settings incl.
  worktrees folder, git root, launch scripts).
- `settings.json` — app settings (backend mode, binary path, default model/effort, theme,
  follow-up behavior, remote backend, …). Normalized/migrated on load.
- **localStorage** for UI state: panel sizes, drafts (`threadDrafts:<ws>:<thread>`), scroll
  positions, expanded/collapsed item state.

→ **Our equivalent:** `electron-store` for `workspaces`/`settings` (in main, exposed via IPC),
renderer `localStorage` for pure-UI state. See [opencode-electron-patterns.md](./opencode-electron-patterns.md#persistence).

---

## 5. Threads & session model (the data shapes to reuse)

`ThreadSummary`: `{ id, name, updatedAt, createdAt?, modelId?, effort?, isArchived?, isProcessing?,
hasUnread?, isSubagent?, subagentNickname?, subagentRole? }`.

`ConversationItem` (union by kind): `message` (user/assistant + images), `reasoning`, `tool`
(command/fileChange/mcp with status/output/duration), `diff`, `review`, `explore`, `userInput`,
`contextCompaction`.

Lifecycle: create → resume (loads history) → `turn/start` streams `turn/started` →
`item/started` → `item/*Delta` → `item/completed` → `turn/completed`. Fork branches history;
archive/compact as named. → **Reuse these types nearly verbatim**, renaming Codex methods to ACP.

---

## 6. Git/GitHub (→ Node)

Hybrid in CodexMonitor: `git2` (native) for reads/diffs, shell `git`/`gh` for writes/remotes/auth
(`src-tauri/src/shared/git_ui_core/`). → **Ours:** shell out to `git` and `gh` via `child_process`
from main (auth & SSH "just work"); optionally `simple-git` for reads. Same command set:
status/diff/log/branch/stage/commit/push/pull/fetch, `gh issue list`, `gh pr list|diff|view`.

---

## 7. Frontend structure (copy this organization)

**Feature-Sliced Design.** Each feature owns `components/`, `hooks/`, `utils/`, `types.ts`; no
cross-slice imports except via `src/types.ts` and `src/services/`.

```
src/
  App.tsx, types.ts
  services/   tauri.ts (→ ipc.ts), events.ts, toasts.ts
  utils/      threadItems.*.ts (item normalization/conversion/merge)
  features/
    app/        bootstrap + orchestration + useAppServerEvents (event router)
    threads/    useThreadsReducer + slices, event handler hooks, useQueuedSend
    composer/   Composer + image/autocomplete/model-picker hooks
    messages/   Messages + MessageRows (per-kind renderers), view state
    git/ terminal/ dictation/ settings/ prompts/ files/ workspaces/
    layout/     ResizableLayout (+ persisted sizes)
    home/ plan/ models/ collaboration/ skills/ notifications/ update/ debug/ shared/
```

Key patterns to emulate:
- **Event router hook** (`useAppServerEvents`): subscribe once, `switch(method)` → typed handlers.
- **Reducer slices**: immutable upsert of items by id within `itemsByThread[threadId]`.
- **Hook composition**: `useThreads()` = reducer + event subscription + handlers.
- **Optimistic processing flag**: set on send, cleared on `turn/completed`.
- **Per-kind row renderers** with expand/collapse, tool grouping, copy/quote, diff viewer.

---

## 8. Suggested build order for vibe-monitor

Backbone first; everything hangs off the conversation loop.

1. **ACP handshake + single conversation** — `initialize` → `session/new` → `session/prompt`,
   stream `session/update` into a `Messages` view. (Port `ConversationItem` + reducer.)
2. **Tool-call approval prompts** — handle `request_permission` (allow/reject options).
3. **Workspaces sidebar + persistence** — `electron-store`, one `AcpClient` per workspace cwd.
4. **Multiple threads/agents** — resume via `session/load`, unread/running state.
5. **Composer extras** — images, queue/steer, `$`/`/`/`@` autocomplete, model/effort/mode pickers.
6. **Git + GitHub panel** — shell `git`/`gh`.
7. **File tree + prompt library.**
8. **Terminal dock** — `node-pty` + xterm.
9. **Settings, usage meter, in-app updates** — `electron-updater`, `electron-log`.
10. **Remote backend** — defer.
