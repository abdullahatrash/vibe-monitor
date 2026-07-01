/**
 * Working-indicator elapsed formatting (#115) — the PURE seconds → label used by
 * the self-ticking "Working for …" timer (adapted from t3code's WorkingTimer, but
 * with OUR zero-padded `m ss` shape). Under a minute reads as bare seconds
 * (`0s`, `12s`); a minute or more reads `Nm SSs` with two-digit seconds
 * (`1m 05s`, `10m 00s`). DOM-free so it's unit-tested as data
 * (`working-time.test.ts`); the component only pushes this string into a text node.
 */
export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rem = seconds % 60
  return `${minutes}m ${String(rem).padStart(2, '0')}s`
}
