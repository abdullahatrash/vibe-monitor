import type { JSX } from 'react'
import { cn } from '../lib/utils'

/** The mark's intrinsic aspect ratio (viewBox 191×135), same as {@link Logo}. */
const LOGO_RATIO = 191 / 135

/** How long one full lap of the snake takes. */
const SNAKE_DURATION_S = 1.1

/**
 * The Vibe Mistro "M" mark's 8 cells, ORDERED as a snake path that traces the
 * letter — top-left → down the left side → across the middle bar → the three legs →
 * up the right side → top-right — so the phased highlight reads as a light snaking
 * around the M rather than a flat shimmer. Each cell keeps its own brand fill
 * (yellow → orange → red), revealed as the bright "head" passes over it.
 */
const SNAKE_PATH: ReadonlyArray<{ d: string; fill: string }> = [
  { d: 'M54.3221 0H27.1531V27.0892H54.3221V0Z', fill: '#FFD800' }, // top-left
  { d: 'M81.4823 27.0918H27.1531V54.181H81.4823V27.0918Z', fill: '#FFAF00' }, // upper-left
  { d: 'M162.972 54.168H27.1531V81.2572H162.972V54.168Z', fill: '#FF8205' }, // middle bar
  { d: 'M54 81H27V135H54V81Z', fill: '#FA500F' }, // left leg
  { d: 'M108.661 81.2598H81.4917V108.349H108.661V81.2598Z', fill: '#FA500F' }, // center leg
  { d: 'M163 81H136V135H163V81Z', fill: '#FA500F' }, // right leg
  { d: 'M162.99 27.0918H108.661V54.181H162.99V27.0918Z', fill: '#FFAF00' }, // upper-right
  { d: 'M162.984 0H135.815V27.0892H162.984V0Z', fill: '#FFD800' }, // top-right
]

/**
 * A branded loading indicator (the "funky" spinner): a light snakes around the
 * Vibe Mistro "M", a port of the vibe-acp CLI's `SnakeSpinner` in our brand palette.
 * Pure CSS — each cell runs the shared `vmSnake` keyframe (styles.css) phased by a
 * negative `animationDelay` along {@link SNAKE_PATH}, so a bright head + short trail
 * chase through the mark. `prefers-reduced-motion` freezes it to a static dim M.
 * `size` is the HEIGHT in px (width scales to the 191:135 ratio); drop-in for the
 * old lucide spinner at the sidebar's streaming indicators.
 */
export function LogoSnakeSpinner({
  size = 14,
  className,
  label = 'Working',
}: {
  size?: number
  className?: string
  /** Accessible name — the streaming context ("Streaming", "This project is working"). */
  label?: string
}): JSX.Element {
  return (
    <svg
      role="img"
      aria-label={label}
      className={cn('shrink-0', className)}
      width={Math.round(size * LOGO_RATIO)}
      height={size}
      viewBox="0 0 191 135"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SNAKE_PATH.map((cell, i) => (
        <path
          key={cell.d}
          d={cell.d}
          fill={cell.fill}
          className="vm-snake-cell"
          style={{ animationDelay: `${-(i / SNAKE_PATH.length) * SNAKE_DURATION_S}s` }}
        />
      ))}
    </svg>
  )
}
