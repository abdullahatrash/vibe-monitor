# Design-system build reference — what to lift, from where, and how to adapt

Companion to **ADR-0010** (decisions), **`docs/design-tokens.md`** (exact token values), **PRD #109**, and
build issues **#110–#119**. This captures the reusable findings from the t3code + shadcn/ui explorations so
the build session doesn't re-derive them. **Copy-adapt and own in-repo; never add shadcn/t3code as deps.**

Local sources:
- **shadcn/ui** — `/Users/abdullahatrash/mistral/ui`, components under `apps/v4/registry/bases/base/ui/`
  (the **base-ui** variant — imports `@base-ui/react`). Ignore the `radix` base.
- **t3code** — `/Users/abdullahatrash/mistral/t3code`, chat under `apps/web/src/components/chat/*` +
  `components/ChatMarkdown.tsx`; `ui/` primitives under `apps/web/src/components/ui/*`.
- **prototype** — `/Users/abdullahatrash/mistral/Vibe Mistro.html` (exact tokens/layout).

Both t3code and shadcn use **our stack** (Tailwind v4 + `@base-ui/react` + CVA + `cn()` + lucide), so the
primitives are near-liftable. Deps to add: **CVA** (`class-variance-authority`); **streamdown** +
**`@streamdown/code`** if the #112 spike passes; optionally **`use-stick-to-bottom`** (or vendor shadcn's
message-scroller engine).

---

## 1. Primitive library (issue #111) — lift from shadcn `bases/base/ui/`

**Pattern (every primitive):** import headless part from `@base-ui/react/<name>`; wrap each part in a thin
component that adds `data-slot="…"`, merges classes with `cn()`, spreads `...props`, types via
`React.ComponentProps<typeof Primitive.Part>`. Base-ui's composition prop is **`render`** (not Radix
`asChild`); polymorphism via `useRender` + `mergeProps`. Variants via `cva()` only where needed.

**The one gotcha:** shadcn's `bases/base` uses a two-layer model — structural Tailwind inline **+** semantic
`cn-*` theme tokens (e.g. `cn-button-variant-default`) defined in swappable `style-*.css` files. **When
adapting, replace each `cn-*` token with the actual Tailwind utility string** (resolved through OUR tokens).
The CVA *structure* and compound APIs transfer 1:1; only the variant *values* need substituting.

**Button — the CVA exemplar** (`ui/button.tsx`): base `inline-flex shrink-0 items-center justify-center …
outline-none disabled:opacity-50`; **6 variants** (default/outline/secondary/ghost/destructive/link) — add
our **`stop`** (outline, from #103); **8 sizes** (default/xs/sm/lg/icon/icon-xs/icon-sm/icon-lg). Same shape
for Badge/Tabs/Attachment.

**Primitives + their base-ui import:** Button (`/button`, CVA), Input (`/input`), Textarea (native),
DropdownMenu (`/menu` — extend our existing `ui/menu.tsx`), Dialog (`/dialog`), Popover (`/popover`),
Tooltip (`/tooltip`), Tabs (`/tabs`, CVA), ScrollArea (`/scroll-area`), Separator (`/separator`), Avatar
(`/avatar`), Badge (`use-render`, CVA), Collapsible (`/collapsible`), Select (`/select`). App-specific
(hand-build to tokens): **NavItem**, **Panel** (side-panel container), **Card**, **Chip** (borderless
icon+label+chevron — see tokens doc), **IconButton** (Button `size=icon`), **Spinner**. Compound exports
follow the standard shape (Dialog/DialogTrigger/DialogContent…, Menu parts, Select parts).

---

## 2. Conversation (issues #114–#116) — mine t3code, structure from shadcn

**Architecture (keep ours):** both refs use a discriminated-union + switch, NOT deep compound components —
t3code = row `kind` union + one `TimelineRowContent` dispatcher (+ React Context for shared state);
shadcn = `message.parts.map()` switching on `part.type`. This is our `ConversationState.items` (`kind`) +
`Item` switch (ADR-0001). **Keep it**; build the inner pieces as reusable primitives fed by our reducer.

**Message / Bubble** (#114): user = **right-aligned rounded bubble** (`rounded-2xl border bg-secondary p-3`,
`max-w-[80%]`, `items-end`); assistant = **no bubble**, full-width flowing markdown (`px-1 py-0.5`). shadcn's
`Message` takes an `align` prop (`start`/`end`) with `data-align` for descendant styling — role→layout lives
in the caller. This asymmetry matches our mockup.

**Response / markdown** (#114, gated by #112): prefer **streamdown + @streamdown/code** (streaming-native —
renders incomplete markdown safely; shiki highlighting + copy built in; shadcn's Response uses it). Fallback:
`react-markdown` + `remark-gfm`/`remark-breaks` + shiki (t3code's `ChatMarkdown.tsx` is the blueprint — but
they called their shiki+LRU-cache layer their "most over-engineered piece", which streamdown packages).
- **File-path links** (the standout — t3code `MarkdownFileLink` in `ChatMarkdown.tsx`): resolve `href`/path →
  a clickable **chip** (file icon + name + `L12:C3` line ref), orange, with disambiguated labels when
  basenames collide. This is genuinely new **pure logic → TDD it** (href/path → {label, line, col}).
- **Inline code** = subtle grey chip (CSS: 1px border, small radius, `bg var(--muted)`). **Code blocks** =
  header toolbar (file-type icon + title/lang + wrap-toggle + copy) over the highlighted body.
- t3code's markdown styling is a **self-contained global CSS block** (`.chat-markdown-*`, theme-var driven,
  `index.css` ~417–720) — copyable if not using streamdown's styling.

**MessageScroller / autoscroll** (#114): vendor shadcn's engine (`packages/react/src/message-scroller/`) or
use `use-stick-to-bottom`. Provides viewport/content/item + a floating scroll-to-bottom pill; pin newest via
`scrollAnchor` on the latest user turn. Replaces our naive `scrollTop = scrollHeight` effect.

**ToolRow** (#115 — t3code `SimpleWorkEntryRow`, `MessagesTimeline.tsx`): compact `flex items-center gap-1.5
rounded-md px-0.5 py-0.5`, `hover:bg-accent/20` when expandable. **Leading tone-icon** via a name→lucide map
(terminal=command, eye=read, square-pen=edit, globe=web, wrench=mcp, hammer=tool, message-circle=user-input,
bot/zap/check/circle-alert fallbacks) — use an explicit name→component switch (no dynamic import). **Heading**
(`font-medium truncate`) + **dimmed preview** (`text-muted-foreground/55`, suppressed if it dups the heading).
**Right status glyph** (`size-4`): pending→running→done via a turn-in-progress flag → `Check`; failure →
destructive `X`; running = absence of a terminal check while the turn is live. **Map to OUR ACP status**
`pending/in_progress/completed/failed` — this mapping is new pure logic → TDD it. **Expand:** rotating
`ChevronDown` → indented `<pre>` body (`mt-1 ms-7 border-s ps-3 max-h-64 overflow-auto whitespace-pre-wrap
font-mono text-[11px]`); clicks inside `stopPropagation`.

**Reasoning** (#115): a **Collapsible** "thinking" block, **auto-open while streaming**. (t3code renders
reasoning as a dimmed tool-like row; shadcn renders a flat shimmer — we do the collapsible auto-open per
ADR-0010.)

**Working indicator** (#115): t3code `WorkingTimelineRow` — three pulsing dots (`h-1 w-1 rounded-full
bg-muted-foreground/30 animate-pulse` staggered `[animation-delay:200ms/400ms]`) + a **self-ticking**
"Working for 12s" label (`WorkingTimer` updates `textContent` via `setInterval`, no React re-render). Copy
this pattern.

**Approval** (#116 — kept **INLINE**, unlike t3code which puts it in the composer footer): restyle our
existing `PermissionRow`. Map buttons to OUR ACP permission options (allow-once / reject-once / etc.).
t3code's **numbered-option keyboard panel** (`ComposerPendingUserInputPanel` — 1–9 kbd chips, auto-advance,
selected `border-primary/30 bg-primary/8`) is a nice reference if we later render option prompts.

**Actions bar** (#116): hover-reveal (`opacity-0 group-hover:opacity-100 transition-opacity`) — **copy**
(icon→check + **anchored toast** on the button, not inline; t3code `MessageCopyButton`) + **thumbs up/down** +
**retry** (we add thumbs/retry per the mockup; t3code only had copy+revert). Assistant copy hidden while
streaming.

**Strip from t3code** (their coupling — do NOT port): worktree/checkpoint diff summaries, revert/"revert to
message", proposed-plan cards, terminal/element/preview-annotation contexts, skills inline, **Pierre file
icons** (`PierreEntryIcon` → use lucide), `localApi`/editor-open plumbing in file links, the
`session-logic.ts`/`MessagesTimeline.logic.ts` derivation layer (replace with our ACP reducer output), and
the `@legendapp/list` virtualization (optional — our conversations are short; a `.map()` is fine).

---

## 3. Composer / Auth / Git (issues #117–#119)
Straightforward restyles onto §1 primitives; re-home existing behavior (attachments #100 / stop #103 / queue
#106 in the composer). See the issues + tokens doc; no new external component to mine.

## 4. Icons
lucide throughout — the name map is in `docs/design-tokens.md` §Icons. For tool-kind icons, see the ToolRow
name→lucide map above.
