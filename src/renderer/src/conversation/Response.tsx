import { useMemo, type JSX } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cn } from '../lib/utils'
import { extractLinkHrefs, fileLinkLabels, isSafeExternalHref, parseFileLink } from './file-link'
import { FileChip } from './FileChip'

/**
 * Renders agent-authored text as streaming-safe Markdown (#114, spike #112). Wraps
 * `streamdown`: it self-heals incomplete markdown as it streams (`parseIncompleteMarkdown`),
 * splits into blocks so completed prose isn't re-highlighted every token, and ships
 * shiki syntax highlighting + a copy control via the `@streamdown/code` plugin.
 * Themed to our tokens through the `@source` + `@theme inline` map in styles.css.
 *
 * SECURITY: agent output is UNTRUSTED. Two layers defend it:
 *  - `skipHtml` drops raw HTML tags the model emits (`<script>`, `<img onerror=…>`) —
 *    keeping the conservative escape-everything posture our old react-markdown wrapper
 *    had (we accept losing benign inline HTML for it). Do not remove `skipHtml`.
 *  - Dangerous LINK hrefs (`javascript:`/`data:`/`vbscript:`) are neutralized by
 *    streamdown's DEFAULT `rehypePlugins` (rehype-sanitize + harden), which render a
 *    `[blocked]` span instead of ever calling our `a` override. **Do NOT pass a custom
 *    `rehypePlugins` prop without re-adding that harden/sanitize chain** — doing so would
 *    silently reintroduce `javascript:`-href XSS. As defence-in-depth (so the `a` override
 *    is safe even if that chain changes) we also allow-list the scheme in `a` below.
 *
 * Two `components` overrides:
 *  - `inlineCode` — resolves the spike's `muted` token collision: streamdown's default
 *    inline code is `bg-muted`, but our `--color-muted` is a text-grey, so we repaint
 *    inline code on `--accent-tint` instead (code BLOCKS use `bg-sidebar`, no collision).
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
      a: ({ href, className: linkClassName, children }) => {
        const link = href ? parseFileLink(href) : null
        if (link) return <FileChip link={link} label={labels.get(link.path) ?? link.basename} />
        // Defence-in-depth: streamdown's harden chain already blocks dangerous hrefs
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
      parseIncompleteMarkdown
      skipHtml
      components={components}
    >
      {text}
    </Streamdown>
  )
}
