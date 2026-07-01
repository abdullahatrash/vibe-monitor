import type { ComponentProps, JSX } from 'react'
import { cn } from '../lib/utils'

/**
 * A sidebar navigation row (New chat / Search / Scheduled / Plugins, project + thread
 * rows). App-specific — hand-built to the tokens doc: `padding 9px 12px`, `--radius-md`
 * (10px), a muted resting label that tints on hover and lifts to a stronger accent
 * wash when `active` (the `--active-bg` token isn't bridged into `@theme`, so we use
 * the bridged `accent` at a higher alpha). Renders a `<button>` by default; pass
 * children (icon + label) as content.
 */
export function NavItem({
  className,
  active = false,
  ...props
}: ComponentProps<'button'> & { active?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      data-slot="nav-item"
      data-active={active || undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[14px] text-text-body outline-none transition-colors',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted',
        'hover:bg-accent/10 focus-visible:bg-accent/10',
        active && 'bg-accent/15 font-semibold text-text-strong [&_svg]:text-text-strong',
        className,
      )}
      {...props}
    />
  )
}
