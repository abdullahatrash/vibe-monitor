import { describe, expect, it } from 'vitest'
import {
  SIDE_PANEL_OPEN_STORAGE_KEY,
  getSidePanelOpen,
  setSidePanelOpen,
  type SidePanelOpenStorage,
} from './side-panel-open-store'

function fakeStorage(initial: Record<string, string> = {}): SidePanelOpenStorage & {
  data: Record<string, string>
} {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

describe('side-panel-open-store', () => {
  it('defaults to CLOSED when nothing is stored', () => {
    expect(getSidePanelOpen(fakeStorage())).toBe(false)
  })

  it('round-trips open and closed', () => {
    const storage = fakeStorage()
    setSidePanelOpen(storage, true)
    expect(getSidePanelOpen(storage)).toBe(true)
    setSidePanelOpen(storage, false)
    expect(getSidePanelOpen(storage)).toBe(false)
  })

  it('treats an unknown stored value as closed', () => {
    expect(getSidePanelOpen(fakeStorage({ [SIDE_PANEL_OPEN_STORAGE_KEY]: 'maybe' }))).toBe(false)
  })

  it('tolerates an absent storage', () => {
    expect(getSidePanelOpen(null)).toBe(false)
    expect(() => setSidePanelOpen(undefined, true)).not.toThrow()
  })

  it('tolerates a throwing storage', () => {
    const throwing: SidePanelOpenStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    expect(getSidePanelOpen(throwing)).toBe(false)
    expect(() => setSidePanelOpen(throwing, true)).not.toThrow()
  })
})
