import type { VibeDetectResult } from '../../../shared/ipc'
import { INSTALL_HINT } from '../../../shared/install-guidance'

/**
 * Pure derivation (no React, no IPC) of the persistent missing-CLI banner: the
 * message to show, or null to hide. Visible whenever detection says `vibe` /
 * `vibe-acp` is missing, EXCEPT where a fuller version of the same guidance is
 * already on screen — the needs-install first-run outlet and the Settings page
 * (Environment panel). A still-pending detection (null) never shows the banner
 * (same no-flash rule as `firstRunState`).
 */
export function installBannerMessage(args: {
  detect: VibeDetectResult | null
  inSettings: boolean
  installOutletVisible: boolean
}): string | null {
  const { detect, inSettings, installOutletVisible } = args
  if (detect === null || (detect.vibeFound && detect.vibeAcpFound)) return null
  if (inSettings || installOutletVisible) return null
  return detect.error ?? `Mistral Vibe CLI not found. ${INSTALL_HINT}`
}
