import type { JSX } from 'react'

/**
 * The Vibe Mistro "M" mark — a rounded square filled with the vertical brand
 * gradient (`--accent-grad-logo`) and a white "M". Sized by `size` (px): 30 in the
 * sidebar header, 52 on the empty-state hero (per the tokens doc). The gradient is
 * applied as an inline style so it resolves the CSS var directly (robust under the
 * Vite/Electron build); everything else is token-driven.
 */
export function Logo({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.58),
        backgroundImage: 'var(--accent-grad-logo)',
      }}
    >
      M
    </span>
  )
}
