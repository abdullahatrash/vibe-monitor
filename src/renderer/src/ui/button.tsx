import type { ComponentProps, JSX } from 'react'
import { Button as BaseButton } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/utils'

/**
 * The CVA exemplar for the kit. Structure lifted from shadcn's base-ui `button.tsx`;
 * the semantic `cn-button-variant-*` theme tokens it ships are swapped for real
 * Tailwind utility strings resolved through OUR tokens (`bg-accent`, `text-on-accent`,
 * `border-border`, …). Radii come from the new rounded scale (#110): text buttons
 * `rounded-md` (10px), icon buttons `rounded-sm` (7px). `text-on-accent` is the warm
 * dark ink (AA-safe on the softer orange), NOT white.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors outline-none select-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-accent/40 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-on-accent hover:bg-accent/90',
        outline: 'border border-border bg-transparent text-text hover:bg-accent/10',
        secondary: 'border border-border bg-surface text-text hover:bg-accent/10',
        ghost: 'text-text hover:bg-accent/10',
        destructive: 'bg-bad text-white hover:bg-bad/90',
        link: 'text-accent-text underline-offset-4 hover:underline',
        // Interrupt action (#103) — an outline distinct from the primary Send;
        // mirrors the existing `.btn--stop` (transparent bg, muted border).
        stop: 'border border-border bg-transparent text-text hover:bg-accent/10',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-7 px-2 text-xs',
        sm: 'h-8 px-3',
        lg: 'h-10 px-6',
        icon: 'size-9 rounded-sm',
        'icon-xs': 'size-6 rounded-sm',
        'icon-sm': 'size-8 rounded-sm',
        'icon-lg': 'size-10 rounded-sm',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<typeof BaseButton> & VariantProps<typeof buttonVariants>): JSX.Element {
  return (
    <BaseButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}
