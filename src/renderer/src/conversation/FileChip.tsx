import type { JSX } from 'react'
import { File } from 'lucide-react'
import { cn } from '../lib/utils'
import type { FileLink } from './file-link'
import { useOpenFile } from './file-open-context'

/**
 * The orange file-path chip rendered inline in agent markdown (#114) — a file icon,
 * a (disambiguated) label, and an optional `L12:C3` line ref. A thin, DOM-free
 * consumer of the pure `parseFileLink` result.
 *
 * Clickability (#116) is context-driven: when a Conversation provides an `openFile`
 * handler (via {@link useOpenFile}), the chip is a real `<button>` that opens the file
 * (main resolves the path against the Workspace cwd + confines it + `shell.showItemInFolder`); with no
 * handler it degrades to the original non-navigating `<span>` (#114), so the chip stays
 * safe outside a Conversation and we still DON'T port t3code's editor-open/`localApi`
 * plumbing. reveal can't deep-link a line, so the `Lx:Cy` ref is display-only;
 * the full path lives in the native `title` tooltip.
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
  const openFile = useOpenFile()
  const position = link.line ? `L${link.line}${link.column ? `:C${link.column}` : ''}` : null
  const inner = (
    <>
      <File className="size-3.5 shrink-0 text-accent-text" aria-hidden />
      <span>{label}</span>
      {position && <span className="text-muted">{position}</span>}
    </>
  )
  const chipClass = cn(
    'inline-flex items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 align-text-bottom font-mono text-[0.85em] leading-none text-accent-text',
    className,
  )

  if (openFile) {
    return (
      <button
        type="button"
        data-file-chip
        title={link.path}
        onClick={() => openFile(link)}
        className={cn(
          chipClass,
          'cursor-pointer outline-none transition-colors hover:bg-[var(--accent-tint-border)] focus-visible:ring-2 focus-visible:ring-accent/40',
        )}
      >
        {inner}
      </button>
    )
  }

  return (
    <span data-file-chip title={link.path} className={chipClass}>
      {inner}
    </span>
  )
}
