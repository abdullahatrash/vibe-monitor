import type { JSX } from 'react'
import { File } from 'lucide-react'
import { cn } from '../lib/utils'
import type { FileLink } from './file-link'

/**
 * The orange file-path chip rendered inline in agent markdown (#114) — a file icon,
 * a (disambiguated) label, and an optional `L12:C3` line ref. A thin, DOM-free
 * consumer of the pure `parseFileLink` result: we deliberately DON'T port t3code's
 * editor-open / `localApi` plumbing, so the chip is a non-navigating affordance
 * (a plain `<span>`, not an `<a>`, so a click can't drive the Electron window). The
 * full path lives in the native `title` tooltip.
 */
export function FileChip({
  link,
  label,
  className,
}: {
  link: FileLink
  label: string
  className?: string
}): JSX.Element {
  const position = link.line ? `L${link.line}${link.column ? `:C${link.column}` : ''}` : null
  return (
    <span
      data-file-chip
      title={link.path}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 align-text-bottom font-mono text-[0.85em] leading-none text-accent-text',
        className,
      )}
    >
      <File className="size-3.5 shrink-0 text-accent-text" aria-hidden />
      <span>{label}</span>
      {position && <span className="text-muted">{position}</span>}
    </span>
  )
}
