# Files browser: right-panel Surface stack, t3code-style tree+preview, confined renderer-facing fs IPC

**Status: ACCEPTED** (2026-07-02). Builds on **ADR-0002** (thin orchestrator), **ADR-0004** (fs
confinement — extended here to a NEW, stricter surface), **ADR-0006** (shell/nav), **ADR-0008**
(active-Workspace-only side panel, `@pierre/*` adoption). Terms: `CONTEXT.md` **Surface**, **Files
browser**.

## Context

CodexMonitor parity calls for a file browser and the paused `@` file-path autocomplete needs a file
listing the renderer can consume (the renderer has no `fs`; vibe-acp exposes NO file-search RPC — the
Vibe CLI indexes client-side, and the agent expands a plain-text `@path` itself via
`render_path_prompt`). The user's design shows the right panel as a stack of launcher cards — Review
(⌃⇧G), Terminal, Browser, Files (⌘P) — and t3code (our UI north star) ships the exact feature shape:
a `@pierre/trees` tree fed by a flat `{path, kind}[]` listing, with a preview pane beside the tree.

## Decision

1. **The right panel is t3code's Sheet/tab model** (third and FINAL iteration of this decision —
   supersedes both the always-visible stack of #187/#191 and the cards-as-primary toggle of #192;
   reference: t3code `rightPanelStore.ts` + `RightPanelTabs.tsx` + `RightPanelSheet.tsx`). The panel
   owns an ORDERED LIST of open Surface descriptors + an active id + an open flag, scoped
   PER-WORKSPACE (t3code scopes per-Thread; our Threads share the Workspace working tree, so
   Workspace is our unit) and persisted. Open Surfaces render as a TAB STRIP (icon + label + close ×;
   context menu: Close / Close others / Close to the right / Copy path for file tabs); the active
   tab's content shows below. `review` and `files` are singleton kinds; each previewed file is its
   own dynamic `file:<path>` Surface (#189); `terminal`/`browser` kinds are reserved. The panel is
   CLOSED by default and toggled from the window header's PanelRight icon; with ZERO open Surfaces it
   shows the mockup's launcher cards as the EMPTY STATE (Review ⌃⇧G / Terminal / Browser / Files ⌘P,
   the reserved two inert) — opening a Surface replaces cards with tabs, closing the last tab returns
   to them. Shortcuts toggle their Surface from anywhere, opening the panel when closed (⌘P = files,
   ⌃⇧G = review). PRESENTATION is dual, t3code-style: inline beside the conversation on wide windows;
   on narrow windows (≤980px) a **Sheet** — a slide-over from the right edge over the conversation
   with a dimmed backdrop, Esc/outside-click closing (copy-adapt t3code `ui/sheet.tsx` onto our
   base-ui Dialog primitive). Active/connected Workspace only (ADR-0008 precedent).
2. **Files browser = t3code's shape on our stack.** Tree = `@pierre/trees` (new dep; preact/
   shadow-DOM widget, React 19 peer, NO shiki dependency — cannot reintroduce the #159 duplication)
   fed by `files:list`, with SEARCH first-class (the tree's hide-non-matches filter; ⌘P opens the
   Files Surface with search focused). The Files Surface's content is the tree; opening a file from
   it creates a PANEL-LEVEL `file:<path>` Surface tab (#189) whose content is the READ-ONLY preview
   topped by a read-only BREADCRUMB of its path (we simplify t3code here: no explorer column inside
   the file Surface — the tree stays in the Files tab). Preview highlights via the SAME
   `@pierre/diffs` shared-shiki path the git panel uses (one highlighter, already regression-gated by
   #159 tests). Preview actions: Reveal in Finder (reuses the #116 `revealPath` IPC) and Insert
   `@path` into the composer (renderer-only draft append). NOT t3code's editability
   (`EditableFileSurface`): editing means a renderer-facing write IPC, deliberately out of scope.
3. **Two new renderer-facing fs IPCs, BOTH Workspace-confined and symlink-resolved** (the #116
   `open-target.ts` posture): `files:list(workspaceId)` → flat `{path, kind}[]` + `truncated`
   (gitignore-honoring, `.git` skipped, dotfiles included, ~20k-entry cap) and
   `files:read(workspaceId, relativePath)` → `{content} | {binary} | {tooLarge}` (~1MB cap, null-byte
   binary sniff). **This is deliberately STRICTER than ADR-0004**, whose unconfined reads are a
   CLI-parity decision for the *agent's* requests; a renderer-facing surface gets no such parity
   claim, so it is confined. Do not "unify" the two postures.
4. **Refresh is manual + piggybacked, no new watcher.** Main caches the listing per Workspace;
   invalidated by the panel's Refresh button and by the EXISTING git status-stream chokidar watcher
   (#84) firing. Mirrors the Vibe CLI's own default (its `FileIndexer` watcher ships disabled) and
   t3code's manual Refresh + "Indexing…" affordance.
5. **`@` autocomplete matches renderer-side over the shared listing.** Trigger mirrors the CLI
   `PathCompleter` (fragment after the last `@` before the caret, space-free, ≤10 suggestions,
   directories included) on the #95 pure-helper + popover skeleton; ranking is
   substring-then-subsequence over the cached `files:list` result (no per-keystroke IPC). Accepting
   inserts PLAIN TEXT `@path ` — the wire format is untouched; the agent resolves and inlines the
   file server-side. A stale suggestion list is acceptable (same invalidation as the panel).

## Considered options

- **Composer-only (no tree)** — rejected: the design explicitly reserves the Files card, and t3code
  ships both; the tree also gives #185's chips and casual browsing a home.
- **Prompt library in this epic** — dropped by the user; t3code has none (skills/commands already
  surface via `/`, #95). May return as its own PRD.
- **Dedicated index watcher** — rejected for v1: second watcher per Workspace, mass-change storms
  (`bun install`) need thresholds we'd have to own; the git watcher signal is already paid for.
- **Main-side per-keystroke `files:search` IPC** — rejected: the capped flat list ranks in-frame in
  the renderer and stays pure/unit-testable; revisit only if the entry cap proves too small.
- **Editable preview (t3code parity)** — rejected for v1: requires a confined renderer write IPC and
  its own security review; the agent is the editor in this product.
