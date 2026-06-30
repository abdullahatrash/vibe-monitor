import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { cn } from '../lib/utils'

/**
 * Renders agent-authored text as GitHub-flavoured Markdown (tables, task lists,
 * autolinks via `remark-gfm`; single newlines as `<br>` via `remark-breaks`, to
 * match how chat output is typed).
 *
 * SECURITY: agent output is UNTRUSTED. We deliberately do NOT enable `rehype-raw`
 * or any raw-HTML pass — react-markdown's default escapes embedded HTML, so a
 * model echoing `<script>`/`<img onerror=…>` renders as inert text. Do not add a
 * raw-HTML rehype plugin here.
 *
 * Visuals come from the scoped `.chat-md` rules in styles.css (brand tokens, square
 * code blocks, accent-text links) so this stays a thin wrapper.
 */
export function ChatMarkdown({
  text,
  className,
}: {
  text: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('chat-md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
    </div>
  )
}
