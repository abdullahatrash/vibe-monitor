import type { ComponentProps, JSX } from 'react'
import { cn } from '../lib/utils'

/**
 * A **borderless** inline `icon + label + chevron` group (context chips: local /
 * git-branch / model). Per the tokens doc these are NOT bordered pills — just a
 * muted, gap-6/8 cluster that tints on hover. Compose freely:
 *
 *   <Chip><Monitor className="size-4" /> local <ChevronDown className="size-3.5" /></Chip>
 *
 * `active` lifts it to the accent text colour.
 */
export function Chip({
  className,
  active = false,
  ...props
}: ComponentProps<'div'> & { active?: boolean }): JSX.Element {
  return (
    <div
      data-slot="chip"
      data-active={active || undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-sm text-muted transition-colors',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        active && 'text-accent-text',
        className,
      )}
      {...props}
    />
  )
}
