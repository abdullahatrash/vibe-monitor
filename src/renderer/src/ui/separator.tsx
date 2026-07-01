import type { ComponentProps, JSX } from 'react'
import { Separator as BaseSeparator } from '@base-ui/react/separator'
import { cn } from '../lib/utils'

/**
 * A hairline divider over base-ui's Separator — a `--border`-coloured 1px rule,
 * horizontal or vertical. Lifted straight from shadcn (its classes already use
 * `bg-border`, which maps to our token).
 */
export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentProps<typeof BaseSeparator>): JSX.Element {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'w-px self-stretch',
        className,
      )}
      {...props}
    />
  )
}
