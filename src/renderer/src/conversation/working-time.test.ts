import { describe, it, expect } from 'vitest'
import { formatElapsed } from './working-time'

/**
 * Working-indicator elapsed formatting (#115): seconds → "12s" / "1m 05s". Pure.
 */
describe('formatElapsed', () => {
  it('renders sub-minute durations as bare seconds', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12)).toBe('12s')
    expect(formatElapsed(59)).toBe('59s')
  })

  it('renders a minute or more as `Nm SSs` with zero-padded seconds', () => {
    expect(formatElapsed(60)).toBe('1m 00s')
    expect(formatElapsed(65)).toBe('1m 05s')
    expect(formatElapsed(600)).toBe('10m 00s')
    expect(formatElapsed(3599)).toBe('59m 59s')
  })

  it('floors fractional seconds and clamps negatives to 0s', () => {
    expect(formatElapsed(12.9)).toBe('12s')
    expect(formatElapsed(-5)).toBe('0s')
  })
})
