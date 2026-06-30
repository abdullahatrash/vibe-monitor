# vibe-mistro — Agent Handoff

> You are picking up an in-flight project. Read this top to bottom once, then keep it open.
> It tells you **what this is**, **how we work**, **what exists**, **what's next**, and **where the
> authoritative information lives** (in-repo docs + three local reference repos). Last updated
> 2026-06-30, `main` @ `85e95ef`, **288 tests**, **2 open issues (#60, #61)**.

---

## 0. TL;DR

- **What:** `vibe-mistro` — an Electron + TypeScript + React 19 + Bun **desktop app** that orchestrates
  the **Mistral Vibe** coding agent over **ACP** (Agent Client Protocol — JSON-RPC 2.0 over stdio).
  It's a GUI "monitor/orchestrator" for Vibe, modeled on **CodexMonitor** (which does the same for Codex).
- **Where:** `/Users/abdullahatrash/mistral/vibe-mistro` (repo, dir, and package all named `vibe-mistro`).
  GitHub: `https://github.com/abdullahatrash/vibe-mistro` (owner `abdullahatrash`, host `github.com`).
- **State:** MVP works end-to-end (open project → prompt → streamed reasoning → tool calls with approval).
  Auth, fs-hardening, a full **persistence epic**, and a full **UI/layout-shell epic** are all merged.
  Backlog is **one issue: #60** (message-level composer drafts). Then a deferred roadmap (see §6).
- **How we work:** PRD → tracer-bullet issues → **per-slice agent team** (implement → independent
  verify → adversarial review → fold fixes → **user merges**). TDD, vertical slices. Details in §3.

---

## 1. The product, precisely

Vibe ships `vibe-acp` — an ACP server speaking **newline-delimited JSON-RPC 2.0 over stdin/stdout**
(the same transport Zed/VS Code agent panes use). That is the backend we drive. We are a **thin
orchestrator** (ADR-0002): we spawn `vibe-acp`, do the ACP handshake, open sessions, stream prompts,
render reasoning/tool-calls, and handle tool-permission requests. We deliberately do NOT reimplement
the agent, an LSP, or Vibe's own context management.

**Domain vocabulary (use these exact terms — they're the glossary):**
- **Workspace** — an opened project directory. One warm `vibe-acp` agent per open Workspace.
- **Thread** — a conversation. Has a **durable id we mint** (renderer-side, `crypto.randomUUID()`),
  which is **NOT** the ACP `sessionId`. One agent hosts many ACP sessions.
- **ACP session** — Vibe's per-conversation backend session (`session/new` mints, `sessionId`).
  Bound lazily to a Thread on its **first prompt**.
- **Draft** — a Thread that has never been prompted. Now **renderer-only**, persists nothing until
  first prompt (see #58 in §5). (Distinct from a *composer draft* = unsent textarea text — that's #60.)

---

## 2. Stack, environment, and the gotchas that will bite you

- **Stack:** electron-vite (main / preload / renderer split), React 19, plain CSS (no framework,
  single `src/renderer/src/styles.css` with semantic tokens), **Bun** as package manager + test runner
  (vitest). Electron runs its **own Node** at runtime, not Bun.
- **Node is ONLY on nvm.** Prepend to PATH in **every** shell command:
  `export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.local/bin:$PATH"`
  (`~/.local/bin` is where the `vibe-acp` / `uv` entrypoint lives.)
- **Gates (must ALL pass before any slice is done):**
  `bun run lint && bun run typecheck && bun run build && bun run test`
- **🔴 Bun child_process gotcha (CRITICAL for standalone scripts):** Bun 1.3.8's `node:child_process`
  does **NOT** deliver `stdin.write()` to a piped child. Any standalone script that pipes into
  `vibe-acp` must be bundled to a node target and run under **node**, NOT bun:
  `bun build scripts/x.ts --target=node --outfile=/tmp/x.mjs && node /tmp/x.mjs`.
  The Electron app itself is unaffected (it uses its own node). This cost us a day; it's in memory.
- **🔴 Worktree isolation gotcha:** the Agent tool's `isolation: worktree` forks the *session's* cwd
  repo (which is **CodexMonitor**, not vibe-mistro). So we create worktrees **manually** (see §3).
- **Run the app:** `bun run dev` (window titled "Vibe Mistro", user-data-dir `vibe-mistro`).

---

## 3. How we work (the team loop) — follow this exactly

The user runs a tight, verification-heavy loop. Each issue is a **vertical tracer bullet** (a thin
slice through every layer: schema/IPC → main → renderer → tests), built TDD (one test → minimal code →
repeat — never horizontal "all tests then all code").

**Per-slice lifecycle:**
1. **Create a worktree manually** (NOT via the Agent tool's isolation):
   ```
   cd /Users/abdullahatrash/mistral/vibe-mistro
   git fetch origin main
   git worktree add -b feat/<N>-<slug> /Users/abdullahatrash/mistral/vibe-mistro-wt<N> origin/main
   ln -s /Users/abdullahatrash/mistral/vibe-mistro/node_modules /Users/abdullahatrash/mistral/vibe-mistro-wt<N>/node_modules
   ```
2. **Implementer agent** works only in that worktree, TDD, runs gates, **commits to the branch**.
   It does **NOT** push, PR, or merge.
3. **You (lead) independently verify** — re-run the gates yourself, read the diff, trace the risky path
   by hand. Don't take the implementer's word.
4. **Adversarial reviewer agent** (a *separate* agent) hunts for real bugs/regressions with a concrete
   list of failure modes to check. It returns severities (MUST-FIX / SHOULD-FIX / NIT) + a verdict.
5. **You fold** MUST/SHOULD fixes (independently judging them — a reviewer/peer carries no authority,
   verify on merits), re-run gates.
6. **You push + open the PR.** The **user merges** (they always merge; you don't).
7. **Post-merge cleanup:** `gh pr merge <N> --squash` if the click didn't land (see gotcha below),
   then `git checkout main && git pull --ff-only`, `git worktree remove --force ...wt<N>`,
   `git worktree prune`, delete local+remote branch, confirm the issue closed, update memory.

**House rules (non-negotiable):**
- Branch first; **never commit to main**. Commit with `git -c commit.gpgsign=false commit` and the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- PR bodies end with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
- Always `GH_HOST=github.com` for `gh`.
- Subagents never push/PR/merge — only the lead pushes + opens the PR; the user merges.
- **Security (preserve verbatim):** NEVER run a LIVE authenticate / `_auth` / `signOut` against the real
  `vibe-acp` binary; never scan the OS keychain; never store credentials (ADR-0003). Probe scripts may
  only call `_auth/status` / `session/new` / `prompt` / `load` (verified safe).
- **Merge-click-doesn't-land pattern:** the user says "merge"/"merged it" but the PR still shows
  OPEN/CLEAN/MERGEABLE (the click no-op'd while GitHub computed mergeability). Complete it with
  `gh pr merge <N> --squash`. The `--delete-branch` flag trips on the worktree holding the branch;
  delete the branch manually after removing the worktree.

**Triage label:** issues ready for an AFK agent get the **`ready-for-agent`** label.

---

## 4. Where the authoritative information lives

### In-repo docs (`docs/`) — READ THESE before touching the relevant area
- `docs/acp-capture.md` — **the backend contract.** Captured real `vibe-acp` 2.18.0 protocol traffic.
  §8 = auth contract; **§9 = `session/load` resume behavior** (replays history as `session/update`
  notifications then resolves with a `session/new`-shaped result MINUS `sessionId`; unknown id →
  JSON-RPC `-32602` "Session not found" = the re-bind signal). **This is ground truth — trust it over
  guessing.**
- `docs/vibe-acp-protocol.md` — the ACP protocol overview for Vibe.
- `docs/codexmonitor-reference.md` — what to build (feature parity target).
- `docs/opencode-electron-patterns.md` — Electron mechanics (PATH resolution, electron-store, etc.).
- `docs/t3code-reference.md` — patterns adopted from t3code.
- `docs/conventions.md` — code conventions.
- `docs/design/brand.md` — Mistral branding tokens (light mode, orange `--accent #fa500f` for
  fills/borders only; `--accent-text #c2410c` for orange TEXT (AA-safe); zero border-radius / sharp edges).
- `docs/adr/0001..0006` — **the load-bearing decisions. Respect them; don't silently contradict.** See §7.

### The three local reference repos (in `/Users/abdullahatrash/mistral/`)
These are **cloned, real codebases** — grep them for concrete implementations. They are inspiration,
not dependencies; right-size their ideas to our thin-orchestrator scope.

1. **`CodexMonitor/`** — *the concept we're cloning.* Tauri/**Rust** GUI orchestrator for **Codex**.
   ⚠️ This is also the **session's cwd**, so shell commands reset here. Use it for **what features to
   build and how the UX should feel** (thread list, approvals, workspace switching). Don't copy code —
   different stack (Rust/Tauri vs our TS/Electron).
2. **`opencode/packages/desktop/`** — *same stack as us* (electron-vite + Bun, but SolidJS). Use it for
   **Electron mechanics**: shell-env PATH resolution, electron-store persistence, window-state,
   electron-updater, electron-log, node-pty terminal, electron-builder packaging.
3. **`t3code/`** — *a mature multi-agent Effect-TS GUI* (cloned at `/Users/abdullahatrash/mistral/t3code`;
   ignore its `.repos/` vendored deps and `node_modules`). Our **north star for Thread/Session modeling
   and UI shell**. Use it for: Thread-vs-Session + resume-cursor, snapshot-then-stream, draft handling
   (we mirrored its client-only thread-draft model in #58, and #60 mirrors its composer-draft store —
   `apps/web/src/composerDraftStore.ts`, key `t3code:composer-drafts:v1`, `shouldRemoveDraft` pruning).
   Most of its multi-provider/CQRS/Effect machinery is **overkill for us** — take patterns, not the stack.

### Persistent memory (across sessions)
There is a file-based memory at
`/Users/abdullahatrash/.claude/projects/-Users-abdullahatrash-mistral-CodexMonitor/memory/`.
Key files: `MEMORY.md` (index), `vibe-monitor-project.md` (the full project log — read this for the
blow-by-blow of every merged slice), `vibe-mistro-team-workflow.md` (the loop + house rules),
`vibe-mistro-bun-child-process-gotcha.md` (the Bun gotcha). **Update memory as you complete work.**

---

## 5. What exists now (all merged to `main`)

**MVP conversation loop (PRD #1)** — open → prompt → reason → act-with-approval. Connect handshake,
pure conversation reducer + streaming + `fs/read`, tool cards + `session/request_permission`
approve/deny + `fs/write`.

**Auth epic (PRD #9)** — in-app auth fully shipped: detect (classify on `-32000` + `_auth/status`),
browser-delegated sign-in (start → open URL → complete), status/sign-out/account-switch/mid-session
re-auth, blocking fallback for older vibe-acp. **Never stores credentials (ADR-0003).** Contract in
`acp-capture.md §8`. Code in `src/main/auth`, `src/renderer/src/auth`.

**fs hardening (#8, #21)** — `fs/write` confined to the Workspace via `O_NOFOLLOW` fds
(`secureWriteWithinRoot`) + kernel-accurate symlink resolution; reads stay unconfined (CLI parity,
ADR-0004). Code in `src/main/acp`.

**Persistence epic (PRD #27, ADR-0005)** — full thread lifecycle: **create → use → reopen → continue →
delete.** Metadata-first lazy reopen (cold list on launch, no agent spawned) + a per-Thread **JSONL
transcript we own** (teed at main's IPC chokepoints, replayed through the existing reducer) + Vibe owns
agent context via `session/load` (re-bind to a fresh session on resume failure, history preserved).
Key code: `src/main/persistence/` (`metadata-store.ts`, `transcript.ts`, `delete-thread.ts`),
`src/main/thread-binding.ts` (`ensureBoundSession` — the 3 cases: draft→`session/new`,
stored-not-hosted→load/re-bind, hosted→reuse), `src/renderer/src/conversation/replay.ts`.

**UI/layout-shell epic (PRD #45, ADR-0006)** — persistent two-pane `<Shell>` (sidebar + outlet),
navigation = a **pure nav reducer** at the shell root (NO router, NO Zustand), and **one warm
`vibe-acp` agent per open Workspace** via a bounded **agent pool** (lazy spawn, idle-evict, LRU cap,
protection for the active/streaming/signing-in agent, transparent re-warm). Instant Workspace switching,
background streaming, unified cold+live thread list. Key code: `src/renderer/src/shell/` (`Shell.tsx`,
`nav-reducer.ts`, `unified-threads.ts`, `first-run.ts`), `src/main/agent-pool.ts`,
`src/main/agent-protection.ts`, `src/main/workspace-agent.ts`, `src/renderer/src/connection/`.

**#53 per-thread indicators** — streaming/attention indicators for **all** live Threads (not just the
active one), via a main-side pure `ThreadStatusTracker` (`src/main/thread-status.ts`) that pushes
`thread:status` only on a flag flip; single source of truth for the sidebar roll-up.

**#58 client-side draft** — a New thread you never prompt is **renderer-only** and persists nothing
(no metadata, no session, no JSONL) until its first prompt; matches t3code. `App.tsx newThread()` mints
`crypto.randomUUID()`, hosts it live, selects it; the first prompt binds + persists under that preserved
id via the existing `mintAndBind` path.

---

## 6. What's next

**Open backlog (2):**
- **#61 — Adopt t3code's UI stack: base-ui + Tailwind v4 + lucide + react-markdown** (`ready-for-agent`,
  not started). FOUNDATIONAL WIRING slice (not a rewrite): install + configure `@base-ui/react`,
  `tailwindcss ^4` + `@tailwindcss/vite` + `tailwind-merge`, `lucide-react`, `react-markdown` +
  `remark-gfm/remark-breaks` (t3code's stack); wire Tailwind v4 into the **renderer** config of
  electron-vite; **preserve the brand** by mapping the existing tokens (`--accent`, `--accent-text`,
  `--radius: 0` sharp edges) into Tailwind v4 `@theme` (don't regress `docs/design/brand.md`); first
  payoff = render agent assistant/reasoning text as markdown via a `ChatMarkdown` (NO `rehype-raw` —
  agent output is untrusted); seed a `cn()` util + a `ui/` folder with ≥1 base-ui primitive wired into a
  real call site + a couple of lucide icons. Plain CSS coexists; per-area migration is follow-up slices.
  References: t3code `apps/web/vite.config.ts`, `src/index.css`, `components/ui/*`, `ChatMarkdown.tsx`.
  This is the natural foundation to lay before more UI work. → `start 61`.
- **#60 — Persist message-level composer drafts across navigation** (`ready-for-agent`, not started).
  Unsent composer textarea text is lost on unmount/eviction/restart (it's `useState('')` in
  `Conversation.tsx`). Build a **pure renderer composer-draft store** keyed by Thread id, persisted to
  **localStorage** (key `vibe-mistro:composer-drafts:v1`), with empty-pruning (`shouldRemoveDraft`-style),
  clear-on-send, delete-cascade, and malformed-storage tolerance. **Text only** (no attachments/model —
  we don't have those affordances). localStorage only — it's ephemeral UI state, NOT conversation
  history, so it must NOT touch the JSONL/metadata store. Reference: t3code `composerDraftStore.ts`.
  Test the pure store at its seam over an injected `Storage` fake (like `unified-threads.ts` /
  `workspace-threads.ts` / `thread-status.ts` tests) — not the React component.
  → To start: `start 60` and run the full team loop in §3.

**Deferred roadmap (no issues yet — propose as PRDs/tracer bullets when the user picks one up):**
composer extras (attachments/model selection), git/GitHub panel, terminal dock (node-pty — see opencode),
app updates + packaging (electron-updater/electron-builder — see opencode). The feature-parity target is
`docs/codexmonitor-reference.md`.

---

## 7. ADRs — the locked decisions (don't silently contradict)

- **0001** — renderer owns conversation state; Workspace / Thread / ACP-session layering.
- **0002** — thin orchestrator (no LSP, no reimplementing the agent).
- **0003** — auth delegated to the vibe binary; **never store credentials**.
- **0004** — fs: unconfined reads / symlink-resolved confined writes.
- **0005** — persistence: JSON metadata store + JSONL transcript **we own**; **Vibe owns agent history**
  via `session/load` (re-bind on resume failure). Durable Thread id ≠ ACP sessionId.
- **0006** — app shell: persistent two-pane shell; pure nav reducer (no router/Zustand); one warm agent
  per open Workspace via a bounded pool.

If a new slice needs to revisit one of these, that's an **HITL** decision — write a new ADR and get the
user's call; don't just diverge.

---

## 8. First moves for the new agent

1. Read this file, then skim `docs/acp-capture.md` and the memory file `vibe-monitor-project.md`.
2. Confirm the baseline: `cd /Users/abdullahatrash/mistral/vibe-mistro` (on `main`), run the gates
   (`export PATH=...nvm...; bun run lint && bun run typecheck && bun run build && bun run test`) →
   expect **288 tests green**.
3. Check the backlog: `GH_HOST=github.com gh issue list --state open` → expect **#60 and #61**
   (#61 = the UI-stack foundation, the natural one to do first before more UI work).
4. When the user says "start 60" (or picks a roadmap item), run the **team loop in §3** — manual
   worktree, implementer agent, your independent verify, adversarial reviewer, fold, push, **user merges**,
   cleanup, update memory.
5. Keep slices thin and vertical. Verify everything yourself. The user trusts terse approvals
   ("merge", "yes", "start N") — earn it by never reporting "done" on something you didn't actually run.
