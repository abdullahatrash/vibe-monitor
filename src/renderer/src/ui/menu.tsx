import type { ComponentProps, JSX } from 'react'
import { Menu as BaseMenu } from '@base-ui/react/menu'
import { Check } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * A small brand-styled wrapper over base-ui's Menu primitive. base-ui owns the
 * hard parts — focus management, roving keyboard nav, type-ahead, portalling,
 * outside-click/ESC dismissal — so these components only layer on the Mistral look
 * (rounded corners from the new radius scale, `--panel` surface, `--border`, an
 * accent hover tint). Compose them like the base parts:
 *
 *   <Menu>
 *     <MenuTrigger render={<button …/>} />
 *     <MenuContent>
 *       <MenuItem onClick={…}>Delete</MenuItem>
 *     </MenuContent>
 *   </Menu>
 */
export const Menu = BaseMenu.Root
export const MenuTrigger = BaseMenu.Trigger

/**
 * The popup surface, already wrapped in Portal + Positioner (portals to <body>,
 * which is correct under Electron). `sideOffset` keeps it off the trigger.
 */
export function MenuContent({
  className,
  sideOffset = 4,
  align = 'end',
  ...props
}: ComponentProps<typeof BaseMenu.Popup> & {
  sideOffset?: number
  align?: ComponentProps<typeof BaseMenu.Positioner>['align']
}): JSX.Element {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner sideOffset={sideOffset} align={align}>
        <BaseMenu.Popup
          className={cn(
            'min-w-32 rounded-md border border-border bg-panel p-1 text-sm text-text shadow-md outline-none',
            className,
          )}
          {...props}
        />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

/** A single command row. Highlight state is driven by base-ui's `data-highlighted`. */
export function MenuItem({
  className,
  ...props
}: ComponentProps<typeof BaseMenu.Item>): JSX.Element {
  return (
    <BaseMenu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-accent data-[highlighted]:text-on-accent',
        className,
      )}
      {...props}
    />
  )
}

export const MenuSeparator = BaseMenu.Separator

/**
 * A single-choice group inside a menu (e.g. a sort-order picker). base-ui owns the
 * `role="menuitemradio"` + `aria-checked` semantics and the `value`/`onValueChange`
 * state, so a screen reader announces which option is selected. Wrap {@link
 * MenuRadioItem}s and drive it with `value` + `onValueChange`.
 */
export const MenuRadioGroup = BaseMenu.RadioGroup

/**
 * One option in a {@link MenuRadioGroup}, styled like {@link MenuItem} with a leading
 * check that renders only for the active `value` (base-ui shows the indicator when
 * checked; the fixed slot keeps rows aligned). Accessible state is base-ui's, not a
 * visual-only cue.
 */
export function MenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseMenu.RadioItem>): JSX.Element {
  return (
    <BaseMenu.RadioItem
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-accent data-[highlighted]:text-on-accent',
        className,
      )}
      {...props}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        <BaseMenu.RadioItemIndicator>
          <Check className="size-4" aria-hidden />
        </BaseMenu.RadioItemIndicator>
      </span>
      <span className="flex-1">{children}</span>
    </BaseMenu.RadioItem>
  )
}
