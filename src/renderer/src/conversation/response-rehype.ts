import { defaultRehypePlugins } from 'streamdown'
import type { Pluggable, PluggableList } from 'unified'
import { parseFileLink } from './file-link'

/**
 * The rehype (HTML-AST) plugin chain for {@link Response} (#168).
 *
 * Streamdown's DEFAULT chain is `[raw, sanitize, harden]` (in that order — see
 * `defaultRehypePlugins`, a `Record<'raw'|'sanitize'|'harden', Pluggable>`):
 *  - `raw`      — `rehype-raw`: parses any raw HTML the model emitted into real hast nodes.
 *  - `sanitize` — `rehype-sanitize` with streamdown's GitHub-derived schema. THIS is the XSS
 *                 wall: its tag/attribute allow-list drops `<script>`/`<iframe>`/`on*` handlers,
 *                 and its `protocols.href` allow-list (http/https/irc/ircs/mailto/xmpp/tel) STRIPS
 *                 the href off `javascript:`/`data:`/`vbscript:` links before anything renders.
 *  - `harden`   — `rehype-harden`: origin-validates external link/image URLs (streamdown wildcards
 *                 to all http(s)), forces `target=_blank rel=noopener`, and permits `data:` images.
 *
 * THE PROBLEM (#168): `harden` is configured `defaultOrigin: undefined`, so a file-path href
 * (`test.txt`, `src/x.ts:42`, `./x`, `/abs/x.ts`) either fails URL parsing outright (bare names)
 * or is rewritten to a bare pathname (dot-relative/absolute). Bare names are replaced with a
 * `[blocked]` span BEFORE our `a` override runs, so the `FileChip` override never fires. There is
 * no `harden` option that passes a file path through unrewritten.
 *
 * THE FIX — {@link guardFilePathAnchors}: we reproduce the exact default chain but wrap the real
 * streamdown `harden` transformer so anchors whose href our own `parseFileLink` recognises as a
 * file path are hidden from harden (retagged `<a>`→`<span>`, which harden ignores) and restored to
 * `<a href=…>` — byte-for-byte unrewritten — immediately after. Everything harden used to do to
 * external links and images is untouched; only inert file-path hrefs bypass it, reaching the `a`
 * override with their original string so `parseFileLink` (its 26-test contract) matches as before.
 *
 * Why the bypass is safe (defence in depth, three layers):
 *  1. `sanitize` runs FIRST and unconditionally, so by the time our guard runs any dangerous-scheme
 *     href is already stripped (verified end-to-end: a `javascript:` link reaches harden as
 *     `href: undefined`). `parseFileLink` only ever returns non-null for a *scheme-less* path
 *     (it rejects anything matching an external scheme), so a dangerous href can neither reach the
 *     guard with its scheme intact nor be classified as a file link to bypass harden.
 *  2. Anything the guard lets through is still an inert, scheme-less path — not an executable URL.
 *  3. The `a` override in {@link Response} re-checks every surviving href against `isSafeExternalHref`
 *     and renders a `FileChip` (a non-navigating reveal) or an allow-listed anchor only.
 *
 * Consumed via `<Streamdown rehypePlugins={responseRehypePlugins}>`. NOTE: the `rehypePlugins` prop
 * REPLACES streamdown's defaults (it does not append), which is why this list re-supplies `raw` and
 * `sanitize` UNCHANGED — dropping either would reintroduce raw-HTML / `javascript:`-href XSS.
 */

/** The minimal slice of the hast node shape this guard reads or mutates. */
interface HastNode {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type HastTransformer = (tree: HastNode) => void

/** Private property key we stash a file-path href under while harden runs. Double-underscored so it
 *  can never collide with a real hast property name produced from markdown. */
const STASHED_HREF = '__vibeFileLinkHref'

function hrefString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Depth-first visit of every `element` node, parents before children. */
function visitElements(node: HastNode, visit: (element: HastNode) => void): void {
  if (node.type === 'element') visit(node)
  if (node.children) for (const child of node.children) visitElements(child, visit)
}

/**
 * Wrap streamdown's `harden` plugin so file-path anchors bypass it. `hardenEntry` is streamdown's
 * `defaultRehypePlugins.harden` — a `[attacher, options]` tuple; we reuse BOTH so harden keeps its
 * exact configured behaviour for every non-file-path link and image.
 */
function guardFilePathAnchors(hardenEntry: Pluggable): Pluggable {
  if (!Array.isArray(hardenEntry)) {
    // Fail loud if streamdown's shape changes, rather than silently shipping without harden.
    throw new Error('streamdown defaultRehypePlugins.harden is not the expected [plugin, options] tuple')
  }
  const [hardenAttacher, hardenOptions] = hardenEntry as [(options: unknown) => HastTransformer, unknown]

  return function guardedHarden(this: unknown): HastTransformer {
    const runHarden = hardenAttacher(hardenOptions)
    return (tree) => {
      const hidden: HastNode[] = []
      visitElements(tree, (element) => {
        if (element.tagName !== 'a') return
        const properties = (element.properties ??= {})
        if (!parseFileLink(hrefString(properties.href))) return
        properties[STASHED_HREF] = properties.href
        element.tagName = 'span' // harden only rewrites <a>/<img>; a <span> passes through untouched.
        hidden.push(element)
      })

      runHarden(tree)

      for (const element of hidden) {
        element.tagName = 'a'
        const properties = element.properties ?? {}
        properties.href = properties[STASHED_HREF]
        delete properties[STASHED_HREF]
      }
    }
  }
}

const { raw, sanitize, harden } = defaultRehypePlugins as Record<'raw' | 'sanitize' | 'harden', Pluggable>

/** streamdown's default `[raw, sanitize, harden]` chain, with `harden` wrapped so file-path anchors
 *  reach the `Response` `a` override unrewritten (#168). `raw` and `sanitize` are UNCHANGED. */
export const responseRehypePlugins: PluggableList = [raw, sanitize, guardFilePathAnchors(harden)]
