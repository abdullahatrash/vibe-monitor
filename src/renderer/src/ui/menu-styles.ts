/**
 * Shared class strings for the base-ui popup family (Menu / ContextMenu / Popover /
 * Select), factored out so the surface + highlight-row look lives in ONE place instead
 * of being re-typed per primitive. Compose with `cn()`, layering each primitive's own
 * layout (sizing, padding, z-index, overflow) and any genuine per-component difference
 * (e.g. context-menu's `data-[disabled]` handling) around these.
 */

/**
 * The floating-popup SURFACE tokens common to every popup (`--panel` fill, `--border`,
 * rounded corners, text color, shadow, no focus ring). Per-primitive layout — min/max
 * width, padding, `z-50`, overflow — stays local at the call site.
 */
export const menuSurfaceClass =
  'rounded-md border border-border bg-panel text-sm text-text shadow-md outline-none'

/**
 * The highlight-row ITEM tokens shared by MenuItem / MenuRadioItem / ContextMenuItem:
 * a padded flex row with the base-ui `data-[highlighted]` accent tint. The
 * `data-[disabled]` styling is NOT here — only context-menu carries it, so it stays
 * local there.
 */
export const menuItemClass =
  'flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-on-accent'
