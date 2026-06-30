# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

vibe-mistro is a desktop app (Electron + React 19 + TypeScript, Bun-managed) that orchestrates
multiple **Mistral Vibe** coding agents across local projects. It is a **thin orchestrator**: it
drives an external agent (`vibe-acp`) over the **Agent Client Protocol (ACP)** — JSON-RPC 2.0 over
stdio — and renders its output. The model loop, tool selection, and code intelligence belong to
Vibe; we spawn/supervise the agent, send prompts, render streamed tool-call output, serve its
file I/O, and answer its permission requests. **Never reimplement agent capabilities here** (no
language servers, no embedded model). See `docs/adr/0002`.

Status: early scaffold, built one tracer-bullet vertical slice at a time (commits/PRs reference
issue numbers and "TB" slice numbers). Features are ported from CodexMonitor.

## Commands

```bash
bun install
bun run dev         # launch Electron + Vite dev server
bun run typecheck   # tsc --noEmit over BOTH tsconfig.node.json (main/preload) and tsconfig.web.json (renderer)
bun run build       # production build (electron-vite)
bun run lint        # eslint .
bun run test        # vitest run (one-shot)
bun run test:watch  # vitest watch
```

Run a single test file or test:

```bash
bunx vitest run src/main/agent-pool.test.ts
bunx vitest run -t "evicts the least-recently-active"
```

Tests are colocated as `*.test.ts` next to the code they cover and run in the `node` environment
(no jsdom — renderer logic is tested as pure modules, not via DOM rendering). After non-trivial
changes, run `bun run typecheck` (the two-project split means a renderer-only error won't surface
from a main-process type-check, and vice-versa).

Environment note: node lives ONLY on nvm — prepend it (and `~/.local/bin`, where the `vibe-acp`/`uv`
entrypoint lives) to PATH in every shell command:
`export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.local/bin:$PATH"`. Don't rely on `Bun.*`
runtime APIs in shipped main-process code — Electron runs its own Node at runtime, Bun is only the
package manager/test runner.

Gates before any slice is considered done (run all four):
`bun run lint && bun run typecheck && bun run build && bun run test`.

Bun `child_process` gotcha: Bun 1.3.8's `node:child_process` does NOT deliver `stdin.write()` to a
piped child, so any **standalone script** that pipes into `vibe-acp` must be bundled to a node target
and run under node, not bun:
`bun build scripts/x.ts --target=node --outfile=/tmp/x.mjs && node /tmp/x.mjs`. The Electron app
itself is unaffected (it uses its own Node).

## Process boundary

Three Electron layers, strictly separated (`docs/conventions.md`):

- **`src/main`** — all Node/OS/process work: spawn & supervise `vibe-acp`, ACP transport,
  persistence, fs serving, shell-env, eviction policy. This is CodexMonitor's Rust backend, in TS.
- **`src/preload`** — typed `contextBridge` only. Exposes one `VibeMistroApi`. No logic.
- **`src/renderer`** — UI only, **no Node, no `fs`** — everything via IPC. `contextIsolation: true`,
  `nodeIntegration: false`.

The single typed IPC contract (channel names + payload types) lives in **`src/shared/ipc.ts`** and
must stay free of Node/DOM imports so both sides import it. Three shapes: `invoke` (request/response),
`send` (fire-and-forget), `on`+unsubscribe (streaming). All ACP events stream over the **one**
`acp:event` channel, tagged by `agentId`. Never add stringly-typed channels in feature code.

## Domain language (use these exact terms — see `CONTEXT.md`)

- **Workspace** — a local project directory + its single `vibe-acp` process. (Not "project/folder/repo".)
- **Thread** — a user-facing conversation in a Workspace; our own durable concept (own `threadId`,
  title, persistence). Maps 1:1 to an ACP session but is distinct from it. A Workspace has many Threads.
- **ACP session** — the protocol handle from `session/new`, addressed by `session/*`. Lives only in
  main/protocol layer; **never surfaced in the UI**. One `vibe-acp` process hosts many.
- **Permission request** — an agent-initiated `request_permission` to do something sensitive mid-turn;
  the agent blocks until the user answers. Queued and answered by JSON-RPC **request id**. Reserve the
  word "prompt" for the user's message to the agent.

- **Agent controls** — a Thread's **Mode** (approval posture: default/plan/accept-edits/auto-approve/chat),
  **Model**, and **Reasoning effort**, surfaced from `session/new` and changed via `session/set_mode` /
  `set_model` / `set_config_option`. Sticky per-Thread; Vibe-owned/display-from-session-state (`docs/adr/0007`).

The renderer owns canonical conversation state; main forwards raw ACP `session/update` without
interpreting it (`docs/adr/0001`).

## Key architecture (the parts that span multiple files)

**Warm-agent pool** (`src/main/agent-pool.ts`, `src/main/index.ts`, `docs/adr/0006`). One
`WorkspaceAgent` (= one `vibe-acp` child) per OPEN Workspace, lazily spawned on first select and kept
warm. The renderer addresses an agent by a pool-minted `agentId` handle; `pool.get(agentId)` resolves
it. The pool is bounded — idle-evict (`IDLE_EVICT_MS`), LRU cap (`MAX_WARM_AGENTS`), periodic sweep —
but the selected, mid-turn, or mid-sign-in agent is **protected** from eviction. The protection
predicate is the *pure* `isProtected` in `agent-protection.ts` (unit-tested there); `index.ts` just
feeds it live state (`activeAgentId`, `inFlightTurns`, `signingInAgents`). When an agent is evicted,
the renderer is told (`agent:evicted`) and re-warms it lazily on next select — history survives in our
store, so re-warming is transparent.

**Thread binding & resume** (`src/main/thread-binding.ts`). A Thread starts as a renderer-only draft
(no `sessionId`). Its **first prompt** binds it: a draft mints a session via `session/new`; a reopened
Thread whose stored session isn't hosted by the fresh agent resumes via `session/load` (re-binding
fresh on a resume failure, surfacing a "context reset" notice). `index.ts` signals the renderer via
`thread:bound` the instant a session is minted, before any event streams.

**Persistence** (`src/main/persistence/`, `docs/adr/0005`). Split three ways by owner: (1) Workspace +
Thread **metadata** — ours, small — in `MetadataStore` (single-writer JSON index at
`userData/metadata.json`); (2) a per-Thread **JSONL transcript** we own (`TranscriptStore` under
`userData/transcripts/`), teed best-effort from main's conversation inputs, replayed on reopen with NO
agent spawned; (3) agent **context/history** — Vibe owns it. The cold launch list and process-free
reopen are both served from our stores alone. **Every persistence write is best-effort and must never
reject the live flow** — on a store failure, synthesize ids and continue.

**Per-Thread live status** (`src/main/thread-status.ts`). Single source of truth for the sidebar's
`streaming` / `needsAttention` indicators, keyed by durable `threadId` (distinct from `inFlightTurns`,
which is per-agent for eviction). Pushed to the renderer via the `thread:status` channel on every
change; `getThreadStatuses` re-seeds a window that mounts mid-turn.

**fs serving** (`src/main/acp/fs-read.ts`, `fs-write.ts`, `docs/adr/0004`). We serve the agent's
`fs/read_text_file` / `fs/write_text_file`. **Asymmetric policy**: reads are UNCONFINED (CLI parity);
writes are CONFINED to the Workspace and symlink-resolved.

**Auth** (`src/main/auth/`, `docs/adr/0003`). Delegated entirely to Vibe — we never store
credentials. Detect via `_auth/status` (NOT `initialize`). Sign-in is the `browser-auth-delegated`
method: open the returned `signInUrl` in the system browser. A mid-session JSON-RPC **-32000** is
treated as expiry → route to sign-in, keep the agent alive.

**ACP transport** (`src/main/acp/client.ts`). One `AcpClient` per child handles JSON-RPC framing +
correlation. Treat the `initialize` response as readiness; race start against early child exit so a
failed spawn rejects instead of hanging; graceful stop with a kill timeout. Always spawn/detect with
the resolved shell-env PATH (`src/main/shell-env.ts`), since `vibe`/`vibe-acp` are found there.

## Renderer architecture

Feature-Sliced under `src/renderer/src/` (`shell/`, `connection/`, `conversation/`, `auth/`). The
persistent two-pane shell (`shell/Shell.tsx`) keeps the sidebar mounted and swaps a conversation
outlet. Navigation is a **pure reducer** (`shell/nav-reducer.ts`); the per-Workspace connection
registry lives in `App`. Conversation state is a reducer of typed items keyed by Thread
(`conversation/reducer.ts`); an event-router (`conversation/event-routing.ts`) subscribes once to
`acp:event`, switches on the ACP method, and dispatches typed actions. Reopen replays the JSONL
transcript through the same reducer (`conversation/replay.ts`). Renderer-only UI state (drafts, panel
sizes, scroll) stays in `localStorage`; durable state goes through IPC.

## Conventions

- Files `kebab-case`; functions verb-prefixed (`spawnSession`, `registerIpc`); constants
  `SCREAMING_SNAKE`; **named exports only**. `strict` TS, no unused locals/params (enforced).
- IPC handlers are registered in `registerIpc()` in `src/main/index.ts`; keep load-bearing logic in
  small pure modules (with their own `*.test.ts`) and keep the handler a thin wrapper — this is the
  established pattern (e.g. `runPromptTurn`, `isProtected`, `ensureBoundSession`).
- Log, don't swallow — surface failures to the renderer even when a flow is best-effort.
- ACP param field names: verify against the live `vibe-acp` binary as each method is implemented;
  don't hardcode unverified shapes. Protocol reference: `docs/vibe-acp-protocol.md`, `docs/acp-capture.md`.

## Reference docs

`docs/conventions.md` (decisions; wins on conflict), `docs/adr/` (0001–0007, the load-bearing
architecture decisions; 0007 = Agent controls), `CONTEXT.md` (domain glossary), `HANDOFF.md` (latest
session handoff / current state), `docs/acp-capture.md` (verbatim `vibe-acp` protocol capture — the
backend contract), `docs/codexmonitor-reference.md` (the app being ported + build order).
