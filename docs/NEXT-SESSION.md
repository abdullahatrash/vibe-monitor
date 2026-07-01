# Next session — kickoff for the design-system epic

Open a fresh Claude Code session **in `/Users/abdullahatrash/mistral/vibe-mistro`** (so `main` is the cwd) and
paste the block below as the first message. It auto-loads `CLAUDE.md` + the memory index on launch.

## Paste this

> Read `HANDOFF.md`, then `docs/adr/0010-design-system-tokens-primitives-migration.md` +
> `docs/design-tokens.md` + `docs/design-system-components.md`. We're building the **design-system epic**
> (issues #110–#119, parent PRD #109). First confirm the baseline: on `main`, run the four gates
> (`export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$HOME/.local/bin:$PATH"; bun run lint && bun run
> typecheck && bun run build && bun run test`) → expect **495 tests green**. Then **start issue #110 (token
> layer)**: `GH_HOST=github.com gh issue view 110`, and build it via the **team loop in HANDOFF §3** —
> manual worktree with a **real `bun install`** (never a node_modules symlink), an implementer agent (the
> issue carries `/tdd`), your own **independent verification** (re-run all four gates + read the diff), an
> **adversarial review**, fold fixes, **targeted `git add` (never `-A`)**, push, and **I'll merge**. It's a
> **behavior-identical restyle** — the 495 tests must stay green.

## Slice order & dependencies

`#110` token layer (—) → `#111` primitives (base-ui+CVA, needs #110) → `#113` shell (#110,#111).
`#112` streamdown spike (#110) → `#114` conversation A **[HITL — live-smoke + iterate on the chat]**
(#111,#112) → `#115` conversation B (#114) / `#116` conversation C (#114).
`#117` composer (#111,#113) · `#118` auth (#111) · `#119` git panel (#111) — parallel once #110/#111 land.

## How the human drives it
- After each slice PR: **"merge it then start `<next unblocked #>`"** (same cadence as the composer epic).
- **#114 is HITL** — live-smoke (`bun run dev`) and iterate on the conversation aesthetic (the pixel-perfect
  part that matters most). The rest are AFK to the mockups with a quick smoke.
- Net-new features (Search/Scheduled/Plugins, terminal, view modes, dock, git Environment/Sources) stay
  **static placeholders** — don't let the agent build their functionality.

## Guardrails (also in HANDOFF/CLAUDE.md)
- Branch first, never commit to `main`; **targeted `git add <paths>`, never `-A`**; **user merges**.
- Worktrees use a **real `bun install`**, NOT a `node_modules` symlink (it broke the build once).
- `docs/design-tokens.md` **supersedes** the old `docs/design/brand.md` (softer orange + rounded, reversing
  `#fa500f` + zero-radius). Use the tokens doc for anything visual.
- Reference repos (HANDOFF §4) are **copy-adapt-and-own** — never add as npm deps: t3code + shadcn `ui/`
  (`/Users/abdullahatrash/mistral/ui`, `apps/v4/registry/bases/base/`) + mistral-vibe (`vibe/acp/`).
- Gates before any slice is done: `bun run lint && bun run typecheck && bun run build && bun run test`.
