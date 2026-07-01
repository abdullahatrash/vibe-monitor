# Spike #112 — `streamdown` compatibility for the Response/markdown layer

**Status:** COMPLETE · **Date:** 2026-07-01 · **Branch:** `spike/112-streamdown` (off `origin/main` @ `0f4fb1e`)

## VERDICT: **ADOPT** `streamdown` + `@streamdown/code`

Streamdown builds and bundles cleanly under electron-vite's renderer, uses **no Node builtins**,
uses shiki's **JavaScript regex engine (no WASM)** so it is compatible with our strict
`script-src 'self'` CSP, renders incomplete/streaming markdown safely (its purpose), ships syntax
highlighting + a built-in copy control, and themes to our tokens through a **standard Tailwind-v4
`@source` + `@theme inline` semantic-token mapping** — the same shadcn token layer #110/#111
already established. The one real cost is **bundle duplication of shiki** (it pins a different major
than `@pierre/diffs`), and one **token-name collision** (`muted`) that #114 must resolve. Neither is
a blocker. The ADR-0010 fallback (keep `react-markdown` + add shiki ourselves) is **not needed**.

**Versions tested (verified in `node_modules`):**

| package | version |
| --- | --- |
| `streamdown` | **2.5.0** |
| `@streamdown/code` | **1.1.1** |
| shiki (pulled by `@streamdown/code`, nested) | **3.23.0** |
| shiki (pulled by `@pierre/diffs`, top-level) | **4.3.0** |
| react / react-dom | 19.1.0 (peer `^18 || ^19` — satisfied) |

`bun add streamdown @streamdown/code` resolved with **no peer-dep warnings** under React 19.

---

## (d) Build + bundle under electron-vite's renderer — THE headline risk → **PASS**

A throwaway harness (`src/renderer/src/conversation/StreamdownHarness.tsx`, unshipped) imports and
renders `<Streamdown plugins={{ code }} controls={…}>`, wired into `main.tsx` behind a `?spike112`
flag so it is **not tree-shaken**. Full gate run **with the harness present**:

```
bun run lint       → clean (eslint .)
bun run typecheck  → clean (tsc over tsconfig.node.json + tsconfig.web.json)
bun run build      → ✓ built in 3.43s   (electron-vite build, all three targets)
bun run test       → Test Files 36 passed (36) · Tests 495 passed (495)
```

Key build lines (renderer target):

```
../../out/renderer/assets/index-<hash>.js   2,925.90 kB   (main eager chunk, WITH streamdown)
✓ built in 3.43s
```

Why it's safe under our stack:

- **No Node builtins leak.** Streamdown's own chunk statically imports only browser-safe deps
  (`clsx`, `hast-util-to-jsx-runtime`, `html-url-attributes`, `marked`, `react-dom`, `rehype-harden`,
  `rehype-raw`, `rehype-sanitize`, `remark-gfm`, `remark-parse`, `remark-rehype`, `remend`,
  `tailwind-merge`, `unified`, `unist-util-visit*`). The build (which would fail on a Node builtin in
  the renderer) confirms this.
- **No WASM / CSP conflict.** `@streamdown/code` highlights via `shiki/engine/javascript`
  (`createJavaScriptRegexEngine({ forgiving: true })`), **not** the oniguruma WASM engine. Our
  `index.html` CSP is `script-src 'self'` with no `wasm-unsafe-eval`; the JS engine needs neither.
- **No worker conflict with `@pierre/diffs`.** Streamdown does highlighting inline (async promise +
  React state), it does **not** spawn a `?worker`, so it never touches the `worker: { format: 'es' }`
  path `@pierre/diffs` relies on.
- **Mermaid is NOT statically bundled.** Although `mermaid` is a declared dep, streamdown's dist only
  reaches it through a dynamic `import('./mermaid-*.js')` stub gated behind the optional `mermaid`
  plugin. We don't pass that plugin, so mermaid (and its d3 tree) never enters our graph.

## (a) Streaming / incomplete markdown → **PASS** (this is streamdown's whole point)

The harness feeds three partial inputs and they render without breaking layout:

- unterminated code fence (```` ```ts … ```` with no close),
- half-open `**bold` + `[incomplete link`,
- inline `` `spawnSession( ``.

Mechanism, read from source:

- `parseMarkdownIntoBlocks` (backed by `marked`) splits the stream into blocks and re-parses only the
  trailing (in-flight) block, so completed prose isn't re-highlighted every token.
- `parseIncompleteMarkdown` runs **`remend`** ("self-healing markdown"): it auto-closes unterminated
  `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, links/images, and math, and is code-block-aware
  (won't "fix" inside a fence). This is exactly the streaming-safety the ADR wanted.
- `useIsCodeFenceIncomplete` lets the code block defer expensive highlighting until the fence closes.

## (b) Code highlighting + copy → **PASS**

- Highlighting: `@streamdown/code`'s `code` plugin (shiki, JS engine). Default themes
  **`github-light` + `github-dark`** (dual-theme via shiki's `codeToTokens`).
- Copy: built in. `<Streamdown controls={{ code: { copy: true } }}>` renders a `CodeBlockCopyButton`
  (clipboard write + copied-state timeout). Copy controls for tables and download buttons also exist.
  Exposed low-level primitives (`CodeBlock`, `CodeBlockCopyButton`, `CodeBlockHeader`, …) are exported
  if we want to compose our own affordance instead.
- **Shiki is duplicated, not shared** — see bundle section. Streamdown's `github-*` themes differ from
  whatever `@pierre/diffs` uses; the two highlighters are independent.

## (c) Theming to OUR tokens → **PASS, mechanism locked (with one caveat)**

Streamdown ships **no compiled component CSS** (its `styles.css` is 35 lines of animation keyframes
only). It styles everything with **inline shadcn-style Tailwind utility classes** baked into its JSX —
e.g. links are `font-medium text-primary underline`, inline code is
`rounded bg-muted px-1.5 py-0.5 font-mono text-sm`, code-block containers use
`rounded-xl border border-border bg-sidebar`. So theming is the standard shadcn/Tailwind-v4 dance,
which #110/#111 already set up. **Two required moves for #114:**

1. **Scan streamdown's dist** so Tailwind emits those classes (node_modules isn't scanned by default):

   ```css
   @source '../../../node_modules/streamdown/dist';
   ```

2. **Map the shadcn semantic tokens onto our design tokens** in `@theme inline`:

   ```css
   @theme inline {
     --color-primary: var(--accent-text);       /* links + primary text → #cf6a3a */
     --color-primary-foreground: var(--on-accent);
     --color-foreground: var(--text);
     --color-background: var(--bg);
     --color-muted-foreground: var(--muted);
     --font-mono: 'SF Mono', ui-monospace, 'Menlo', monospace;
     /* (--color-border, --color-sidebar already exist from #110) */
   }
   ```

**Proof it works** — with the two additions above, the production build's renderer CSS resolved the
generated streamdown classes straight to our vars:

```css
.text-primary { color: var(--accent-text); }                     /* orange links ✓ */
.text-primary-foreground { color: var(--on-accent); }
.font-mono { font-family: SF Mono, ui-monospace, Menlo, monospace; }  /* our mono stack ✓ */
```

Radius (`rounded`, `rounded-md`, `rounded-xl`) resolves through the `--radius-*` scale #110 already
pins. There is also a `shikiTheme={[light, dark]}` prop and full `components` override map if we ever
want to drive code colors from a hand-built palette instead of github-light/dark.

**CAVEAT — `muted` token collision (#114 must resolve).** shadcn's `muted` is a *light surface bg*
(streamdown uses `bg-muted` for inline-code / code-block backgrounds). But our existing `@theme inline`
already binds `--color-muted: var(--muted)`, where our `--muted` (`#6b645d`) is a *muted-text grey*.
Left as-is, `bg-muted` paints code backgrounds dark grey. #114 must break this collision — options:
(a) give code surfaces their own value via streamdown's `components`/`className` overrides for `code`
and the code-block container (cleanest — keeps our `--color-muted` meaning intact), or
(b) introduce a distinct light-surface token and rewire. Recommend (a).

## Bundle impact → measured, ADOPT-with-eyes-open

Same `bun run build`, harness in vs. out (electron-vite renderer target):

| metric | baseline (no streamdown) | with streamdown | delta |
| --- | --- | --- | --- |
| main **eager** `index.js` | 2,301.08 kB | 2,925.90 kB | **+~625 kB** |
| total renderer `assets/` on disk | 13 MB | 23 MB | +~10 MB |
| chunk count | 313 | 615 | +302 |

- The **+~625 kB eager** is streamdown's markdown pipeline (marked + unified + remark/rehype +
  rehype-raw/sanitize/harden + hast-util + remend). This loads upfront.
- The **+~10 MB / +302 chunks** is almost entirely a **second, duplicated shiki grammar set**:
  `@pierre/diffs` resolves shiki **4.3.0**, `@streamdown/code` pins **`^3.19.0` → 3.23.0**, so every
  language grammar is emitted twice (verified: two `python-*.js`, two `typescript-*.js`, etc.). These
  chunks are **lazy** (loaded per-language on demand), so the runtime/first-paint hit is far smaller
  than the disk number, but the app bundle roughly doubles its shiki payload.
- **Dedup lever for #114 (optional):** `@pierre/diffs` accepts shiki `^3.0.0 || ^4.0.0`. A
  package.json `overrides`/`resolutions` pinning a single shiki 3.x (that also satisfies
  `@streamdown/code`'s `^3.19.0`) would collapse the two grammar sets into one — **needs a regression
  check that `@pierre/diffs` still highlights correctly on shiki 3.x** before committing to it.

---

## What #114 should do (locked decision)

1. `bun add streamdown@2.5.0 @streamdown/code@1.1.1`.
2. Replace `ChatMarkdown` internals with `<Streamdown plugins={{ code }} controls={{ code: { copy: true } }} parseIncompleteMarkdown mode="streaming">`, keeping the `.chat-md` wrapper for block spacing or migrating it to streamdown's `className`.
3. Add `@source '…/node_modules/streamdown/dist'` + the `@theme inline` semantic-token mappings above.
4. **Resolve the `muted` collision** (recommend: override `code` + code-block container via streamdown's `components`/`className` so our code bg is `--accent-tint`/`--panel`, not `bg-muted`).
5. Consider the shiki-dedup `overrides` (with a `@pierre/diffs` highlighting regression check).
6. Re-confirm the security posture (see caveats): streamdown **sanitizes** raw HTML rather than escaping it like our current `ChatMarkdown`.

## Caveats / needs-live-confirmation

- **[needs live `bun run dev`]** Actual *rendered* syntax highlighting + a working copy-button click in
  the Electron window. The spike proves it *bundles* and uses the CSP-safe JS engine and that the copy
  primitive exists, but a running window was not available to this spike (dev can't run headless here).
  Lead should smoke `?spike112` (or the #114 wiring) once.
- **[security posture change]** Our current `ChatMarkdown` deliberately **escapes** all embedded HTML
  (no `rehype-raw`). Streamdown instead **renders raw HTML through `rehype-sanitize` + `rehype-harden`**
  (allowlist). For untrusted agent output this is a different (still-defended, but not
  escape-everything) posture. #114 must confirm the hardened allowlist is acceptable, or restrict via
  `allowedTags` / `disallowedElements` / `skipHtml`.
- **Bundle:** ship-as-is doubles the shiki grammar payload (lazy). Acceptable, but the dedup lever
  above is the recommended follow-up.

## Cleanup note

This spike lands **doc-only**. The `streamdown`/`@streamdown/code` deps, the `StreamdownHarness.tsx`
harness, and the `main.tsx`/`styles.css` spike edits were used to build-verify the above and are left
**unstaged** in the worktree (they die on cleanup). Only this file is committed.
