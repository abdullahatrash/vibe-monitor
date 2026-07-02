import { useSyncExternalStore } from 'react'

/**
 * Subscribe a component to a CSS media query, re-rendering when it flips (#193). Backs the
 * side panel's dual presentation — inline on wide windows, a Sheet on narrow (≤980px). A
 * thin `matchMedia` + `useSyncExternalStore` wrapper: SSR/no-DOM safe (a missing `window`
 * or `matchMedia` yields `false`), and the subscription tears down its listener on unmount.
 *
 * Note the `query` string must be STABLE across renders (a module constant), since a new
 * query re-subscribes; callers pass a fixed `'(max-width: 980px)'`, never an inline literal
 * rebuilt per render with changing values.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    () =>
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(query).matches
        : false,
    () => false,
  )
}
