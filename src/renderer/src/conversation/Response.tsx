import { useMemo, type JSX } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cn } from '../lib/utils'
import { extractLinkHrefs, fileLinkLabels, isSafeExternalHref, parseFileLink } from './file-link'
import { FileChip } from './FileChip'
import { responseRehypePlugins } from './response-rehype'

/**
 * Renders agent-authored text as streaming-safe Markdown (#114, spike #112). Wraps
 * `streamdown`: it self-heals incomplete markdown as it streams (`parseIncompleteMarkdown`),
 * splits into blocks so completed prose isn't re-highlighted every token, and ships
 * shiki syntax highlighting + a copy control via the `@streamdown/code` plugin.
 * Themed to our tokens through the `@source` + `@theme inline` map in styles.css.
 *
 * SECURITY: agent output is UNTRUSTED. The `rehypePlugins` below is streamdown's own default
 * `[raw, sanitize, harden]` chain, minimally reconfigured for #168 — see `response-rehype.ts` for
 * the full rationale. Each layer:
 *  - `sanitize` (`rehype-sanitize`) is the XSS wall: it drops raw HTML tags the model emits
 *    (`<script>`, `<img onerror=…>`) and STRIPS the href off `javascript:`/`data:`/`vbscript:`
 *    links before render. `skipHtml` (still set below) is belt-and-suspenders on top of it.
 *  - `harden` (`rehype-harden`) origin-checks external link/image URLs. #168 wraps it so ONLY
 *    file-path anchors bypass it (reaching the `a` override unrewritten so `FileChip` can render);
 *    every dangerous or external href still goes through harden exactly as before.
 *  - the `a` override below is the final layer: it renders a file path as a `FileChip` and only
 *    emits a real anchor for an `isSafeExternalHref` scheme, so it can't become a `javascript:` sink
 *    even if the chain upstream ever changes.
 * We pass `responseRehypePlugins` because the `rehypePlugins` prop REPLACES streamdown's defaults;
 * **do NOT drop `raw`/`sanitize` from that list** — either would reintroduce raw-HTML/href XSS.
 * Do not remove `skipHtml` either.
 *
 * Three `components` overrides:
 *  - `inlineCode` — resolves the spike's `muted` token collision: streamdown's default
 *    inline code is `bg-muted`, but our `--color-muted` is a text-grey, so we repaint
 *    inline code on `--accent-tint` instead (code BLOCKS use `bg-sidebar`, no collision).
 *  - `thead` — same collision (#162): streamdown fills the table header row with
 *    `bg-muted/80`, which our text-grey `--color-muted` renders as ~80% dark warm-grey.
 *    Repaint the one colliding class onto `bg-sidebar` (the same warm-light container
 *    surface code BLOCKS use); the `th` cells keep streamdown's default border/padding/
 *    font-weight untouched. Fixed here, NOT in the token map — `--color-muted` must stay
 *    a text-grey everywhere else it's used.
 *  - `a` — turns file-path destinations into an orange `FileChip`; other links stay
 *    plain accent-underlined anchors (opened in the system browser).
 */
export function Response({ text, className }: { text: string; className?: string }): JSX.Element {
  // Disambiguate basenames across THIS message once: an `a` override renders each
  // link independently, so we pre-derive the label map from the full text and close
  // over it (pure `file-link` logic; DOM-free).
  const components = useMemo<Components>(() => {
    const paths: string[] = []
    for (const href of extractLinkHrefs(text)) {
      const link = parseFileLink(href)
      if (link) paths.push(link.path)
    }
    const labels = fileLinkLabels(paths)

    // Only bind the props we forward — leaving `node` (and other react-markdown
    // ExtraProps) undestructured keeps them off the DOM element AND lint-clean.
    return {
      inlineCode: ({ className: codeClassName, children }) => (
        <code
          className={cn(
            'rounded-md border border-border bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-[0.85em]',
            codeClassName,
          )}
        >
          {children}
        </code>
      ),
      // Repaint only streamdown's colliding `bg-muted/80` (see header comment, #162);
      // `data-streamdown="table-header"` kept for parity with streamdown's default markup.
      thead: ({ className: theadClassName, children }) => (
        <thead data-streamdown="table-header" className={cn('bg-sidebar', theadClassName)}>
          {children}
        </thead>
      ),
      a: ({ href, className: linkClassName, children }) => {
        const link = href ? parseFileLink(href) : null
        if (link) return <FileChip link={link} label={labels.get(link.path) ?? link.basename} />
        // Defence-in-depth: the sanitize/harden chain already strips dangerous hrefs
        // before we get here, but only render a real anchor for an allow-listed scheme
        // so a future config change can't turn this override into a `javascript:` sink.
        // A rejected scheme renders as inert text (no href), never a clickable link.
        if (!isSafeExternalHref(href)) return <span className={linkClassName}>{children}</span>
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={cn('font-medium text-accent-text underline', linkClassName)}
          >
            {children}
          </a>
        )
      },
    }
  }, [text])

  return (
    <Streamdown
      className={cn('min-w-0 [&>:first-child]:mt-0 [&>:last-child]:mb-0', className)}
      plugins={{ code }}
      controls={{ code: { copy: true } }}
      rehypePlugins={responseRehypePlugins}
      parseIncompleteMarkdown
      skipHtml
      components={components}
    >
      {text}
    </Streamdown>
  )
}
