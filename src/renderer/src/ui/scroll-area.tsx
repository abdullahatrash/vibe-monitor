import type { ComponentProps, JSX } from 'react'
import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area'
import { cn } from '../lib/utils'

/**
 * A custom-scrollbar viewport over base-ui's ScrollArea (Root→Viewport + a thin
 * Scrollbar/Thumb). shadcn's `cn-scroll-area-*` tokens become plain utilities on
 * our `--border` thumb. The children scroll inside the Viewport.
 */
export function ScrollArea({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseScrollArea.Root>): JSX.Element {
  return (
    <BaseScrollArea.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
      <BaseScrollArea.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none"
      >
        {children}
      </BaseScrollArea.Viewport>
      <ScrollBar />
      <BaseScrollArea.Corner />
    </BaseScrollArea.Root>
  )
}

export function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: ComponentProps<typeof BaseScrollArea.Scrollbar>): JSX.Element {
  return (
    <BaseScrollArea.Scrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2',
        orientation === 'horizontal' && 'h-2 w-full flex-col',
        className,
      )}
      {...props}
    >
      <BaseScrollArea.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </BaseScrollArea.Scrollbar>
  )
}
