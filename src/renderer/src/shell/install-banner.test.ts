import { describe, expect, it } from 'vitest'
import type { VibeDetectResult } from '../../../shared/ipc'
import { INSTALL_HINT } from '../../../shared/install-guidance'
import { installBannerMessage } from './install-banner'

function detectResult(overrides: Partial<VibeDetectResult> = {}): VibeDetectResult {
  return {
    vibeFound: true,
    vibeAcpFound: true,
    vibeVersion: '1.0.0',
    vibeAcpPath: '/usr/local/bin/vibe-acp',
    error: null,
    ...overrides,
  }
}

const HIDDEN = { inSettings: false, installOutletVisible: false }

describe('installBannerMessage', () => {
  it('hides while detection is still pending (no flash before the check resolves)', () => {
    expect(installBannerMessage({ detect: null, ...HIDDEN })).toBeNull()
  })

  it('hides when both binaries are found', () => {
    expect(installBannerMessage({ detect: detectResult(), ...HIDDEN })).toBeNull()
  })

  it('shows the detect error when vibe is missing', () => {
    const detect = detectResult({ vibeFound: false, vibeAcpFound: false, error: 'nope' })
    expect(installBannerMessage({ detect, ...HIDDEN })).toBe('nope')
  })

  it('shows when only vibe-acp is missing', () => {
    const detect = detectResult({ vibeAcpFound: false, error: 'acp missing' })
    expect(installBannerMessage({ detect, ...HIDDEN })).toBe('acp missing')
  })

  it('falls back to the canonical hint when detect carries no error string', () => {
    const detect = detectResult({ vibeFound: false, error: null })
    expect(installBannerMessage({ detect, ...HIDDEN })).toContain(INSTALL_HINT)
  })

  it('hides on the Settings page (Environment panel already shows the status)', () => {
    const detect = detectResult({ vibeFound: false, error: 'nope' })
    expect(
      installBannerMessage({ detect, inSettings: true, installOutletVisible: false }),
    ).toBeNull()
  })

  it('hides when the needs-install first-run outlet is already on screen', () => {
    const detect = detectResult({ vibeFound: false, error: 'nope' })
    expect(
      installBannerMessage({ detect, inSettings: false, installOutletVisible: true }),
    ).toBeNull()
  })
})
