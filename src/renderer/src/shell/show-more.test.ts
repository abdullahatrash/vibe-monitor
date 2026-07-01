import { describe, expect, it } from 'vitest'
import { visibleRows } from './show-more'

describe('visibleRows', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7]

  it('returns every row when at or below the cap', () => {
    expect(visibleRows([1, 2, 3], 5, false)).toEqual([1, 2, 3])
    expect(visibleRows([1, 2, 3, 4, 5], 5, false)).toEqual([1, 2, 3, 4, 5])
  })

  it('caps to the limit when collapsed and over the cap', () => {
    expect(visibleRows(rows, 5, false)).toEqual([1, 2, 3, 4, 5])
  })

  it('returns every row when expanded, regardless of the cap', () => {
    expect(visibleRows(rows, 5, true)).toEqual(rows)
  })

  it('does not mutate or alias the input', () => {
    const out = visibleRows(rows, 100, false)
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })

  it('pins a below-cap match into the collapsed view (selected thread stays visible)', () => {
    // row 7 sorts below the cap; pinning it keeps it visible while collapsed.
    expect(visibleRows(rows, 5, false, (r) => r === 7)).toEqual([1, 2, 3, 4, 5, 7])
  })

  it('does not duplicate a pinned row already within the cap', () => {
    expect(visibleRows(rows, 5, false, (r) => r === 2)).toEqual([1, 2, 3, 4, 5])
  })

  it('ignores the pin once expanded (all rows show anyway)', () => {
    expect(visibleRows(rows, 5, true, (r) => r === 7)).toEqual(rows)
  })
})
