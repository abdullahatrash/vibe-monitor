import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { PanelRightClose, RefreshCw, Search } from 'lucide-react'
import type { FilesListResult } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { indexEntryKinds, selectedFilePath, toTreePaths } from './tree-paths'

/**
 * The Files Surface (#188, ADR-0013 decisions 2-4; CONTEXT.md "Files browser"). A
 * searchable `@pierre/trees` tree of the active Workspace's files, fed by the confined
 * `files:list` IPC. Copy-adapted from t3code's `FileBrowserPanel` onto our IPC + tokens:
 * compact density, hide-non-matches search, flattened empty dirs, one level expanded.
 *
 * The tree is a preact/shadow-DOM web component; we theme it through its `--trees-*`
 * custom-prop overrides mapped to OUR warm-neutral tokens (CSS custom properties inherit
 * across the shadow boundary, so `var(--…)` resolves against the host). We test the DATA
 * we feed it (`tree-paths.ts`), never the widget's internals.
 */

/** Map the tree's shadow-DOM theme onto our tokens (styles.css). */
const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: var(--accent-tint);
    --trees-hover-bg-override: color-mix(in srgb, var(--accent) 8%, transparent);
    --trees-border-color-override: var(--border-muted);
    --trees-font-family-override: inherit;
    --trees-font-size-override: 12.5px;
  }
  button[data-type='item'] { border-radius: 6px; }
`

export function FilesSurface({
  onCollapse,
  agentId,
  onOpenFile,
}: {
  onCollapse: () => void
  /** The warm agent handle — `files:list` resolves the Workspace root from it (#188 F3),
   *  so the renderer never names a path to list. */
  agentId: string
  /** Emit an open-file intent for a selected FILE (slice 3 / #189 consumes it). */
  onOpenFile: (relativePath: string) => void
}): JSX.Element {
  const [data, setData] = useState<FilesListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const entries = useMemo(() => data?.entries ?? [], [data])
  const treePaths = useMemo(() => toTreePaths(entries), [entries])
  const kinds = useMemo(() => indexEntryKinds(entries), [entries])

  // Refs so the tree's stable `onSelectionChange` reads current kinds / callback without
  // being re-created (which would tear down the widget's listener).
  const kindsRef = useRef(kinds)
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile

  const { model } = useFileTree({
    density: 'compact',
    fileTreeSearchMode: 'hide-non-matches',
    flattenEmptyDirectories: true,
    initialExpansion: 1,
    icons: { set: 'complete', colored: true },
    search: true,
    paths: [],
    unsafeCSS: TREE_UNSAFE_CSS,
    onSelectionChange: (selected) => {
      const path = selectedFilePath(selected, kindsRef.current)
      if (path) onOpenFileRef.current(path) // a directory selection just expands
    },
  })

  const load = useCallback(
    async (refresh: boolean) => {
      setLoading(true)
      setError(null)
      try {
        setData(await window.api.filesList({ agentId, refresh }))
      } catch {
        setError('Could not list files.')
      } finally {
        setLoading(false)
      }
    },
    [agentId],
  )

  // Initial load + reload when the Workspace changes.
  useEffect(() => {
    void load(false)
  }, [load])

  // Feed the tree whenever the listing changes (reference-guarded like t3code).
  const prevTreePathsRef = useRef<readonly string[]>([])
  useEffect(() => {
    if (prevTreePathsRef.current === treePaths) return
    kindsRef.current = kinds
    prevTreePathsRef.current = treePaths
    model.resetPaths(treePaths)
  }, [kinds, model, treePaths])

  // Focus the tree search on mount (ADR-0013 decision 1). This component only mounts when
  // Files is open + expanded, so BOTH entry paths — ⌘P (open the panel with Files) and a
  // Files card click — land here search-focused, keying off "Files became visible" rather
  // than the trigger. A ⌘P re-press closes the panel (unmounts), so search re-focuses on
  // the next open.
  useEffect(() => {
    model.openSearch()
  }, [model])

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === 'file' ? 1 : 0), 0),
    [entries],
  )
  const statusText =
    loading && data === null ? 'Indexing…' : `${fileCount.toLocaleString()} files`

  return (
    <aside
      aria-label="Files"
      // `flex-1 min-h-0` (not `self-stretch`): the parent Surface slot is a flex COLUMN, where
      // `align-self:stretch` only stretches the WIDTH — it gives no height. `@pierre/trees` is
      // virtualized and measures its scroll container, so a content-height (≈0) container renders
      // ZERO rows (the header/search still show). `flex-1` fills the column's height; `min-h-0`
      // lets it shrink below content so the inner tree can scroll. (Matches t3code's FileBrowserPanel.)
      className="flex min-h-0 w-80 flex-1 flex-col border-l border-border bg-panel text-text"
    >
      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2.5">
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse"
          aria-label="Collapse Files panel"
          className="flex items-center gap-1.5 rounded-md text-left text-sm font-semibold text-text-strong"
        >
          <PanelRightClose size={15} aria-hidden className="shrink-0 text-muted" />
          <span>Files</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-faint" aria-live="polite">
          {statusText}
          {data?.truncated ? ' · partial' : ''}
        </span>
        <button
          type="button"
          onClick={() => model.openSearch()}
          title="Search files"
          aria-label="Search files"
          className="rounded-md p-1 text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10"
        >
          <Search size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          title="Refresh files"
          aria-label="Refresh files"
          className="rounded-md p-1 text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10 disabled:opacity-50"
        >
          <RefreshCw size={14} aria-hidden className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {error ? (
        <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-[13px] text-muted">
          {error}
        </div>
      ) : (
        <FileTree
          model={model}
          aria-label="Workspace files"
          className="min-h-0 flex-1 overflow-hidden"
          style={{ ['--trees-fg-override' as string]: 'var(--text)' }}
        />
      )}
    </aside>
  )
}
