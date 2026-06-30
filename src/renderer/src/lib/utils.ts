import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Compose Tailwind class strings: `clsx` flattens conditionals/arrays/objects and
 * drops falsy values, then `tailwind-merge` resolves conflicts last-wins (so a
 * later `rounded-lg` overrides an earlier `rounded-none`). Use this anywhere a
 * component takes a `className` override or toggles utilities conditionally.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
