import type { ComponentProps, JSX } from 'react'
import { cn } from '../lib/utils'

/**
 * A surface container (composer card, panels' inner blocks). `--surface` bg, a warm
 * `--border`, `rounded-2xl` (20px per the tokens doc), soft shadow. The Header/Title/
 * Description/Content/Footer parts mirror shadcn's card triad, restyled to our tokens.
 */
export function Card({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="card"
      className={cn(
        'flex flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-text shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="card-title"
      className={cn('font-semibold text-text-strong', className)}
      {...props}
    />
  )
}

export function CardDescription({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div data-slot="card-description" className={cn('text-sm text-muted', className)} {...props} />
  )
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return <div data-slot="card-content" className={cn(className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>): JSX.Element {
  return (
    <div data-slot="card-footer" className={cn('flex items-center gap-2', className)} {...props} />
  )
}
