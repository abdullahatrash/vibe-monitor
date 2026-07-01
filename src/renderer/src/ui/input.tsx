import type { ComponentProps, JSX } from 'react'
import { Input as BaseInput } from '@base-ui/react/input'
import { cn } from '../lib/utils'

/**
 * A single-line text field over base-ui's Input. shadcn's `cn-input` structural
 * token is expanded to real utilities on our tokens: `--bg` field, `--border`
 * (accent on focus), `--placeholder` text, `--radius-md`.
 */
export function Input({
  className,
  ...props
}: ComponentProps<typeof BaseInput>): JSX.Element {
  return (
    <BaseInput
      data-slot="input"
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-border bg-bg px-3 py-1 text-sm text-text outline-none transition-colors',
        'placeholder:text-placeholder focus-visible:border-accent',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
