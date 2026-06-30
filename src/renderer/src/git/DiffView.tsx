import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import type { GitDiffResult } from '../../../shared/ipc'
import { cn } from '../lib/utils'

/**
 * The working-tree diff viewer for ONE changed file (#85, ADR-0008). Fetches the raw
 * unified-diff for `file` via `window.api.gitDiff`, then renders it with `@pierre/diffs`'
 * `PatchDiff` (parsing happens in the lib's worker, off the main thread). Read-only —
 * no review-comment annotations. Mounted by `ChangesPanel` inside `DiffWorkerProvider`
 * when the panel is in DIFF mode; `onBack` returns to the file list.
 *
 * Two toggles, both light-touch:
 *  - STACKED ↔ SPLIT: a pure render option (`diffStyle`), no re-fetch — the same patch
 *    re-lays-out unified vs side-by-side.
 *  - WHITESPACE: @pierre can't ignore whitespace on a pre-parsed patch, so this drives a
 *    fresh `gitDiff` read with `-w` (a new `diffHash`); the effect re-runs on the flag.
 *
 * The rendered `PatchDiff` is memoized on `diffHash` (+ `diffStyle`) so unrelated panel
 * re-renders (status stream ticks, a sibling toggle) don't churn the diff subtree.
 * Degrades to a quiet "No changes to show" for an empty patch (clean / failed read).
 */
export function DiffView({
  workspaceDir,
  file,
  onBack,
}: {
  workspaceDir: string
  file: { path: string; untracked: boolean; insertions: number; deletions: number }
  onBack: () => void
}): JSX.Element {
  const [diffStyle, setDiffStyle] = useState<'unified' | 'split'>('unified')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [result, setResult] = useState<GitDiffResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // CLEAR the prior patch up front so a re-fetch (whitespace toggle, or the file
    // changing on disk) shows the Loading state instead of the stale diff under the
    // already-updated header. The churn (`insertions`/`deletions`) is in the deps so
    // an open diff RE-FETCHES when the agent (or the user) edits the file — the
    // streamed status update bumps the churn → fresh diff, no manual refresh needed.
    setResult(null)
    setLoading(true)
    void window.api
      .gitDiff({ workspaceDir, path: file.path, untracked: file.untracked, ignoreWhitespace })
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceDir, file.path, file.untracked, ignoreWhitespace, file.insertions, file.deletions])

  const patch = result?.patch ?? ''
  const diffHash = result?.diffHash ?? ''

  // Memoize the rendered diff on its content hash + render style: an unchanged file
  // skips re-creating the (worker-backed) PatchDiff subtree on unrelated re-renders.
  const rendered = useMemo(() => {
    if (!patch) return null
    return (
      <PatchDiff
        patch={patch}
        options={{ diffStyle, theme: 'pierre-light', themeType: 'light', overflow: 'scroll' }}
      />
    )
    // diffHash is a 1:1 proxy for `patch`; depend on it (not the long string) + style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffHash, diffStyle])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted hover:text-accent-text"
        >
          <ArrowLeft size={14} aria-hidden />
          <span>Changes</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-text" dir="rtl" title={file.path}>
          {file.path}
        </span>
        {result?.truncated && (
          <span className="shrink-0 text-[11px] text-muted" title="Diff truncated — file too large">
            truncated
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5 text-xs">
        <div className="flex border border-border">
          <ToggleButton active={diffStyle === 'unified'} onClick={() => setDiffStyle('unified')}>
            Stacked
          </ToggleButton>
          <ToggleButton active={diffStyle === 'split'} onClick={() => setDiffStyle('split')}>
            Split
          </ToggleButton>
        </div>
        <button
          type="button"
          onClick={() => setIgnoreWhitespace((w) => !w)}
          aria-pressed={ignoreWhitespace}
          title={ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
          className={cn(
            'ml-auto shrink-0 border border-border px-2 py-0.5',
            ignoreWhitespace ? 'bg-accent/10 text-accent-text' : 'text-muted hover:text-accent-text',
          )}
        >
          Ignore whitespace
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !result ? (
          <p className="px-3 py-3 text-xs text-muted">Loading diff…</p>
        ) : rendered ? (
          rendered
        ) : (
          <p className="px-3 py-3 text-xs text-muted">
            No changes to show{ignoreWhitespace ? ' (whitespace-only changes hidden).' : '.'}
          </p>
        )}
      </div>
    </div>
  )
}

/** A segmented-control button (Stacked / Split) in the brand's zero-radius idiom. */
function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'px-2 py-0.5',
        active ? 'bg-accent/10 text-accent-text' : 'text-muted hover:text-accent-text',
      )}
    >
      {children}
    </button>
  )
}
