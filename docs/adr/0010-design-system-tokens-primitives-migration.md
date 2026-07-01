# The design-system epic: adopt the final-design tokens on our CSS-vars→`@theme` hybrid, build base-ui + CVA primitives, keep the conversation's discriminated-union model, and migrate the UI area-by-area (behavior-identical)

vibe-mistro grew its UI slice-by-slice on the #61 stack (Tailwind v4 + `@base-ui/react` + lucide),
accumulating ~1230 lines of BEM-ish classes in `styles.css` and a deliberately sharp (`--radius: 0`)
look. Before the app grows further, we run a **design-system epic**: lock a token layer + a shared
primitive library, and migrate the existing UI onto them to match the user's **final-design prototype**
(`Vibe Mistro.html`) and mockups — pixel-perfect, area by area. This ADR records the load-bearing calls;
`docs/design-tokens.md` holds the exact token values.

References mined (all local): the design **prototype** `/Users/abdullahatrash/mistral/Vibe Mistro.html`
(exact tokens) + the PNG mockups; **t3code** `/Users/abdullahatrash/mistral/t3code` (rich chat aesthetic,
near-identical stack); **shadcn/ui** `/Users/abdullahatrash/mistral/ui` (`apps/v4/registry/bases/base/` —
base-ui primitives + the message/scroller/bubble/marker primitives).

## Decisions

- **Scope boundary: design system + restyle-what-exists; net-new features are static placeholders.** This
  epic ships the token/theme layer, the primitive library, the layout shells, and a pixel-perfect
  restyle/rebuild of the areas we ALREADY have (shell/sidebar, conversation+composer, auth, git panel).
  The mockups' net-new features — Search / Scheduled / Plugins, account+tier, the **terminal**, the
  side-panel **view modes**, the multi-tool dock (Review / Terminal / Browser / Files), the git
  "Environment / Sources" concepts — render as **static/placeholder chrome** so the look is complete, but
  their functionality is deferred to their own later feature epics. This keeps every area a
  behavior-identical migration.

- **Token strategy: keep the CSS-vars → `@theme inline` hybrid; re-populate it with the prototype's exact
  values.** The plumbing (CSS custom properties in `:root` as the single source of truth, bridged into
  Tailwind v4 so both hand-written CSS and `bg-accent`/`text-muted` utilities resolve to the same vars) is
  already correct — we change VALUES, not architecture. Adopt the prototype wholesale: the **warm neutral
  ramp** (bg `#fbfaf8` · sidebar `#f5f3ef` · card `#fdfcfb` · white panel · warm borders), a **rounded
  radius scale** (7 buttons · 9 rows · 10 nav · 12 pill · 20 card · full circle — reversing today's
  `--radius: 0`), the **softer, gradient-forward orange** (`#cf6a3a` interactive text, `#e07a3e` heading
  emphasis, + the logo/send/avatar gradients — NOT the old bright `#fa500f`), a **type scale**, and a
  **spacing scale**. Exact values: `docs/design-tokens.md`. Rejected: pure-Tailwind-`@theme` (loses the
  var indirection our hand-written CSS needs) and pure-CSS-vars (throws away utilities already in use).

- **Styling convention: a primitive component library on base-ui + Tailwind + CVA; retire BEM
  area-by-area.** Grow `src/renderer/src/ui/` (today just `menu.tsx`) into the library: headless behavior
  from `@base-ui/react` (the `render`-prop / `useRender`+`mergeProps` slot pattern), styled with Tailwind
  utilities resolved through our token vars, composed via `cn()` (clsx + tailwind-merge, already deps),
  with variants declared in **CVA** (new dep). Consumers write `<Button variant="ghost">` / `<Chip>` /
  `<Panel>` — never hand-rolled class strings. `styles.css` shrinks to tokens (`:root` + `@theme`), global
  resets, the custom scrollbar, and the `vmCursorBlink` keyframe. **Copy-adapt, own it:** lift component
  source from shadcn `bases/base/ui/` (swapping their `cn-*` theme-token indirection for our inline
  Tailwind utility strings) and t3code's `ui/` — we vendor + restyle, never add shadcn as a dependency.
  Rejected: keeping BEM-first (the growing-`styles.css` maintainability problem this epic exists to fix);
  pure inline utilities with no primitives (class soup, no canonical component look, pixel drift).

- **Conversation: keep the discriminated-union item model + switch dispatcher; build the inner pieces as
  reusable primitives.** Both references converge on this — t3code uses a row-`kind` union + one
  dispatcher; shadcn maps `message.parts` switching on `part.type` — and it matches our existing
  `ConversationState.items` (`kind`) + `Item` switch (ADR-0001, renderer owns conversation state). So we do
  NOT adopt a deep compound-component API; composability comes from the **primitive layer + the part
  switch**. Build/restyle: **MessageScroller** (autoscroll — vendor shadcn's engine or `use-stick-to-bottom`,
  replacing the naive `scrollTop=scrollHeight`), **Message/Bubble** (user = right bubble, assistant =
  full-width flowing markdown — both refs + the mockup agree), **Response** (markdown — see next), **ToolRow**
  (t3code's compact tone-icon + heading + dimmed preview + right status glyph + chevron→indented `<pre>`;
  map its status to our ACP `pending/in_progress/completed/failed`), **Reasoning** (a `Collapsible`
  "thinking" block, auto-open while streaming), **Approval** (our `PermissionRow` restyled — kept **inline**
  in the conversation, NOT in the composer footer like t3code, matching our app + mockup), an **Actions**
  bar (hover-reveal copy/👍/👎/retry with an anchored toast), **file-path chip links** (t3code's pattern:
  path → icon chip + `L12:C3`, orange, clickable), and a **Working** indicator (pulsing dots + self-ticking
  timer). We feed all of these OUR ACP reducer data, not any AI-SDK message shape.

- **Markdown/Response layer: adopt `streamdown` + `@streamdown/code`, contingent on a compat spike.**
  Replace the current `react-markdown` `ChatMarkdown` with streamdown — it is *streaming-native* (renders
  incomplete markdown safely mid-stream) with shiki code highlighting + copy built in, purpose-built for a
  streaming agent, and is what shadcn's Response uses (t3code hand-rolled the same thing and called it their
  "most over-engineered piece"). **Gate:** a quick spike at the start of the conversation slice must confirm
  streamdown themes to our tokens and works under Electron/Vite before we commit; the fallback is keeping
  `react-markdown` and adding shiki ourselves. This is the only decision here with an open verification.

- **Migration strategy: area-by-area, behavior-identical, in dependency order.** Not big-bang. Order:
  (1) **Foundation** — tokens repopulated + scales, `cn()` (have it) + CVA, the base primitives;
  (2) **Shell** — sidebar (nav / projects+threads / account chip), main layout, window chrome (new nav +
  account as placeholders); (3) **Conversation** — the hard core, sub-sliced (Response/markdown →
  tool/reasoning → approval/actions/file-links); (4) **Composer** — card (empty+active), mode/model/effort
  controls, context chips, re-homing the existing attachments (#100), stop (#103), queue (#106) onto
  primitives; (5) **Auth**; (6) **Git/"Review" panel**. Each area restyles AND retires its BEM classes, and
  keeps its tests green (behavior unchanged — this is a restyle, not a rewrite of logic).

## Considered alternatives

- **Treat this as pure design-system consolidation (tokens + primitives) without restyling to the new
  mockups.** Rejected: the user has final designs and wants the UI to match them now; consolidating without
  moving the look would force re-migration later.
- **Pure Tailwind `@theme` tokens / pure CSS-vars (drop the hybrid).** Rejected — see token decision.
- **Deep compound components for the conversation (`<Message><Message.Content/>`, à la the classic AI
  Elements).** Rejected: neither best-in-class reference does it, and it fights our reducer-item model
  (ADR-0001). Reusable primitives + a part switch give the composability without the ceremony.
- **Keep `react-markdown`/`ChatMarkdown`, add shiki ourselves.** Held as the streamdown fallback; rejected
  as the default because it re-implements what streamdown packages for streaming.
- **Build the deferred features (terminal, view modes, Search/Plugins) inside this epic.** Rejected: scope
  explosion; they are their own feature epics. This epic only makes their chrome look right.
