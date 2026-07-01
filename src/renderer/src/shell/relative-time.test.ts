import { describe, expect, it } from 'vitest'
import { formatRelativeTime } from './relative-time'

// A fixed local noon so the "yesterday" / older calendar math is TZ-stable
// (noon minus a whole day is unambiguously the previous calendar date).
const NOON = new Date(2026, 6, 1, 12, 0, 0).getTime() // 2026-07-01 12:00 local

describe('formatRelativeTime', () => {
  it('returns empty for a missing/zero timestamp (draft / synth row)', () => {
    expect(formatRelativeTime(0, NOON)).toBe('')
    expect(formatRelativeTime(-1, NOON)).toBe('')
  })

  it('shows "now" under a minute (and for a future timestamp)', () => {
    expect(formatRelativeTime(NOON - 30_000, NOON)).toBe('now')
    expect(formatRelativeTime(NOON + 5_000, NOON)).toBe('now')
  })

  it('shows minutes under an hour', () => {
    expect(formatRelativeTime(NOON - 2 * 60_000, NOON)).toBe('2m')
    expect(formatRelativeTime(NOON - 59 * 60_000, NOON)).toBe('59m')
  })

  it('shows hours under a day', () => {
    expect(formatRelativeTime(NOON - 3 * 3_600_000, NOON)).toBe('3h')
    expect(formatRelativeTime(NOON - 23 * 3_600_000, NOON)).toBe('23h')
  })

  it('shows "yesterday" for the previous calendar day', () => {
    expect(formatRelativeTime(NOON - 26 * 3_600_000, NOON)).toBe('yesterday') // ~10am yesterday
  })

  it('shows a short month/day for older timestamps', () => {
    expect(formatRelativeTime(new Date(2026, 5, 20, 9, 0, 0).getTime(), NOON)).toBe('Jun 20')
  })
})
