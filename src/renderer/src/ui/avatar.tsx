import type { ComponentProps, JSX } from 'react'
import { Avatar as BaseAvatar } from '@base-ui/react/avatar'
import { cn } from '../lib/utils'

/**
 * A user/account avatar over base-ui's Avatar (Root/Image/Fallback). The Root
 * clips to `rounded-md` (~the tokens doc's avatar radius); the account gradient
 * (`--accent-grad-avatar`) is applied by the caller as a fallback background.
 */
export function Avatar({
  className,
  ...props
}: ComponentProps<typeof BaseAvatar.Root>): JSX.Element {
  return (
    <BaseAvatar.Root
      data-slot="avatar"
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-md select-none', className)}
      {...props}
    />
  )
}

export function AvatarImage({
  className,
  ...props
}: ComponentProps<typeof BaseAvatar.Image>): JSX.Element {
  return (
    <BaseAvatar.Image
      data-slot="avatar-image"
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  )
}

export function AvatarFallback({
  className,
  ...props
}: ComponentProps<typeof BaseAvatar.Fallback>): JSX.Element {
  return (
    <BaseAvatar.Fallback
      data-slot="avatar-fallback"
      className={cn(
        'flex size-full items-center justify-center text-sm text-on-accent',
        className,
      )}
      {...props}
    />
  )
}
