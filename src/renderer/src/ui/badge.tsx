import type { JSX } from 'react'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'

/**
 * A small pill label (history / needs-attention counters, status tags). Uses
 * base-ui's `useRender` so it can render as a `<span>` by default or compose onto
 * a custom element via the `render` prop — the shadcn `badge.tsx` idiom, with its
 * `cn-badge-variant-*` tokens swapped for our real utilities. Rounded to
 * `rounded-lg` (pill) per the tokens doc.
 */
export const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2 py-0.5 text-xs font-medium [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-accent text-on-accent',
        accent: 'bg-accent/10 text-accent-text',
        destructive: 'bg-bad/10 text-bad',
        ok: 'bg-ok/10 text-ok',
        outline: 'border border-border text-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export function Badge({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>): JSX.Element {
  return useRender({
    defaultTagName: 'span',
    render,
    props: mergeProps<'span'>(
      { className: cn(badgeVariants({ variant }), className) },
      props,
    ),
  })
}
