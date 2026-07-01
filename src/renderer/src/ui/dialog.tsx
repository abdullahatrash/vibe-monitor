import type { ComponentProps, JSX } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'
import { IconButton } from './icon-button'

/**
 * A modal dialog over base-ui's Dialog (Root/Trigger/Portal/Backdrop/Popup/Title/…).
 * shadcn's `cn-dialog-*` structural tokens are replaced with real utilities on our
 * tokens: a dimming backdrop, a centred `--panel` card at `rounded-2xl` (20px), and
 * a ghost close button in the corner.
 */
export const Dialog = BaseDialog.Root
export const DialogTrigger = BaseDialog.Trigger
export const DialogPortal = BaseDialog.Portal
export const DialogClose = BaseDialog.Close

export function DialogBackdrop({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Backdrop>): JSX.Element {
  return (
    <BaseDialog.Backdrop
      data-slot="dialog-backdrop"
      className={cn('fixed inset-0 z-50 bg-black/30', className)}
      {...props}
    />
  )
}

export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: ComponentProps<typeof BaseDialog.Popup> & {
  showCloseButton?: boolean
}): JSX.Element {
  return (
    <DialogPortal>
      <DialogBackdrop />
      <BaseDialog.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-panel p-6 text-text shadow-lg outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <BaseDialog.Close
            render={<IconButton size="icon-sm" className="absolute top-3 right-3" />}
            aria-label="Close"
          >
            <X className="size-4" />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </DialogPortal>
  )
}

export function DialogHeader({
  className,
  ...props
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5', className)} {...props} />
  )
}

export function DialogFooter({
  className,
  ...props
}: ComponentProps<'div'>): JSX.Element {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Title>): JSX.Element {
  return (
    <BaseDialog.Title
      data-slot="dialog-title"
      className={cn('text-base font-semibold text-text-strong', className)}
      {...props}
    />
  )
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Description>): JSX.Element {
  return (
    <BaseDialog.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted', className)}
      {...props}
    />
  )
}
