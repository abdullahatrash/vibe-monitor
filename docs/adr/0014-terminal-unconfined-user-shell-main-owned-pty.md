# Terminal: an unconfined user shell on a main-owned PTY, per Workspace

**Status: ACCEPTED** (2026-07-02). Builds on **ADR-0002** (thin orchestrator), **ADR-0004** (the
CLI-parity posture this extends to a shell), **ADR-0006** (warm-agent pool — whose lifetime this is
explicitly INDEPENDENT of), **ADR-0013** (the Surface/tab model the Terminal Surface slots into).
Terms: `CONTEXT.md` **Terminal session**. Reference implementation: t3code's `TerminalManager` +
`ThreadTerminalDrawer` (server-owned PTY behind an attach-stream; the UI a disposable view).

## Context

CodexMonitor parity reserves a Terminal card in the side panel (#187/#193 shipped it inert). t3code —
our UI north star — ships the target shape: xterm.js as a thin, reconnectable view; the PTY process,
its scrollback, and its lifetime owned by their backend server; plain UTF-8 strings over the wire;
client-chosen session ids. We have no server process — the Electron main process IS our backend — and
our side panel is per-Workspace (t3code's is per-Thread; our Threads share the working tree).

## Decision

1. **Main owns the PTY.** A `TerminalManager` in `src/main/terminal/` spawns and supervises shell
   sessions via **node-pty** (`^1.1.0`); the renderer's xterm.js view is DISPOSABLE and drives the
   session over four invokes (`terminal:open/write/resize/close`) plus one streamed `terminal:event`
   channel tagged `{workspaceId, terminalId}` — the `acp:event` pattern. Output is UTF-8 strings
   (no base64), writes capped at 64 KiB, cols/rows clamped.

2. **A FULL, UNCONFINED user shell — deliberately.** CLI parity: the same shell, env, and reach the
   user has in their own terminal (they could run anything there anyway; t3code ships the same
   posture). This is the OPPOSITE of the confined `files:*` reads (ADR-0013) and that contrast is
   intentional: Files is an agent-adjacent read surface consumed programmatically; the Terminal is
   the USER acting as themselves. The safety boundary is ADDRESSING, not confinement:
   `terminal:open` is `agentId`-addressed (#188 F3 model) — the cwd resolves main-side from
   `pool.get(agentId).workspaceDir`, never from a renderer-supplied path — so the renderer can only
   open a shell in a CONNECTED Workspace. Env = the login-shell probe (`shell-env.ts`) minus a small
   BLOCKLIST (Electron/dev plumbing; deliberately not an allowlist so PATH/toolchains survive).
   Shell = `$SHELL` with zsh/bash/sh fallbacks, not `-l` (the env already came from a login probe).

3. **Per-Workspace sessions, independent of the warm agent.** One session per Workspace this slice
   (id `term-1`, client-chosen — t3code's convention; the event shape already carries `terminalId`
   so multi-terminal tabs are additive). Pool eviction must NEVER kill a shell — the user's
   long-running process outlives our LRU policy. A session dies only on: its tab's explicit close
   (the × — SIGTERM, then SIGKILL after 1s), Workspace removal, window-all-closed, or app quit.

4. **The view reattaches; the session buffers.** Tab switches and panel closes unmount xterm; the
   manager retains a capped in-memory scrollback (~2 MB, line-boundary trimmed) and `terminal:open`
   is open-OR-REATTACH — a live session replies with its snapshot for replay. No disk persistence
   (a shell is ephemeral; t3code's history files are deferred with the rest of slice-2+ polish).
   An exited session keeps its buffer + banner until the tab closes or reopens (fresh spawn).

5. **Packaging: no rebuild.** node-pty 1.x is N-API/ABI-stable — no `electron-rebuild`, no
   postinstall (verified in t3code's own manifest and comments). node-pty is imported ONLY in the
   registrar (`register-ipc.ts`); the manager takes it through an injected `spawnPty` seam, keeping
   the native module out of the unit-test import graph.

## Consequences

- The renderer never touches a process API; the preload stays a typed pass-through (ADR-0002 intact:
  the shell is OUR feature, not an agent capability — vibe-acp is uninvolved).
- A terminal open does NOT count as agent activity (`pool.touch` is not called): an open shell never
  pins a warm agent, and an evicted agent leaves the shell running. Only `terminal:open` needs the
  agent (for the cwd); a session whose agent was later evicted keeps working — write/resize/close
  address the session, not the agent.
- Deferred to later slices, recorded here so they're choices not gaps: multiple terminals per
  Workspace (slice 3), link provider / selection-to-composer / live re-theme (slice 4), splits,
  disk-persisted history, subprocess-name tab labels, Windows/conpty + WSL.

## Slice 2 — Clear + Restart affordances

A toolbar on the Terminal Surface adds two request/response invokes (no event-stream change — single
window). **Clear** (`terminal:clear`) wipes main's retained scrollback so a later reattach starts
blank, and the renderer clears its own xterm; the shell keeps running. **Restart** (`terminal:restart`)
kills the shell (the same SIGTERM→SIGKILL escalation) and spawns a fresh one in the SAME cwd — stored
on the session at open, so restart needs no agent and works after eviction; it revives an exited
session too. The map entry is replaced by the fresh session BEFORE the old shell is killed, so the
existing session-identity guard suppresses the dying shell's late output.

Output **coalescing / sequence-numbered attach** (t3code has both) is deliberately NOT ported: our
reattach replays the full scrollback snapshot then streams live, so there is no delta to reconcile and
no gap to sequence — and per-chunk emit rendered real shell output (including a build log) without
jank in slice 1. Revisit only if profiling shows IPC churn under sustained high-throughput output.
