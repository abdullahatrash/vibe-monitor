import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { VibeDetectResult } from '../shared/ipc'
import { INSTALL_HINT } from '../shared/install-guidance'
import { getShellEnv } from './shell-env'

const execFileAsync = promisify(execFile)

/** Locate a binary on PATH using the platform's `which` / `where`. */
async function which(binary: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(finder, [binary], { env: getShellEnv() })
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
    return first ?? null
  } catch {
    return null
  }
}

/**
 * Detect whether the Mistral Vibe CLI and its ACP server are installed.
 * This mirrors CodexMonitor's `check_codex_installation`, but for `vibe`.
 */
export async function detectVibe(): Promise<VibeDetectResult> {
  const result: VibeDetectResult = {
    vibeFound: false,
    vibeAcpFound: false,
    vibeVersion: null,
    vibeAcpPath: null,
    error: null,
  }

  try {
    const vibePath = await which('vibe')
    result.vibeFound = vibePath !== null

    const vibeAcpPath = await which('vibe-acp')
    result.vibeAcpFound = vibeAcpPath !== null
    result.vibeAcpPath = vibeAcpPath

    if (result.vibeFound) {
      try {
        const { stdout } = await execFileAsync('vibe', ['--version'], { env: getShellEnv() })
        result.vibeVersion = stdout.trim() || null
      } catch {
        // Version probe failed but binary exists; leave version null.
      }
    }

    // Specific first sentence + the ONE canonical install hint (shared/install-guidance)
    // — the same copy every missing-CLI surface shows (first-run screen, banner, spawn error).
    if (!result.vibeFound) {
      result.error = `Mistral Vibe CLI not found. ${INSTALL_HINT}`
    } else if (!result.vibeAcpFound) {
      result.error = `\`vibe\` was found but \`vibe-acp\` is not on PATH. ${INSTALL_HINT}`
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  return result
}
