/**
 * Terminal domain of the shared IPC contract (ADR-0014): the side panel's Terminal
 * Surface drives a real PTY shell hosted in the MAIN process. Deliberately a FULL,
 * UNCONFINED user shell — CLI parity, the ADR-0004 posture, in contrast to the
 * confined `files:*` reads — so the safety boundary is ADDRESSING, not confinement:
 * `terminal:open` is `agentId`-addressed (#188 F3 model), the cwd is resolved
 * main-side from the warm agent's own `workspaceDir`, and the renderer can only
 * open a shell in a CONNECTED Workspace. Keep this file free of Node/DOM imports.
 */

/** The terminal channel entries, merged into the single `IPC` const in `./index`. */
export const terminalChannels = {
  /** Open — or REATTACH to — the Workspace's shell session; replies with the scrollback snapshot. */
  terminalOpen: 'terminal:open',
  /** Forward keystrokes/paste bytes to the session's PTY. */
  terminalWrite: 'terminal:write',
  /** Resize the PTY to the xterm viewport's cols × rows. */
  terminalResize: 'terminal:resize',
  /** Kill the session's PTY (explicit tab close / Workspace teardown). */
  terminalClose: 'terminal:close',
  /** Reset the session's retained scrollback (the Clear affordance) — shell keeps running. */
  terminalClear: 'terminal:clear',
  /** Kill + respawn the session's shell in the same cwd (the Restart affordance). */
  terminalRestart: 'terminal:restart',
  /** Main -> renderer: a session's live stream — see {@link TerminalEvent}. */
  terminalEvent: 'terminal:event',
} as const

/**
 * Bounds, mirrored from t3code's schema caps: one write is at most 64 KiB of
 * UTF-16 units (a paste larger than this is rejected main-side, never split —
 * the renderer chunks if it ever needs to), and cols/rows are clamped to sane
 * PTY ranges so a hostile/buggy resize can't wedge the pty layer.
 */
export const MAX_TERMINAL_WRITE_CHARS = 65_536
export const MIN_TERMINAL_COLS = 1
export const MAX_TERMINAL_COLS = 1_000
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 500

/**
 * This slice's single per-Workspace session id (t3code's client-chosen `term-1`
 * convention). Multiple terminals per Workspace (slice 3) mint `term-2`… and lift
 * the id into the args; every event already carries it so the stream shape is
 * forward-compatible.
 */
export const DEFAULT_TERMINAL_ID = 'term-1'

export interface TerminalOpenArgs {
  /** The warm agent whose Workspace dir becomes the shell's cwd (pool-resolved, #188 F3). */
  agentId: string
  /** Our Workspace id — the session key all later calls address. */
  workspaceId: string
  /** The xterm viewport's initial size (already fitted before open). */
  cols: number
  rows: number
}

export type TerminalOpenResult =
  // `snapshot` is the session's buffered scrollback: empty for a fresh spawn, the
  // replay buffer when REATTACHING to a shell that kept running behind a closed
  // tab/panel. `terminalId` tags which session the stream events will carry.
  | { ok: true; terminalId: string; snapshot: string; exited: boolean }
  // Unknown/cold agent, spawn failure (no usable shell), or a bad cwd.
  | { ok: false; error: string }

export interface TerminalWriteArgs {
  workspaceId: string
  /** Raw bytes from `xterm.onData` (UTF-8 text, control sequences included). */
  data: string
}

export interface TerminalResizeArgs {
  workspaceId: string
  cols: number
  rows: number
}

export interface TerminalCloseArgs {
  workspaceId: string
}

export interface TerminalClearArgs {
  workspaceId: string
}

export interface TerminalRestartArgs {
  workspaceId: string
  /** The xterm viewport's current size, so the fresh shell spawns already fitted. */
  cols: number
  rows: number
}

/**
 * One live-stream event on the `terminal:event` channel, tagged by Workspace +
 * session so the renderer filters exactly like `acp:event` payloads route by
 * session. `output` is a verbatim UTF-8 chunk for `xterm.write`; `exited`
 * reports the shell's end (the Surface renders a banner and stops writing —
 * the session's scrollback is retained main-side until the tab closes).
 */
export interface TerminalEvent {
  workspaceId: string
  terminalId: string
  event: { type: 'output'; data: string } | { type: 'exited'; exitCode: number }
}
