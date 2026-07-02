import type { ComponentProps, JSX } from 'react'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { cn } from '../lib/utils'
import { menuSurfaceClass } from './menu-styles'

/**
 * A floating popover over base-ui's Popover, wrapped Portal→Positioner→Popup like
 * our Menu. shadcn's `cn-popover-content` token becomes real utilities: a `--panel`
 * surface, `--border`, `rounded-md`, shadow. Positioner props (`side`/`align`/
 * offsets) are surfaced on the content for callers.
 */
export const Popover = BasePopover.Root
export const PopoverTrigger = BasePopover.Trigger

export function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof BasePopover.Popup> &
  Pick<
    ComponentProps<typeof BasePopover.Positioner>,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >): JSX.Element {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="z-50"
      >
        <BasePopover.Popup
          data-slot="popover-content"
          className={cn('z-50 w-72 p-4', menuSurfaceClass, className)}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}

export function PopoverTitle({
  className,
  ...props
}: ComponentProps<typeof BasePopover.Title>): JSX.Element {
  return (
    <BasePopover.Title
      data-slot="popover-title"
      className={cn('text-sm font-semibold text-text-strong', className)}
      {...props}
    />
  )
}

export function PopoverDescription({
  className,
  ...props
}: ComponentProps<typeof BasePopover.Description>): JSX.Element {
  return (
    <BasePopover.Description
      data-slot="popover-description"
      className={cn('text-sm text-muted', className)}
      {...props}
    />
  )
}
