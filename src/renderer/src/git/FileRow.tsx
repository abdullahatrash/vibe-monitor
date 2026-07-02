import type { JSX } from 'react'
import { cn } from '../lib/utils'
import { glyphClass, type GitFileView } from './status-view'

/**
 * One changed-file row. A leading checkbox toggles the file's commit selection (#86)
 * WITHOUT opening the diff (it's a separate control, not nested in the row button);
 * clicking the rest of the row opens the file's working-tree diff (#85, DIFF mode).
 * The row insets from the panel edges (mx-2) so its rounded hover tint floats clear of
 * the border, matching the menu/list idiom.
 */
export function FileRow({
  file,
  checked,
  onToggle,
  onSelect,
}: {
  file: GitFileView
  checked: boolean
  onToggle: () => void
  onSelect: () => void
}): JSX.Element {
  return (
    <li className="mx-2 flex items-center gap-1 rounded-md transition-colors hover:bg-accent/10">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Include ${file.path} in commit`}
        title="Include in commit"
        className="ml-2 size-3.5 shrink-0 rounded accent-accent"
      />
      <button
        type="button"
        onClick={onSelect}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
      >
        <span
          className={cn('w-3 shrink-0 text-center font-semibold tabular-nums', glyphClass(file.glyph))}
          title={file.glyphLabel}
          aria-label={file.glyphLabel}
        >
          {file.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate" dir="rtl">
          {file.path}
        </span>
        {(file.insertions > 0 || file.deletions > 0) && (
          <span className="shrink-0 tabular-nums text-[11px]">
            {file.insertions > 0 && <span className="text-ok">+{file.insertions}</span>}
            {file.insertions > 0 && file.deletions > 0 && ' '}
            {file.deletions > 0 && <span className="text-bad">−{file.deletions}</span>}
          </span>
        )}
      </button>
    </li>
  )
}
