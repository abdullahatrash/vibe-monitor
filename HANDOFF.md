# vibe-mistro — Agent Handoff

> You are picking up an in-flight project. Read this top to bottom once, then keep it open.
> It tells you **what this is**, **how we work**, **what exists**, **what's next**, and **where the
> authoritative information lives** (in-repo docs + the local reference repos in §4). Last updated
> 2026-07-02, `main` @ `4a0104f` or later, **691 tests**. 🎉 **The design-system epic (PRD #109) is COMPLETE** —
> ALL slices shipped (#110 tokens · #111 primitives · #112 streamdown spike · #113 shell · #114–#116 conversation
> core · #117 composer · #118 auth · #119 git panel, plus the sidebar cluster #127–#134/#138). Every UI area now
> runs on tokens + primitives. **There is NO active epic — the next one is the user's call** (see §6 for the
> roadmap + a small open follow-up backlog). **Five draft feature epics are now FILED and ready to pick up:**
> #174 Search · #175 Scheduled · #176 Plugins · #177 Project actions · #178 Open in IDE (see §6 "Draft feature
> epics"). `docs/NEXT-SESSION.md` is the copy-paste kickoff. Values live in
> ADR-0010..0012 + `docs/design-tokens.md` + `docs/design-system-components.md` + `docs/streamdown-spike.md`.
> `$`/`@` autocomplete stays paused.

---

## 0. TL;DR

- **What:** `vibe-mistro` — an Electron + TypeScript + React 19 + Bun **desktop app** that orchestrates
  the **Mistral Vibe** coding agent over **ACP** (Agent Client Protocol — JSON-RPC 2.0 over stdio).
  It's a GUI "monitor/orchestrator" for Vibe, modeled on **CodexMonitor** (which does the same for Codex).
- **Where:** `/Users/abdullahatrash/mistral/vibe-mistro` (repo, dir, and package all named `vibe-mistro`).
  GitHub: `https://github.com/abdullahatrash/vibe-mistro` (owner `abdullahatrash`, host `github.com`).
- **State:** MVP works end-to-end (open project → prompt → streamed reasoning → tool calls with approval).
  Merged: Auth, fs-hardening, the **persistence epic**, the **UI/layout-shell epic**, **composer drafts**
  (#60), the **t3code UI stack** (#61: Tailwind v4 + base-ui + lucide + react-markdown), the full
  **Agent controls** feature (Mode/Model/Reasoning-effort — #65 spike → #66 picker → #70 per-Thread →
  #72 re-assert-after-load → #75 draft pre-select; **live-verified** in `bun run dev`), and **sign-in
  resilience** (#78 preserve failure reason + RPC code + stderr log; #80 a "Check status" re-query
  recovery — static-verified, live re-check smoke still pending), and the full **git/GitHub epic**
  (ADR-0008: a Changes panel = status #84 + diff #85 + commit #86 + branches #87 + gh-PR surfacing #88;
  #84-86 live-verified, #87-88 static+unit), and most of the **composer-extras epic**: `/` slash-command
  autocomplete (#95-97), **image attachments** (paste + picker — #99 spike, #101; wire shape §11), and
  **queue + interrupt follow-ups** (ADR-0009: #102 spike, #104 Stop/`session/cancel`, #106 queue —
  **live-verified**; steer dropped as protocol-blocked). **Backlog is empty.** Next: a **design-system
  pass** (see §6); the last composer sub-feature (`$`/`@` autocomplete) stays paused.
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
- **🔴 Worktree node_modules gotcha (learned the hard way, #64):** do **NOT** `ln -s` the main
  `node_modules` into a worktree. `.gitignore`'s `node_modules/` (now hardened to `node_modules`) didn't
  match the *symlink*, a `git add -A` committed it, and on checkout it became a self-referential loop
  that broke `bun install`/tsc/vitest. Instead run a real `bun install` **inside** the worktree (~3.5s).
  Corollary: **fold with targeted `git add <paths>`, never `git add -A`**; and **re-run gates on `main`
  after worktree cleanup** (a `git worktree remove` after a checkout/pull dance can drop node_modules).
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
   cd /Users/abdullahatrash/mistral/vibe-mistro-wt<N> && bun install   # real install — do NOT symlink node_modules (see §2 gotcha)
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
- **Design system (the active epic — ADR-0010):** `docs/adr/0010-…` (decisions) + `docs/design-tokens.md`
  (exact token values) + `docs/design-system-components.md` (what to lift from shadcn/t3code + how). ⚠️
  These **supersede `docs/design/brand.md`** — the design epic REVERSES the old brand (bright `--accent
  #fa500f` → softer gradient-orange `#cf6a3a`/`#e07a3e`; **zero radius → a rounded scale**). Use
  `design-tokens.md`, not `brand.md`, for anything visual from now on.
- `docs/adr/0001..0010` — **the load-bearing decisions. Respect them; don't silently contradict.** See §7.

### The local reference repos (in `/Users/abdullahatrash/mistral/`)
These are **cloned, real codebases** — grep them for concrete implementations. They are inspiration,
not dependencies; right-size their ideas to our thin-orchestrator scope. Copy-adapt + own in-repo — never
add them as npm deps.

1. **`CodexMonitor/`** — *the concept we're cloning.* Tauri/**Rust** GUI orchestrator for **Codex**.
   ⚠️ This is also the **session's cwd**, so shell commands reset here. Use it for **what features to
   build and how the UX should feel** (thread list, approvals, workspace switching). Don't copy code —
   different stack (Rust/Tauri vs our TS/Electron).
2. **`opencode/packages/desktop/`** — *same stack as us* (electron-vite + Bun, but SolidJS). Use it for
   **Electron mechanics**: shell-env PATH resolution, electron-store persistence, window-state,
   electron-updater, electron-log, node-pty terminal, electron-builder packaging.
3. **`t3code/`** — *a mature multi-agent Effect-TS GUI* (`/Users/abdullahatrash/mistral/t3code`; ignore its
   `.repos/` + `node_modules`). Our **north star for Thread/Session modeling, the UI shell, AND the rich
   conversation aesthetic** (design-system epic mines its chat: `apps/web/src/components/chat/*` +
   `ChatMarkdown.tsx` — message/bubble, file-path links, `SimpleWorkEntryRow` tool rows, reasoning, working
   indicator; see `docs/design-system-components.md`). Its stack matches ours (Tailwind v4 + base-ui + CVA +
   lucide). Take patterns, not the Effect/CQRS machinery.
4. **`ui/`** — the **shadcn/ui monorepo** (`/Users/abdullahatrash/mistral/ui`). The **primitive-library
   source for the design-system epic**: base-ui components under `apps/v4/registry/bases/base/ui/` (the
   `base` base, NOT `radix`) — Button CVA exemplar + Message/Bubble/MessageScroller. Copy-adapt to our
   tokens (swap their `cn-*` theme tokens for inline Tailwind). Details in `docs/design-system-components.md`.
5. **`mistral-vibe/`** — the **cloned Vibe CLI / ACP backend source** (`/Users/abdullahatrash/mistral/mistral-vibe`,
   package under `vibe/`). Ground truth for **how the agent behaves over ACP** — e.g. `vibe/acp/acp_agent_loop.py`
   resolved that skills fold into the `available_commands_update` list (`$`≡`/`) and `@path` is expanded
   server-side via `render_path_prompt`. Read it to verify protocol behavior instead of guessing.

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

**#60 composer drafts** — unsent composer text persists per-Thread to **localStorage** (key
`vibe-mistro:composer-drafts:v1`) so it survives unmount/eviction/restart. Pure store
`src/renderer/src/conversation/composer-draft-store.ts` over an injected `DraftStorage` seam: stores raw
text, prunes empties (removes the key when the map empties), clear-on-send, delete-cascade, malformed/
throwing/absent-storage tolerant. localStorage only — never touches JSONL/metadata.

**#61 t3code UI stack** — Tailwind v4 (`@tailwindcss/vite` in the **renderer** config only) + base-ui
(`@base-ui/react`) + lucide + react-markdown, all installed/wired. Brand tokens bridged via
`@theme inline` in `styles.css` with the radius scale pinned to 0 (sharp edges can't regress through a
utility). `cn()` at `src/renderer/src/lib/utils.ts`; `ui/menu.tsx` base-ui primitive. `ChatMarkdown.tsx`
renders assistant + reasoning text as GFM markdown — **no `rehype-raw`** (untrusted agent output; react-
markdown's default escaping + `defaultUrlTransform` neutralize `javascript:` hrefs). Plain CSS coexists;
per-area migration is follow-up.

**Agent controls (#65 spike → #66 → #70 → #72 → #75)** — per-Thread **Mode / Model / Reasoning effort**
picker in the composer (CONTEXT.md "Agent controls"; ADR-0007). **Live-verified** in `bun run dev`
(draft pre-select, the pre-pick running the first turn in `plan`, per-Thread isolation). The #65 spike
captured the change methods live (acp-capture §10): Mode `session/set_mode {sessionId,modeId}`, Model
`session/set_model {sessionId,modelId}` (⚠️ false-accepts any string — only send `availableModels` ids),
Reasoning effort `session/set_config_option {sessionId,configId,value}` (`configId`, NOT `id`). A change
emits **no** notification → the renderer updates **optimistically** (revert on error). Mode is **not**
preserved across `session/load` (resets to `default`). UI: `AgentControls.tsx` (base-ui menus, disabled
only while a turn streams). Per-Thread state lives in `connection/workspace-threads.ts`: `config` (live
values, seeded on `connect`/`bind` from each session's controls, plumbed via `ThreadAgentControls` on
`thread:bound`) + `selected` (the user's confirmed picks, **survives `connect`-reset** for re-assert).
**#72** caches a pick on IPC-success and re-asserts it after a `session/load` resume
(`reassertAfterResume`). **#75** shows + enables the pickers on a pre-prompt DRAFT (`draftControls`
projects the connection's option lists + defaults; a draft pick caches with NO IPC, applied on first
bind by #72). Probe: `scripts/spike-config-option.ts`.

**Sign-in resilience (#76 → #78 + #80)** — fixed the intermittent delegated-sign-in bug's diagnosability +
recovery. **#78:** `WorkspaceAgentError` gains `code`; `toSignInError`/`toSignOutError` preserve Vibe's
reason + JSON-RPC code (`rpcErrorParts`/`formatAuthFailure`); auth IPC handlers log `[vibe-mistro:auth]`
to main stderr. **#80:** `WorkspaceAgent.refreshAuthStatus()` + typed IPC `auth:check-status` + an
"Already signed in? Check status" button (`authReducer` `checking` phase) that re-queries `_auth/status`
without re-running the browser flow — recovers an out-of-band `vibe` CLI sign-in / blocking fallback / a
lost `complete`. Static-verified; **live re-check smoke still pending** (needs a real sign-out). Deferred:
background auth polling.

**git/GitHub epic (ADR-0008; #84 → #85 → #86 → #87 → #88)** — a collapsible right **"Changes" panel**
on the connected Workspace view. Operate on the Workspace **working tree** (NOT worktree-per-Thread —
that's a deferred isolation epic); git runs in **main** via `child_process` (no git2/iso-git); panel
streamed for the **active Workspace only**. Slices: **#84** streamed status (`src/main/git/status.ts`
pure `parseGitStatus` over `--porcelain=2`+numstat; `status-stream.ts` ref-counted manager — chokidar
watcher + cached background `git fetch`; `git:subscribe-status`/`git:status` push); **#85** working-tree
diff via **`@pierre/diffs`** (`diff.ts` raw-patch+`diffHash`; `DiffWorkerProvider`/`DiffView` `PatchDiff`,
stacked/split; needs `worker:{format:'es'}` in `electron.vite.config.ts`); **#86** commit (`commit.ts`
exact-selection `reset`+`add`, stages both halves of a staged rename; per-file checkboxes; disabled while
a turn streams); **#87** branches (`branches.ts` list/checkout/create; remote checkout via
`git switch --track`; base-ui dropdown); **#88** gh PR surfacing (`github.ts` shells `gh`; PR chip as an
external `<a target=_blank>`; Create-PR gated on an upstream — never pushes for you). `#84-86` are
**live-verified**; `#87-88` static+unit only (live smoke pending). Deferred: multi-repo, PR/issue
browser, "Ask PR", worktree-per-Thread isolation.

**composer-extras epic — slice 1 (#95; PR #96 + scroll-fix #97)** — `/` slash-command autocomplete in
the composer. **Renderer-only** (no main/IPC/protocol change): the agent's commands already arrive on the
`available_commands_update` stream and are folded into the conversation reducer's `state.availableCommands`
(pre-existing, "stored, not rendered") — this slice renders them. Load-bearing logic is the pure, DOM-free
`src/renderer/src/conversation/command-autocomplete.ts` (+ 24 tests): `getCommandQuery` (trigger =
`/`-token at input/line start, caret-after-`/`, whitespace closes it, caret clamped), `filterCommands`
(prefix-then-substring, case-insensitive), `applyCommand` (splice `/<name> `, keep text after caret),
`moveSelection` (wrapping). `Conversation.tsx` keeps only thin popover JSX + keyboard/caret wiring:
Enter/Tab accept (intercepted **only while open**, so Enter still sends when closed), ↑/↓ wrap with
`scrollIntoView({block:'nearest'})` (#97), Esc dismisses with a **per-token latch** (the escape hatch for
sending literal `/text`), mousedown-accept beats blur, rAF caret restore, draft + localStorage draft (#60)
kept in sync. **Live-verified** in `bun run dev`. This slice only INSERTS the `/name ` text — command
*execution* is deferred. See the `composer-extras-epic` memory + §6 for the remaining sub-features.

**composer-extras — image attachments (#99 spike → #101; acp-capture §11)** — paste + file-picker image
attach. **Wire-shape trap** (spike-verified): the `session/prompt` image block is
`{type:"image", data:<BARE base64>, mime_type}` — snake_case **`mime_type`**; the ACP-conventional
camelCase `mimeType` is silently accepted but the model goes BLIND. Vision is per-model, gated before the
call → app code **-31008** (only `mistral-medium-3.5` has vision; `devstral-small`/`local` reject). v1 =
paste + picker ingest; `-31008` → recoverable "switch model" hint (images+text kept on failure); echoed
thumbnails; NOT persisted to JSONL. Pure `image-attach.ts` (`parseDataUrl`+type-guard). `WorkspaceAgentError`
now preserves the rpc `code` (was a latent gap). Deferred: drag-drop, HEIC/sips. Probe: `scripts/spike-image-block.ts`.

**composer-extras — queue + interrupt follow-ups (ADR-0009; #102 spike → #104 → #106)** — reshaped from
"queue-vs-steer" by the spike: **steer is protocol-blocked** (a 2nd `session/prompt` mid-turn → `-32602`
"Concurrent prompts are not supported yet"; no steer method). `session/cancel` is a NOTIFICATION `{sessionId}`
→ the in-flight prompt RESOLVES `stopReason:"cancelled"`. **#104 (interrupt):** a `⏹ Stop` button →
`WorkspaceAgent.cancel` → `session/cancel` notify; rides the existing turn-complete path (no new output).
**#106 (queue):** compose-while-streaming → Enter enqueues; multi-message per-Thread queue in a
`useSyncExternalStore` module store (`follow-up-queue.ts`) that SURVIVES the `Conversation` remount
(`key={threadId}`), renderer-only ephemeral; auto-flush one-per-turn-end. **Serialization gotcha (cost a
review round):** the in-flight latch MUST be module-level per-Thread (`sending` Set), NOT a per-instance
`useRef` — a per-instance ref let a remounted Conversation flush into a still-running turn → the exact
`-32602` the queue prevents. Flush is an effect gated on the LIVE module latch. **Live-verified.** Probe:
`scripts/spike-cancel-steer.ts`. Deferred: edit-in-place, restart persistence, re-queue-on-flush-failure, steer.

---

## 6. What's next

**The DESIGN-SYSTEM epic (PRD #109) is COMPLETE (all slices merged).** Pipeline was: `/grill-with-docs` →
**ADR-0010** + `docs/design-tokens.md` + `docs/design-system-components.md` → PRD #109 → `/to-issues`
(#110–#119). **There is no active epic; the next one is the user's call.** The ► SHIPPED block below records
what landed; the remaining-slices block is retained only as build-order history (those slices are now merged).

**► DRAFT FEATURE EPICS (filed, ready to pick up & refine — each is a `(draft)` GitHub issue with a slice
breakdown + open questions, anchored to the reference repos; none is `ready-for-agent` yet):**
- **#174 Search** — find across local Threads & transcripts. Natural first: we already own the data
  (`MetadataStore` titles + `TranscriptStore` JSONL), so it's a read-only local index, no agent.
- **#175 Scheduled** — run a prompt in a Workspace on a schedule (persisted store + a scheduler sweep firing
  headless turns via the pool). Key tensions: app must be running (no daemon); approval posture with no user present.
- **#176 Plugins** — manage the agent's extensions / tool providers. Least-defined; **slice 1 is a protocol
  spike** (what does `vibe-acp` expose?) — may be blocked on Vibe (ADR-0002: thin orchestrator).
- **#177 Project actions** — user-defined per-Workspace shell commands ("Add action", from **t3code**'s
  `ProjectScriptsControl.tsx`): run/test/build/lint with icons + keybindings, streamed output. Reuses
  `shell-env.ts` + process supervision.
- **#178 Open in IDE** — a header target-picker to open the Workspace in an external editor (from **CodexMonitor**'s
  `OpenAppTarget` select + **t3code**'s `shell.openInEditor`). Generalizes the existing reveal-in-Finder seam.

The first three (#174–#176) are the sidebar's current static **"Soon"** placeholders (New chat PR #161); the
last two (#177–#178) are header features mined from the reference apps. Refine scope (a PRD / grill-with-docs)
before starting any.

**► SHIPPED (all merged to `main`):**
- **Foundation:** #110 token layer (warm/rounded/soft-orange in `styles.css`) · #111 primitive library
  (`src/renderer/src/ui/` — base-ui + Tailwind + **CVA**; Button/Menu/Dialog/Popover/Tooltip/Collapsible/Select/
  ScrollArea/… + `MenuRadioGroup`) · #112 **streamdown ADOPT** verdict (`docs/streamdown-spike.md`) · #113 shell.
- **Full SIDEBAR cluster** (a follow-up wave beyond the original #110–119): collapsible all-visible project list
  (#138, base-ui Collapsible, peek-only) · Projects header +new-project/sort (#129) · pin + archive threads
  (#132/#133 — `ThreadMeta.pinned?`/`archived?` + `thread:set-flags` IPC + `MetadataStore.setThreadFlags`;
  `orderByPin`/`partitionArchived`) · settings page + account menu (#130, nav-reducer `view` route) · collapsible
  sidebar (#127) · official SVG logo (#134) · branded **snake loading spinner** · sticky top-nav/bottom-account.
  Also parallel: #125 persistence hardening (ADR-0011, draft-persist-on-first-prompt).

**► REMAINING slices (build order + deps):**
- **#114** conversation A / Response(=streamdown)+Message+Bubble+autoscroll **[HITL]** (#111,#112 ✓) → **#115**
  conversation B / tool+reasoning+working (#114) → **#116** conversation C / approval-inline+actions+file-links (#114)
- **#117** composer (#111,#113 ✓) · **#118** auth (#111 ✓) · **#119** git panel (#111 ✓) — parallel, AFK-able.
- Recommended: knock out the AFK area slices **#117 → #119 → #118** first, then **#114 → #115 → #116** with the
  human in the loop. Each is a **behavior-identical restyle** (569 tests MUST stay green) that retires its area's
  BEM from `styles.css`. **Reference sources for the conversation work** (copy-adapt & OWN, never a dep):
  `docs/design-system-components.md §2` (THE lift-from guide) · **streamdown** (`docs/streamdown-spike.md`) ·
  **shadcn/ui** `bases/base/ui/` (`message`/`bubble`/`message-scroller`/`marker`) · **shadcn AI Elements / ai-sdk
  Elements** (web: `ai-sdk.dev/elements` — Conversation/Message/Response/Reasoning/Tool/Actions patterns; structure
  only, feed our ACP reducer) · **t3code** `apps/web/src/components/chat/*` + `ChatMarkdown.tsx` · base-ui docs.
  Full list + how-to-drive-it in **`docs/NEXT-SESSION.md`**.

**Composer-extras — remaining (RESOLVED from the Vibe CLI source `/Users/abdullahatrash/mistral/mistral-vibe`):**
- **`$` skills — DROP; already covered by `/`.** vibe-acp has NO `$`/`skills/list` surface: skills are
  folded into the SAME `available_commands_update` list as slash commands (`_send_available_commands`,
  `vibe/acp/acp_agent_loop.py:1173`), and a client can't distinguish a skill from a command. So `$` is not
  a wire concept — the #95 `/` autocomplete already surfaces skills. No work.
- **`@` file-path autocomplete — NOT blocked on a full file tree** (a lighter slice than we thought). No
  server path-completion exists (must be client-side), but the agent expands a plain-text `@path` itself
  via `render_path_prompt` (`acp_agent_loop.py:1608`, resolves vs cwd + inlines the file). So `@` needs
  only: a **main-side file-listing/index IPC** (renderer has no fs) + a **path-completion popup** (mirror
  the CLI's `vibe/cli/autocompletion/path_completion.py` + `file_indexer/`), sending the mention as PLAIN
  TEXT. Can ship on its own or fold into the file-tree epic. Command *execution* (running `/name` vs.
  inserting text, #95) remains deferred.

**Still-pending verification:** (a) the **sign-in re-check (#80)** has not been smoked live (needs a
real sign-out → "Check status" → out-of-band `vibe` CLI sign-in → "Check status" lands connected);
(b) **git branches (#87)** and **gh PR surfacing (#88)** shipped static+unit-verified only — smoke
them live (branch list/switch/create; PR chip + Create-PR gated on an existing upstream). Git
status/diff/commit (#84-86), Agent-controls, and composer-extras `/`+image+queue/interrupt ARE
live-verified. Do these smokes when convenient.

**Deferred roadmap (no issues yet — propose as a PRD / grill-with-docs → tracer-bullet issues when the
user picks one up; rough CodexMonitor build order):**
- **Design-system pass** — the CHOSEN next epic (see ► above): tokens/theme → shared primitives →
  per-area migration onto the #61 foundation. Subsumes the old "per-area base-ui/Tailwind migration" line.
- **Composer extras — final piece** — `$` skills DROPPED (already in the `/` list); `@` file-path
  autocomplete needs a main-side file-listing IPC + a path popup (send `@path` as plain text — agent
  expands it), shippable on its own or with the file tree. `/`+image+queue/interrupt+model+drafts done.
- **Git/GitHub follow-ups** (ADR-0008 deferred-tier; v1 = status/diff/commit/branches/gh-PR-surfacing
  shipped) — multi-repo aggregation, a full PR/issue *browser*, "Ask PR", worktree-per-Thread isolation.
- **File tree + prompt library** (also unblocks `@` autocomplete).
- **Terminal dock** (node-pty — see opencode), then **settings / usage meter / in-app updates /
  packaging** (electron-updater/electron-builder — see opencode), then remote backend (deferred).
Parity target: `docs/codexmonitor-reference.md`.

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
- **0007** — Agent controls (Mode/Model/Reasoning effort): Vibe-owned, display-from-session-state,
  sticky per-Thread, between-turns + forward-acting; changed via `session/set_mode`/`set_model`/
  `set_config_option`; optimistic (no change-notification); cache + re-assert after `session/load`
  (Vibe resets Mode to default on resume). Status: spike #65 resolved.
- **0008** — git integration: operate on the Workspace **working tree** (not worktree-per-Thread); git
  in **main** via `child_process` (`git`/`gh`); diffs via **@pierre/diffs** (data contract = raw unified
  patch + `diffHash`); **streamed status** (debounced fs watcher + cached `git fetch`); active-Workspace
  only; v1 ladder = status #84 → diff #85 → commit #86 → branches #87 → gh-PR surfacing #88 (shipped).
- **0009** — follow-ups: client-side **queue + interrupt**, **steer is protocol-blocked** (spike #102/§12:
  concurrent `session/prompt` → `-32602`; `session/cancel` is a notification → prompt resolves
  `stopReason:"cancelled"`). Interrupt = Stop button (#104); queue = compose-while-streaming + auto-flush
  (#106), serialized via a MODULE-level per-Thread latch (a per-instance ref can't serialize across the
  `Conversation` remount). Steer deferred pending a vibe steer method.
- **0010** — design-system epic: keep the CSS-vars→`@theme` token hybrid, adopt the prototype values (warm
  neutrals, rounded radius scale reversing `--radius:0`, softer gradient-orange `#cf6a3a`/`#e07a3e`); a
  base-ui+Tailwind+**CVA** primitive library under `ui/` copy-adapted from shadcn `bases/base` + t3code,
  retiring BEM area-by-area; conversation keeps the discriminated-union item+switch (ADR-0001) with reusable
  inner primitives (Response=streamdown, gated); migrate area-by-area behavior-identical. Values →
  `docs/design-tokens.md`; adaptation notes → `docs/design-system-components.md`; PRD #109; issues #110–#119.

If a new slice needs to revisit one of these, that's an **HITL** decision — write a new ADR and get the
user's call; don't just diverge.

---

## 8. First moves for the new agent

1. Read this file, then **ADR-0010** + `docs/design-tokens.md` + `docs/design-system-components.md` (the
   filed design-system epic), and skim the `composer-extras-epic` memory.
2. Confirm the baseline: `cd /Users/abdullahatrash/mistral/vibe-mistro` (on `main`), run the gates
   (`export PATH=...nvm...; bun run lint && bun run typecheck && bun run build && bun run test`) →
   expect **495 tests green**.
3. The next move is the **design-system epic** — it's already filed: `GH_HOST=github.com gh issue list
   --state open --label ready-for-agent` shows PRD #109 + slices #110–#119 (§6). **Start with #110 (token
   layer)** — no blockers. Run the **team loop (§3)** per slice: manual worktree (real `bun install`),
   implementer agent (the issue carries `/tdd`), your independent verify + diff read, adversarial review,
   fold, push, **user merges**, cleanup, re-run gates on `main`, update memory. Verification debt remains:
   the #80 sign-in re-check
   and the #87/#88 git slices haven't been smoked live (§6).
4. When the user picks a roadmap item (or says "start <N>"), run the **team loop in §3** — manual
   worktree (real `bun install`, NOT a node_modules symlink — §2), implementer agent, your independent
   verify, adversarial reviewer, fold (targeted `git add`, never `-A`), push, **user merges**, cleanup,
   re-run gates on `main`, update memory.
5. Keep slices thin and vertical. Verify everything yourself. The user trusts terse approvals
   ("merge", "yes", "start N") — earn it by never reporting "done" on something you didn't actually run.
