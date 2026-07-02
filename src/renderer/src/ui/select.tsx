import type { ComponentProps, JSX } from 'react'
import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/utils'
import { menuSurfaceClass } from './menu-styles'

/**
 * A listbox select over base-ui's Select (Root/Trigger/Value/Positioner/Popup/
 * Item/…). shadcn's base-ui `select.tsx`, with its `cn-select-*` tokens swapped for
 * real utilities on our tokens and its icon-registry placeholders swapped for lucide
 * (ChevronDown trigger icon, Check item indicator). Used for the model/effort pickers.
 */
export const Select = BaseSelect.Root
export const SelectValue = BaseSelect.Value
export const SelectGroup = BaseSelect.Group

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSelect.Trigger>): JSX.Element {
  return (
    <BaseSelect.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-9 w-fit items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 text-sm text-text outline-none transition-colors',
        'hover:bg-accent/10 focus-visible:border-accent disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      <BaseSelect.Icon render={<ChevronDown className="size-4 text-muted" />} />
    </BaseSelect.Trigger>
  )
}

export function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  ...props
}: ComponentProps<typeof BaseSelect.Popup> &
  Pick<
    ComponentProps<typeof BaseSelect.Positioner>,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >): JSX.Element {
  return (
    <BaseSelect.Portal>
      <BaseSelect.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="z-50"
      >
        <BaseSelect.Popup
          data-slot="select-content"
          className={cn(
            'z-50 max-h-(--available-height) min-w-32 overflow-y-auto py-1',
            menuSurfaceClass,
            className,
          )}
          {...props}
        >
          {/* `List` is the element that carries `role="listbox"` + registers the
             scroll/positioning container in base-ui — keep children inside it. */}
          <BaseSelect.List>{children}</BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  )
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseSelect.Item>): JSX.Element {
  return (
    <BaseSelect.Item
      data-slot="select-item"
      className={cn(
        'relative flex cursor-default items-center gap-2 py-1.5 pr-8 pl-3 outline-none select-none',
        'data-[highlighted]:bg-accent data-[highlighted]:text-on-accent',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      <BaseSelect.ItemText>{children}</BaseSelect.ItemText>
      <BaseSelect.ItemIndicator className="absolute right-3 flex items-center">
        <Check className="size-4" />
      </BaseSelect.ItemIndicator>
    </BaseSelect.Item>
  )
}

export function SelectGroupLabel({
  className,
  ...props
}: ComponentProps<typeof BaseSelect.GroupLabel>): JSX.Element {
  return (
    <BaseSelect.GroupLabel
      data-slot="select-label"
      className={cn('px-3 py-1.5 text-xs text-muted', className)}
      {...props}
    />
  )
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof BaseSelect.Separator>): JSX.Element {
  return (
    <BaseSelect.Separator
      data-slot="select-separator"
      className={cn('my-1 h-px bg-border', className)}
      {...props}
    />
  )
}
