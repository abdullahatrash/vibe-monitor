import type { JSX } from 'react'

/** The official mark's intrinsic aspect ratio (viewBox 191×135). */
const LOGO_RATIO = 191 / 135

/**
 * The official Vibe Mistro "M" mark — an inline SVG of the stepped brand palette
 * (yellow → orange). Inline (not a raster asset) so it scales crisply and adds no
 * bundle image. `size` is the HEIGHT in px (30 in the sidebar header, 52 on the
 * empty-state hero, per the tokens doc); width scales to the mark's 191:135 ratio.
 * The logo keeps its own brand fills — independent of the softer UI accent tokens.
 */
export function Logo({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg
      aria-hidden
      className="shrink-0"
      width={Math.round(size * LOGO_RATIO)}
      height={size}
      viewBox="0 0 191 135"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M54.3221 0H27.1531V27.0892H54.3221V0Z" fill="#FFD800" />
      <path d="M162.984 0H135.815V27.0892H162.984V0Z" fill="#FFD800" />
      <path d="M81.4823 27.0918H27.1531V54.181H81.4823V27.0918Z" fill="#FFAF00" />
      <path d="M162.99 27.0918H108.661V54.181H162.99V27.0918Z" fill="#FFAF00" />
      <path d="M162.972 54.168H27.1531V81.2572H162.972V54.168Z" fill="#FF8205" />
      <path d="M54 81H27V135H54V81Z" fill="#FA500F" />
      <path d="M108.661 81.2598H81.4917V108.349H108.661V81.2598Z" fill="#FA500F" />
      <path d="M163 81H136V135H163V81Z" fill="#FA500F" />
    </svg>
  )
}
