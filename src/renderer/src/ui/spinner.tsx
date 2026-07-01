import type { ComponentProps, JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * A spinning loading glyph — lucide `loader-2` with `animate-spin`. `size-4` by
 * default; override via `className` (e.g. `size-3` for inline). Carries a `status`
 * role for a11y.
 */
export function Spinner({ className, ...props }: ComponentProps<typeof Loader2>): JSX.Element {
  return (
    <Loader2
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}
