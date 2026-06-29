/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Keep this file free of Node/DOM imports so both sides can consume it.
 */

export const IPC = {
  /** Detect whether `vibe` / `vibe-acp` are installed and reachable. */
  detectVibe: 'vibe:detect',
  /** Start an ACP session for a given workspace directory. */
  acpStart: 'acp:start',
  /** Stop / dispose an ACP session. */
  acpStop: 'acp:stop',
  /** Renderer -> main: send a prompt into a session. */
  acpPrompt: 'acp:prompt',
  /** Main -> renderer: streamed ACP event for a session. */
  acpEvent: 'acp:event',
} as const

export interface VibeDetectResult {
  vibeFound: boolean
  vibeAcpFound: boolean
  vibeVersion: string | null
  /** Resolved absolute path to the vibe-acp binary, when found. */
  vibeAcpPath: string | null
  error: string | null
}

export interface AcpStartArgs {
  /** Absolute path to the workspace the agent should operate in. */
  workspaceDir: string
}

export interface AcpStartResult {
  sessionId: string
}

export interface AcpEvent {
  sessionId: string
  /** Raw ACP / JSON-RPC payload as received from vibe-acp. */
  payload: unknown
}
