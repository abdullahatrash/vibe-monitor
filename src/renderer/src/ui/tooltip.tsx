import type { ComponentProps, JSX } from 'react'
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip'
import { cn } from '../lib/utils'

/**
 * A hover/focus tooltip over base-ui's Tooltip. `TooltipProvider` shares delay
 * across a subtree (mount once near the app root). The content is a dark inverted
 * chip (`--text` bg / `--bg` fg) — shadcn's `bg-foreground text-background`,
 * re-expressed on our tokens.
 */
export function TooltipProvider({
  delay = 300,
  ...props
}: ComponentProps<typeof BaseTooltip.Provider>): JSX.Element {
  return <BaseTooltip.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

export const Tooltip = BaseTooltip.Root
export const TooltipTrigger = BaseTooltip.Trigger

export function TooltipContent({
  className,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: ComponentProps<typeof BaseTooltip.Popup> &
  Pick<
    ComponentProps<typeof BaseTooltip.Positioner>,
    'align' | 'alignOffset' | 'side' | 'sideOffset'
  >): JSX.Element {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="z-50"
      >
        <BaseTooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 w-fit max-w-xs rounded-sm bg-text px-2 py-1 text-xs text-bg shadow-md',
            className,
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  )
}
