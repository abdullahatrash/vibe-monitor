import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'

/**
 * Resolve the user's interactive-shell environment.
 *
 * A packaged Electron app launched from Finder/Dock (macOS) or a desktop
 * launcher (Linux) does NOT inherit the PATH from the user's shell rc files.
 * As a result `vibe` / `vibe-acp` — typically installed under ~/.local/bin,
 * a version manager, or Homebrew — are invisible to `which` using the bare
 * process env. We fix this by spawning the login+interactive shell once and
 * importing its environment.
 *
 * Adapted from the approach used by opencode's desktop app.
 */

const PROBE_TIMEOUT_MS = 5_000

let cached: NodeJS.ProcessEnv | null = null

function getUserShell(): string {
  try {
    return process.env.SHELL || userInfo().shell || '/bin/sh'
  } catch {
    return process.env.SHELL || '/bin/sh'
  }
}

function parseNullDelimitedEnv(out: Buffer): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of out.toString('utf8').split('\0')) {
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

function probe(shell: string, mode: '-il' | '-l'): Record<string, string> | null {
  const result = spawnSync(shell, [mode, '-c', 'env -0'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error || result.status !== 0 || !result.stdout) return null
  const env = parseNullDelimitedEnv(result.stdout)
  return Object.keys(env).length > 0 ? env : null
}

/**
 * The merged environment to use for locating and spawning Vibe binaries.
 * On Windows the process env already reflects the user environment, so we
 * skip shell probing. The result is cached for the lifetime of the process.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  if (cached) return cached
  if (process.platform === 'win32') {
    cached = process.env
    return cached
  }

  const shell = getUserShell()
  const shellEnv = probe(shell, '-il') ?? probe(shell, '-l')
  // Process env wins for anything Electron set intentionally; shell env fills
  // in PATH and friends that Finder/Dock launches drop.
  cached = { ...shellEnv, ...process.env }
  if (shellEnv?.PATH) cached.PATH = shellEnv.PATH
  return cached
}
