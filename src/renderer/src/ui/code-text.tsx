import type { JSX } from 'react'

/**
 * Render a copy string with `backtick` spans as inline <code> — so plain-string
 * copy shared with main (e.g. shared/install-guidance) keeps its code styling
 * in JSX surfaces without duplicating the wording per surface.
 */
export function CodeText({ text }: { text: string }): JSX.Element {
  const parts = text.split('`')
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>,
      )}
    </>
  )
}
