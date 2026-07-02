import type { JSX, ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { useStickToBottom } from 'use-stick-to-bottom'
import { cn } from '../lib/utils'

/**
 * The conversation transcript's scroll container (#114). Wraps `use-stick-to-bottom`:
 * it PINS the newest message while the answer streams in, but the moment the user
 * scrolls up it releases the lock (`escapedFromLock`) and surfaces a scroll-to-bottom
 * pill instead of yanking them back down. Replaces the old naive
 * `list.scrollTop = list.scrollHeight` effect, which fought the user on every token.
 *
 * The scroll element keeps the `.messages` styling (bounded height + overflow); the
 * inner `contentRef` div owns the message gap so the resize observer measures growth.
 */
export function MessageScroller({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({
    initial: 'instant',
    resize: 'smooth',
  })
  return (
    // A flex column itself, so `.messages` (flex: 1, min-height: 0) fills it and
    // scrolls internally; `flex-1 min-h-0` makes THIS wrapper take the height the
    // `.conv` column leaves over, keeping the Composer sibling pinned below.
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div ref={scrollRef} className="messages">
        <div ref={contentRef} className="flex flex-col gap-3">
          {children}
        </div>
      </div>
      {!isAtBottom && (
        <button
          type="button"
          onClick={() => void scrollToBottom()}
          aria-label="Scroll to latest"
          className="absolute bottom-2 left-1/2 inline-flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-panel text-muted shadow-md outline-none transition-colors hover:text-text"
        >
          <ArrowDown className="size-4" aria-hidden />
        </button>
      )}
    </div>
  )
}
