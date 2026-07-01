/**
 * Format a Thread's `lastActiveAt` (epoch-ms) as a compact relative timestamp for
 * the sidebar thread rows — "2m" / "3h" / "yesterday" / "Jul 1". PURE and
 * deterministic: `nowMs` is injected (never `Date.now()` inside), so the caller
 * passes a single `Date.now()` for a render pass and tests stay stable.
 *
 * A missing/zero timestamp (an unpersisted draft or synthesized live row, whose
 * `lastActiveAt` is 0) yields the empty string — such rows show no timestamp.
 * Buckets: <1min → "now"; <1h → "Nm"; <24h → "Nh"; the previous CALENDAR day →
 * "yesterday"; older → a localized short month/day ("Jul 1").
 */
export function formatRelativeTime(timestampMs: number, nowMs: number): string {
  if (!timestampMs || timestampMs <= 0) return ''
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const diff = nowMs - timestampMs
  if (diff < MIN) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  const now = new Date(nowMs)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - DAY
  if (timestampMs >= startOfYesterday && timestampMs < startOfToday) return 'yesterday'
  return new Date(timestampMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
