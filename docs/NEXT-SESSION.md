# Next session — design-system epic: conversation + composer + auth + git

The epic's **foundation is DONE** (tokens, primitives, streamdown decision, shell) and the **entire sidebar
cluster is DONE**. What remains is the **conversation view**, the **composer**, and the **auth** + **git**
panels. Open a fresh Claude Code session **in `/Users/abdullahatrash/mistral/vibe-mistro`** (so `main` is the
cwd — it auto-loads `CLAUDE.md` + the memory index) and paste the block below as the first message.

## Paste this

> Read `HANDOFF.md`, then `docs/adr/0010-design-system-tokens-primitives-migration.md` + `docs/design-tokens.md`
> + `docs/design-system-components.md` + `docs/streamdown-spike.md`. We're continuing the **design-system epic**
> (parent PRD #109). Its **foundation (#110 tokens, #111 primitives, #112 streamdown spike, #113 shell) and the
> whole SIDEBAR cluster (#127–#134, #138) are already SHIPPED to `main`.** What's LEFT: **#114/#115/#116
> conversation, #117 composer, #118 auth, #119 git panel.** First confirm the baseline: on `main`, run the four
> gates (`export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.local/bin:$PATH"; bun run lint && bun run
> typecheck && bun run build && bun run test`) → expect **569 tests green** (`main` @ `0197b5a` or later). Then
> build the next slice via the **team loop in HANDOFF §3**: a manual worktree with a **real `bun install`**
> (never a `node_modules` symlink), an implementer agent (the issue carries `/tdd`), your own **independent
> verification** (re-run all four gates + read the diff), an **adversarial review** agent, fold fixes, **targeted
> `git add <paths>` (never `-A`)**, push, and **I'll merge**. Each is a **behavior-identical restyle** — the 569
> tests must stay green. **START with the slice I name** (or, if I just say "continue", start **#117 composer** —
> it's unblocked and AFK-able — and ask me before starting **#114**, which is HITL). For the CONVERSATION slices
> (#114–#116) mine the reference sources below HARD; the Response/markdown layer is **streamdown** (adopted in
> #112 — `docs/streamdown-spike.md` has the exact wiring + the security sign-off you must surface to me).

## What's already shipped (this epic, all on `main`)
- **Foundation:** #110 token layer (warm neutrals / rounded / softer gradient-orange in `styles.css`), #111
  primitive library (`src/renderer/src/ui/` — base-ui + Tailwind + **CVA**: Button/Menu/Dialog/Popover/Tooltip/
  Collapsible/Select/ScrollArea/etc. + `MenuRadioGroup`), #112 **streamdown ADOPT** verdict (`docs/streamdown-spike.md`),
  #113 shell/sidebar restyle.
- **Sidebar cluster:** all-visible **collapsible project list** (#138 — base-ui Collapsible, peek-only: folding
  never spawns an agent; active project shows live rows, others show cold), Projects header **+new-project + sort**
  (#129), **pin + archive** threads (#132/#133 — `ThreadMeta.pinned?`/`archived?` + `thread:set-flags` IPC +
  `MetadataStore.setThreadFlags`; `orderByPin`/`partitionArchived` in `unified-threads.ts`), **settings page +
  account menu** (#130 — nav-reducer `view: 'conversation'|'settings'` route), **collapsible sidebar** (#127 —
  `panel-left` toggle + `sidebar-collapsed-store`), official **SVG logo** (#134), a branded **snake loading spinner**
  (`shell/logo-snake-spinner.tsx` + `vmSnake` keyframe), and sticky top-nav/bottom-account (only the Projects list
  scrolls). Renderer-only UI state uses the injected-storage throw-tolerant store pattern
  (`project-open-store`/`workspace-sort`/`sidebar-collapsed-store`).
- **Persistence (parallel, not this epic):** #125 ADR-0011 — draft threads persist + bind on first prompt (no
  eager `session/new`; no empty-thread-on-open).

## Remaining slices + dependencies
- **#114 conversation A — [HITL]** — Response (=streamdown) / Message / Bubble / autoscroll. The hard core and the
  biggest visual jump. Needs live `bun run dev` iteration AND a sign-off on streamdown's **HTML-sanitize security
  posture** (streamdown `rehype-sanitize`+`rehype-harden` vs today's escape-everything `ChatMarkdown` — see
  `docs/streamdown-spike.md`). Depends on #111 + #112 (both done).
- **#115 conversation B** (needs #114) — tool rows (t3code `SimpleWorkEntryRow`), a **Collapsible** reasoning block
  (auto-open while streaming), a self-ticking "Working…" indicator.
- **#116 conversation C** (needs #114) — inline approval (restyle `PermissionRow`), a hover actions bar
  (copy/👍/👎/retry), file-path **chip links** (new pure logic — TDD it).
- **#117 composer** (needs #111/#113 — done) · **#118 auth** (needs #111) · **#119 git panel** (needs #111) —
  parallel, AFK-able area restyles onto the primitives.
- Recommended order: knock out the AFK area slices **#117 → #119 → #118** first (visible wins, no HITL), then do
  **#114 → #115 → #116** with the human in the loop. Or start #114 first if the human wants the chat sooner.

## Reference sources for the CONVERSATION work — copy-adapt & OWN in-repo, NEVER add as deps
1. **`docs/design-system-components.md` §2** — THE build reference (exactly what to lift from shadcn + t3code for
   Message/Bubble/Response/ToolRow/Reasoning/Approval/Actions/file-links, and what to STRIP). Read it first.
2. **streamdown** (+ `@streamdown/code`) — the ADOPTED Response/markdown layer (#112). `docs/streamdown-spike.md`
   has the locked #114 plan: `@source '…/streamdown/dist'` + the `@theme inline` shadcn-token map, the `muted`
   token-collision fix, the shiki-dedup lever, and the HTML-sanitize security decision. It's streaming-native +
   shiki + copy built in; it's what shadcn/AI-Elements' `Response` uses.
3. **shadcn/ui** — `/Users/abdullahatrash/mistral/ui/apps/v4/registry/bases/base/ui/`: `message.tsx`, `bubble.tsx`,
   `message-scroller.tsx` (the autoscroll engine — replaces our naive `scrollTop=scrollHeight`), `marker.tsx`. This
   is the **base-ui** variant = our exact stack; swap its `cn-*` theme tokens for our inline Tailwind (the #111 gotcha).
4. **shadcn AI Elements / ai-sdk Elements** (external — WebFetch `https://ai-sdk.dev/elements/overview` if useful):
   the canonical chat-component patterns — Conversation, Message, Response, Reasoning, Tool, Actions, PromptInput.
   Structure only: a discriminated **part-switch** (matches our `ConversationState.items` reducer, ADR-0001). Do
   NOT adopt the AI-SDK message shape — feed our **ACP reducer** data (renderer owns conversation state, ADR-0001).
5. **t3code** — `/Users/abdullahatrash/mistral/t3code/apps/web/src/components/chat/*` + `ChatMarkdown.tsx`: the rich
   chat aesthetic — `SimpleWorkEntryRow` (tool rows), `WorkingTimelineRow` + `WorkingTimer`, `MarkdownFileLink`,
   message bubbles. STRIP its coupling (worktree/checkpoint diffs, Pierre file icons → lucide, `session-logic`
   derivation, `@legendapp/list` virtualization) — see components doc §2.
6. **base-ui** (`https://base-ui.com`) — Collapsible (reasoning), ScrollArea, Tooltip, etc. Our primitives in
   `src/renderer/src/ui/` already wrap these; extend them rather than reaching for base-ui directly in feature code.

## How the human drives it
- After each slice PR: **"merge it then start `<next #>`"** (same tight cadence as the whole epic so far).
- **#114 is HITL** — live-smoke (`bun run dev`) and iterate on the conversation aesthetic; get the security sign-off.
- Net-new features (Search/Scheduled/Plugins nav, terminal, view modes, multi-tool dock, git Environment/Sources)
  stay **static placeholders** — do NOT build their functionality (ADR-0010 scope boundary).

## Guardrails (also in HANDOFF/CLAUDE.md)
- Branch first, never commit to `main`; **targeted `git add <paths>`, never `-A`**; **the user merges**.
- Worktrees use a **real `bun install`**, NOT a `node_modules` symlink (it broke the build once, #64).
- `docs/design-tokens.md` **supersedes** `docs/design/brand.md` (softer orange + rounded, reversing `#fa500f` +
  zero-radius). Use the tokens doc for anything visual.
- Reference repos are **copy-adapt-and-own** — never add t3code/shadcn/AI-Elements as npm deps. New deps this epic:
  `class-variance-authority` (shipped, #111); `streamdown` + `@streamdown/code` (add in #114 per the spike).
- Gates before any slice is done: `bun run lint && bun run typecheck && bun run build && bun run test`.
