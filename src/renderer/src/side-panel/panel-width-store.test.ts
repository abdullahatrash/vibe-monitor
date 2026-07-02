import { describe, expect, it, vi } from 'vitest'
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  getPanelWidth,
  MAX_PANEL_WIDTH_PX,
  maxPanelWidth,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_STORAGE_KEY,
  setPanelWidth,
  type PanelWidthStorage,
} from './panel-width-store'

/** A wide-desktop viewport where the 0.7 fraction (1344) is the binding ceiling. */
const VIEWPORT = 1920

/** A throwaway in-memory Storage seam for the tests. */
function fakeStorage(
  seed?: Record<string, string>,
): PanelWidthStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('maxPanelWidth', () => {
  it('takes 70% of the viewport when below the hard ceiling', () => {
    expect(maxPanelWidth(1000)).toBe(700)
    expect(maxPanelWidth(VIEWPORT)).toBe(Math.floor(VIEWPORT * 0.7))
  })

  it('hard-caps at MAX_PANEL_WIDTH_PX on very wide viewports', () => {
    expect(maxPanelWidth(4000)).toBe(MAX_PANEL_WIDTH_PX)
  })

  it('never dips below MIN on a degenerate viewport (clamp range must not invert)', () => {
    expect(maxPanelWidth(100)).toBe(MIN_PANEL_WIDTH)
    expect(maxPanelWidth(0)).toBe(MIN_PANEL_WIDTH)
  })

  it('falls back to the hard ceiling on a non-finite viewport', () => {
    expect(maxPanelWidth(Number.NaN)).toBe(MAX_PANEL_WIDTH_PX)
    expect(maxPanelWidth(Number.POSITIVE_INFINITY)).toBe(MAX_PANEL_WIDTH_PX)
  })
})

describe('clampPanelWidth', () => {
  it('passes an in-range width through unchanged', () => {
    expect(clampPanelWidth(DEFAULT_PANEL_WIDTH, VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
    expect(clampPanelWidth(800, VIEWPORT)).toBe(800)
  })

  it('clamps below the minimum up to MIN', () => {
    expect(clampPanelWidth(MIN_PANEL_WIDTH - 100, VIEWPORT)).toBe(MIN_PANEL_WIDTH)
    expect(clampPanelWidth(0, VIEWPORT)).toBe(MIN_PANEL_WIDTH)
    expect(clampPanelWidth(-50, VIEWPORT)).toBe(MIN_PANEL_WIDTH)
  })

  it('clamps above the viewport-relative maximum', () => {
    expect(clampPanelWidth(10_000, VIEWPORT)).toBe(maxPanelWidth(VIEWPORT))
    expect(clampPanelWidth(900, 1000)).toBe(700)
  })

  it('falls back to the default (itself clamped) on a non-finite width', () => {
    expect(clampPanelWidth(Number.NaN, VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
    // Viewport whose ceiling (~489) is under the default 540: fallback fits it.
    expect(clampPanelWidth(Number.NaN, 700)).toBe(maxPanelWidth(700))
  })
})

describe('getPanelWidth', () => {
  it('returns the default when storage is missing or empty', () => {
    expect(getPanelWidth(null, VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
    expect(getPanelWidth(undefined, VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
    expect(getPanelWidth(fakeStorage(), VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
  })

  it('returns the stored width clamped to the current viewport', () => {
    expect(getPanelWidth(fakeStorage({ [PANEL_WIDTH_STORAGE_KEY]: '640' }), VIEWPORT)).toBe(640)
    // Persisted on a wide monitor, read back in a 1000px window: 0.7 ceiling binds.
    expect(getPanelWidth(fakeStorage({ [PANEL_WIDTH_STORAGE_KEY]: '1300' }), 1000)).toBe(700)
  })

  it('falls back to the default on a corrupt value', () => {
    expect(getPanelWidth(fakeStorage({ [PANEL_WIDTH_STORAGE_KEY]: 'garbage' }), VIEWPORT)).toBe(
      DEFAULT_PANEL_WIDTH,
    )
  })

  it('falls back to the default when the store throws', () => {
    const storage: PanelWidthStorage = {
      getItem: vi.fn(() => {
        throw new Error('blocked')
      }),
      setItem: vi.fn(),
    }
    expect(getPanelWidth(storage, VIEWPORT)).toBe(DEFAULT_PANEL_WIDTH)
  })
})

describe('setPanelWidth', () => {
  it('persists the clamped width under the single key', () => {
    const storage = fakeStorage()
    setPanelWidth(storage, 10_000, VIEWPORT)
    expect(storage.map.get(PANEL_WIDTH_STORAGE_KEY)).toBe(String(maxPanelWidth(VIEWPORT)))
  })

  it('tolerates a missing or throwing store', () => {
    expect(() => setPanelWidth(null, 500, VIEWPORT)).not.toThrow()
    const storage: PanelWidthStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error('quota')
      }),
    }
    expect(() => setPanelWidth(storage, 500, VIEWPORT)).not.toThrow()
  })
})
