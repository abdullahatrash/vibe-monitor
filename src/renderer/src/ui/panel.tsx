import type { ComponentProps, JSX } from 'react'
import { cn } from '../lib/utils'

/**
 * The side-panel container (git "Review" panel, expanded views). App-specific — a
 * `--panel` (white) surface with a leading `--border` divider, filling its column.
 * The Header/Title/Content parts give a consistent panel chrome; Content scrolls.
 */
export function Panel({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="panel"
      className={cn(
        'flex h-full min-h-0 flex-col border-l border-border bg-panel text-text',
        className,
      )}
      {...props}
    />
  )
}

export function PanelHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="panel-header"
      className={cn(
        'flex flex-none items-center gap-2 border-b border-border-muted px-4 py-3',
        className,
      )}
      {...props}
    />
  )
}

export function PanelTitle({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="panel-title"
      className={cn('flex-1 text-sm font-semibold text-text-strong', className)}
      {...props}
    />
  )
}

export function PanelContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="panel-content"
      className={cn('min-h-0 flex-1 overflow-y-auto p-4', className)}
      {...props}
    />
  )
}
