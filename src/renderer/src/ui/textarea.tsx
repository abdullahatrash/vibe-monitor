import type { ComponentProps, JSX } from 'react'
import { cn } from '../lib/utils'

/**
 * A native multi-line text field (base-ui has no textarea primitive) styled to
 * match {@link Input}. `field-sizing-content` lets it grow with its content;
 * consumers can still override to a fixed `resize`.
 */
export function Textarea({
  className,
  ...props
}: ComponentProps<'textarea'>): JSX.Element {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none transition-colors',
        'placeholder:text-placeholder focus-visible:border-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
