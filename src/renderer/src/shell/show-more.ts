/**
 * Client-side "Show more" truncation for the sidebar's thread list (renderer-only —
 * a plain list cap with an expand toggle, no IPC/persistence). PURE so the branching
 * is unit-tested: below the cap (or once expanded) every row shows; otherwise only
 * the first `limit` — PLUS any row matched by `isPinned` that would otherwise be
 * hidden. Pinning keeps the currently-SELECTED thread visible even when it sorts
 * below the cap, so opening an older thread never makes its sidebar row vanish
 * (the row stays highlighted while collapsed; the toggle still reveals the rest).
 */
export function visibleRows<T>(
  rows: readonly T[],
  limit: number,
  expanded: boolean,
  isPinned?: (row: T) => boolean,
): T[] {
  if (expanded || rows.length <= limit) return [...rows]
  const head = rows.slice(0, limit)
  if (isPinned) {
    const pinnedBelow = rows.slice(limit).filter(isPinned)
    if (pinnedBelow.length > 0) return [...head, ...pinnedBelow]
  }
  return head
}
