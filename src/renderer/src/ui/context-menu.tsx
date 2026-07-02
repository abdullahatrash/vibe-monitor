import type { ComponentProps, JSX } from 'react'
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import { cn } from '../lib/utils'

/**
 * A right-click context menu over base-ui's ContextMenu primitive (#193). It shares the
 * Menu popup/item parts, so it wears the SAME brand styling as {@link './menu'} — rounded
 * `--panel` surface, `--border`, an accent-tinted highlight — but opens at the cursor on
 * contextmenu / long-press instead of from a trigger button. Used for the side-panel tab
 * strip's per-tab actions (Close / Close others / Close to the right).
 *
 *   <ContextMenu>
 *     <ContextMenuTrigger render={<div … />} />
 *     <ContextMenuContent>
 *       <ContextMenuItem onClick={…}>Close</ContextMenuItem>
 *     </ContextMenuContent>
 *   </ContextMenu>
 */
export const ContextMenu = BaseContextMenu.Root
export const ContextMenuTrigger = BaseContextMenu.Trigger

/** The popup surface, wrapped in Portal + Positioner (portals to <body>, correct in Electron). */
export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.Popup>): JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-50">
        <BaseContextMenu.Popup
          className={cn(
            'min-w-40 rounded-md border border-border bg-panel p-1 text-sm text-text shadow-md outline-none',
            className,
          )}
          {...props}
        />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

/** A single command row; `data-highlighted` drives the accent highlight (matches Menu). */
export function ContextMenuItem({
  className,
  ...props
}: ComponentProps<typeof BaseContextMenu.Item>): JSX.Element {
  return (
    <BaseContextMenu.Item
      className={cn(
        'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none',
        'data-[highlighted]:bg-accent data-[highlighted]:text-on-accent',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
