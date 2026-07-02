import { useEffect, useState, type JSX } from 'react'
import { getFiletypeFromFileName, getSharedHighlighter } from '@pierre/diffs'
import { AtSign, FolderOpen } from 'lucide-react'
import type { FilesReadResult } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { emitComposerInsert } from '../conversation/composer-insert'
import { breadcrumbSegments } from './breadcrumb-segments'

/**
 * The read-only file preview for a `file:` Surface (#189, ADR-0013 decision 2; CONTEXT.md "Files
 * browser"). Given the warm agent handle + a tree-relative path, it fetches the confined
 * `files:read` IPC and renders the outcome: TEXT is syntax-highlighted read-only; BINARY /
 * TOO-LARGE / ERROR each render a clear muted notice (never garbage). Topped by a read-only,
 * non-interactive BREADCRUMB of the path and two header actions — Reveal in Finder (the confined
 * #116 `revealPath` IPC) and Insert `@path` into the composer (renderer-only, #189).
 *
 * Highlighting reuses the EXACT `@pierre/diffs` shared-shiki path the git diff panel uses (#159's
 * single pinned shiki) — `getSharedHighlighter` + `codeToHtml` with the diff panel's `pierre-light`
 * theme — so NO new highlighting dependency is added and the preview matches the diff panel's theme.
 * The language is derived from the filename via the lib's `getFiletypeFromFileName`. This is strictly
 * READ-ONLY: it only ever calls `files:read` / `revealPath`, never any write path.
 */

/** The diff panel's theme (`DiffWorkerProvider`'s `DIFF_THEME`) — reused so the preview matches it. */
const PREVIEW_THEME = 'pierre-light'

/** Highlight `content` to a `<pre>` HTML string via the shared shiki, or `null` to fall back to plain. */
async function highlightToHtml(content: string, fileName: string): Promise<string | null> {
  try {
    const lang = getFiletypeFromFileName(fileName)
    const highlighter = await getSharedHighlighter({ themes: [PREVIEW_THEME], langs: [lang] })
    return highlighter.codeToHtml(content, { lang, theme: PREVIEW_THEME })
  } catch {
    return null // unknown/unloadable grammar — the caller renders the raw text instead
  }
}

export function FilePreview({
  agentId,
  relativePath,
  activeThreadId,
}: {
  /** The warm agent handle — `files:read` / `revealPath` resolve the Workspace root from it (F3). */
  agentId: string
  /** The tree-relative path of the file to preview (from a `filesList` entry). */
  relativePath: string
  /** The live Thread whose composer receives an Insert-@path (null when none is mounted). */
  activeThreadId: string | null
}): JSX.Element {
  const [result, setResult] = useState<FilesReadResult | null>(null)
  const [html, setHtml] = useState<string | null>(null)

  // Fetch the file on mount / path change. Cancellation-guarded so a fast tab switch never lands a
  // stale result. Any rejection degrades to `error` (the handler itself never rejects, but the IPC
  // round-trip could) — the preview then shows the read-error notice rather than hanging on "Loading".
  useEffect(() => {
    let cancelled = false
    setResult(null)
    setHtml(null)
    window.api
      .filesRead({ agentId, relativePath })
      .then((r) => {
        if (!cancelled) setResult(r)
      })
      .catch(() => {
        if (!cancelled) setResult({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [agentId, relativePath])

  // Highlight text results off the render path; a failure leaves `html` null → the raw-text fallback.
  useEffect(() => {
    if (result?.kind !== 'text') return
    let cancelled = false
    const fileName = relativePath.slice(relativePath.lastIndexOf('/') + 1)
    void highlightToHtml(result.content, fileName).then((h) => {
      if (!cancelled) setHtml(h)
    })
    return () => {
      cancelled = true
    }
  }, [result, relativePath])

  const crumbs = breadcrumbSegments(relativePath)

  return (
    <div className="flex min-h-0 flex-1 flex-col self-stretch border-l border-border bg-panel text-text">
      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2">
        {/* Read-only, non-interactive breadcrumb of the file's path. */}
        <nav aria-label="File path" className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-muted">
          {crumbs.map((crumb, index) => (
            <span key={index} className="flex min-w-0 items-center gap-1">
              {index > 0 && <span className="text-faint">/</span>}
              <span
                className={cn(
                  'truncate',
                  index === crumbs.length - 1 && !crumb.ellipsis && 'text-text-strong',
                )}
              >
                {crumb.label}
              </span>
            </span>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => void window.api.revealPath({ agentId, path: relativePath })}
          title="Reveal in Finder"
          aria-label="Reveal in Finder"
          className="shrink-0 rounded-md p-1 text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10"
        >
          <FolderOpen size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => {
            if (activeThreadId) emitComposerInsert(activeThreadId, relativePath)
          }}
          disabled={!activeThreadId}
          title="Insert @path into composer"
          aria-label="Insert @path into composer"
          className="shrink-0 rounded-md p-1 text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10 disabled:opacity-40"
        >
          <AtSign size={14} aria-hidden />
        </button>
      </div>

      <PreviewBody result={result} html={html} />
    </div>
  )
}

/** The body: highlighted text, the raw-text fallback, or a muted notice per non-text outcome. */
function PreviewBody({
  result,
  html,
}: {
  result: FilesReadResult | null
  html: string | null
}): JSX.Element {
  if (result === null) return <Notice>Loading…</Notice>
  switch (result.kind) {
    case 'binary':
      return <Notice>Binary file — can’t preview.</Notice>
    case 'tooLarge':
      return <Notice>File too large to preview.</Notice>
    case 'error':
      return <Notice>Could not read file.</Notice>
    case 'text':
      return (
        <div className="min-h-0 flex-1 overflow-auto text-[12.5px] leading-relaxed [&_pre]:min-h-full [&_pre]:p-3">
          {html !== null ? (
            // Highlighted HTML from the shared shiki (the diff panel's exact path). The `<pre>`
            // carries its own theme background; we only add padding/scroll around it.
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            // Fallback before highlighting resolves / for an unhighlightable grammar: raw text,
            // React-escaped by construction.
            <pre className="whitespace-pre p-3 font-mono">{result.content}</pre>
          )}
        </div>
      )
  }
}

/** A centered muted message for the non-text (and loading) states. */
function Notice({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-[13px] text-muted">
      {children}
    </div>
  )
}
