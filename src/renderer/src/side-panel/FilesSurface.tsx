import { type JSX } from 'react'
import { FolderTree, PanelRightClose } from 'lucide-react'

/**
 * The Files Surface (#187, ADR-0013 decision 2; CONTEXT.md "Files browser"). THIS slice
 * ships the Surface shell only — a header (title + collapse-to-stack affordance) and a
 * muted empty-state body. Slice 2 swaps the body for the searchable tree WITHOUT touching
 * the stack model or this header, so the collapse wiring is stable here.
 */
export function FilesSurface({ onCollapse }: { onCollapse: () => void }): JSX.Element {
  return (
    <aside
      aria-label="Files"
      className="flex w-80 shrink-0 flex-col self-stretch border-l border-border bg-panel text-text"
    >
      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2.5">
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse"
          aria-label="Collapse Files panel"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm font-semibold text-text-strong"
        >
          <PanelRightClose size={15} aria-hidden className="shrink-0 text-muted" />
          <span>Files</span>
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <FolderTree className="size-6 text-faint" aria-hidden />
        <p className="text-[13px] text-muted">File browsing lands in the next slice.</p>
      </div>
    </aside>
  )
}
