import { describe, it, expect } from 'vitest'
import { cn } from './utils'

/**
 * `cn` is the className composer used across the new UI layer. Its contract: drop
 * falsy inputs (so `condition && 'cls'` is safe), and resolve conflicting Tailwind
 * utilities last-wins via tailwind-merge — this is what guarantees a caller's
 * override actually wins instead of producing two fighting classes.
 */
describe('cn', () => {
  it('resolves conflicting utilities last-wins (radius cannot regress to square→round silently)', () => {
    expect(cn('rounded-none', 'rounded-lg')).toBe('rounded-lg')
    expect(cn('rounded-lg', 'rounded-none')).toBe('rounded-none')
  })

  it('keeps the conditional class when the condition is true', () => {
    const active = true
    expect(cn('text-muted', active && 'text-accent-text')).toBe('text-accent-text')
  })

  it('drops the conditional class (and the base wins) when the condition is false', () => {
    const active = false
    expect(cn('text-muted', active && 'text-accent-text')).toBe('text-muted')
  })

  it('drops falsy inputs (false / null / undefined / empty)', () => {
    expect(cn('p-2', false, null, undefined, '', 'm-2')).toBe('p-2 m-2')
  })

  it('flattens arrays and merges conflicts across them', () => {
    expect(cn(['px-2', 'px-4'], 'py-1')).toBe('px-4 py-1')
  })

  it('returns an empty string when given nothing actionable', () => {
    expect(cn(false, null, undefined)).toBe('')
  })
})
