import type { ComponentProps, JSX, ReactNode } from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { cn } from '../lib/utils'

/**
 * A right-edge slide-over "Sheet" over base-ui's Dialog (#193, ADR-0013 decision 1),
 * copy-adapted from t3code's `ui/sheet.tsx` onto OUR tokens + base-ui@1.6.0. It presents
 * the side panel's content on narrow windows (≤980px): a dimmed + blurred backdrop with
 * the panel sliding in from the right; Esc / outside-click close it. The SAME content
 * renders inline on wide windows — this is only the narrow presentation shell.
 *
 * base-ui differences from t3code's newer version: our 1.6.0 already ships
 * `Dialog.Viewport` (the flex container that pins the popup to an edge), so the structure
 * mirrors t3code's — Portal → Backdrop → Viewport → Popup — rather than needing a fallback.
 * We drop t3code's shadcn colour tokens (`bg-popover`, `bg-background/60`) for ours
 * (`bg-panel`, `bg-black/40`), and keep only the parts we use (no header/footer/title
 * helpers — the panel brings its own chrome).
 */
export const Sheet = BaseDialog.Root

/**
 * The sliding panel surface: Portal (optionally `keepMounted`) → dimmed/blurred Backdrop →
 * right-justified Viewport → the Popup itself. The Popup animates in/out via base-ui's
 * `data-starting-style` / `data-ending-style` translate hooks. Width mirrors t3code's
 * `min(42vw,28rem)` with an `80` (20rem) floor.
 */
export function SheetPopup({
  className,
  children,
  keepMounted = false,
  ...props
}: ComponentProps<typeof BaseDialog.Popup> & {
  keepMounted?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <BaseDialog.Portal keepMounted={keepMounted}>
      <BaseDialog.Backdrop
        data-slot="sheet-backdrop"
        className={cn(
          'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-200',
          'data-ending-style:opacity-0 data-starting-style:opacity-0',
        )}
      />
      <BaseDialog.Viewport
        data-slot="sheet-viewport"
        className="fixed inset-0 z-50 flex justify-end"
      >
        <BaseDialog.Popup
          data-slot="sheet-popup"
          className={cn(
            'relative flex h-full min-h-0 w-[min(42vw,28rem)] min-w-80 max-w-[28rem] flex-col overflow-hidden',
            'border-l border-border bg-panel text-text shadow-lg outline-none',
            'transition-[opacity,translate] duration-200 ease-in-out',
            'data-ending-style:translate-x-8 data-ending-style:opacity-0',
            'data-starting-style:translate-x-8 data-starting-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  )
}
