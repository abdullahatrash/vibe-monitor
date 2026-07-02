import type { GitFile, GitStatus } from '../../../shared/ipc'

/**
 * Pure view-model for the Changes panel (#84): turn a raw `GitStatus` into a
 * render-ready shape — a per-file display glyph, a stable sort, and the header
 * roll-ups (branch label, ahead/behind, total churn). Kept out of the component so
 * the non-trivial mapping/sorting is unit-tested without rendering React.
 */

/** A changed file plus its single-letter display glyph + accessible label. */
export interface GitFileView extends GitFile {
  glyph: string
  glyphLabel: string
}

/** The render-ready Changes view. */
export interface ChangesView {
  /** Branch name, or `'HEAD'` when detached (see `detached`). */
  branch: string
  detached: boolean
  ahead: number
  behind: number
  files: GitFileView[]
  fileCount: number
  totalInsertions: number
  totalDeletions: number
}

/**
 * The single-letter glyph + label for a file, derived from its porcelain XY code.
 * Untracked is `U`; otherwise the most salient change wins (rename > copy > add >
 * delete > modify) looking at both the index (X) and worktree (Y) halves.
 */
export function fileGlyph(file: GitFile): { glyph: string; label: string } {
  if (file.untracked) return { glyph: 'U', label: 'Untracked' }
  const x = file.status[0] ?? ' '
  const y = file.status[1] ?? ' '
  if (x === 'R' || y === 'R') return { glyph: 'R', label: 'Renamed' }
  if (x === 'C' || y === 'C') return { glyph: 'C', label: 'Copied' }
  if (x === 'A') return { glyph: 'A', label: 'Added' }
  if (x === 'D' || y === 'D') return { glyph: 'D', label: 'Deleted' }
  return { glyph: 'M', label: 'Modified' }
}

/** A glyph's accent: added/untracked read positive, deleted negative, else neutral. */
export function glyphClass(glyph: string): string {
  if (glyph === 'A' || glyph === 'U') return 'text-ok'
  if (glyph === 'D') return 'text-bad'
  return 'text-accent-text'
}

/** Sort rank by glyph so like-changes group together; ties break on path. */
const GLYPH_RANK: Record<string, number> = { M: 0, A: 1, D: 2, R: 3, C: 4, U: 5 }

/**
 * Reconcile the commit selection's `unchecked` set against the CURRENT changed paths
 * (#86). Selection is tracked as the set of paths the user EXPLICITLY deselected
 * (default empty = all selected), so a freshly-appearing file is selected by default
 * (it's absent from the set) with no work here. The only reconcile needed is to DROP a
 * path that has vanished from the changed set (reverted / committed / renamed away), so
 * a stale entry can't suppress a later same-named file or skew the selected count.
 * Returns the SAME set ref when nothing changed, so a status tick that doesn't touch
 * the selection won't force a re-render (referential-stability for the caller's setState).
 */
export function reconcileUnchecked(unchecked: ReadonlySet<string>, paths: readonly string[]): Set<string> {
  const present = new Set(paths)
  let changed = false
  const next = new Set<string>()
  for (const path of unchecked) {
    if (present.has(path)) next.add(path)
    else changed = true
  }
  return changed ? next : (unchecked as Set<string>)
}

/** Build the render-ready view from a repo `GitStatus` (assumes `isRepo:true`). */
export function buildChangesView(status: GitStatus): ChangesView {
  const files: GitFileView[] = status.files
    .map((file) => {
      const { glyph, label } = fileGlyph(file)
      return { ...file, glyph, glyphLabel: label }
    })
    .sort((a, b) => {
      const rank = (GLYPH_RANK[a.glyph] ?? 99) - (GLYPH_RANK[b.glyph] ?? 99)
      return rank !== 0 ? rank : a.path.localeCompare(b.path)
    })
  return {
    branch: status.branch ?? 'HEAD',
    detached: status.branch === null,
    ahead: status.ahead,
    behind: status.behind,
    files,
    fileCount: files.length,
    totalInsertions: files.reduce((n, f) => n + f.insertions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
  }
}
