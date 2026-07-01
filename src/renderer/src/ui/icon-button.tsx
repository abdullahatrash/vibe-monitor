import type { ComponentProps, JSX } from 'react'
import { Button } from './button'

/**
 * A {@link Button} pre-set to a square icon size — the app has many icon-only
 * affordances (kebab, close, expand, send). Defaults to `variant="ghost"` +
 * `size="icon"`; both are still overridable. Wrap the lucide glyph as the child.
 */
export function IconButton({
  variant = 'ghost',
  size = 'icon',
  ...props
}: ComponentProps<typeof Button>): JSX.Element {
  return <Button data-slot="icon-button" variant={variant} size={size} {...props} />
}
