import {
  DEFAULT_TERMINAL_ID,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_WRITE_CHARS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  type TerminalEvent,
} from '../../shared/ipc'

/** The reply of `openOrAttach` / `restart`: a live session's handle + reattach snapshot, or a spawn failure. */
export type TerminalSpawnResult =
  | { ok: true; terminalId: string; snapshot: string; exited: boolean }
  | { ok: false; error: string }

/**
 * The Workspace terminal sessions we host in MAIN (ADR-0014; t3code's server-side
 * `TerminalManager` mapped onto our no-server architecture). One PTY per Workspace
 * this slice (id `term-1`); the session OUTLIVES the renderer's Surface — a tab
 * switch or panel close unmounts the xterm view, and the next `openOrAttach`
 * replays the in-memory scrollback buffer instead of respawning. The PTY dies only
 * on explicit `close` (tab ×), Workspace removal, or app quit (`disposeAll`).
 *
 * Deliberately a FULL user shell (ADR-0014): no confinement, no approval gating —
 * the same posture as the user's own terminal, CLI parity with running `vibe` by
 * hand. The addressing boundary lives in the registrar (agentId -> pool -> cwd).
 *
 * The pty layer is an injected seam (`spawnPty`) so this core is unit-testable
 * with a fake PTY — node-pty is wired in `register-ipc.ts` only, keeping the
 * native module out of the test import graph.
 */

/** The slice of a node-pty `IPty` we depend on (injected; faked in tests). */
export interface PtyLike {
  pid: number
  onData(listener: (data: string) => void): void
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface SpawnPtyOptions {
  /** The shell executable to launch. */
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

/** Spawn one PTY. MAY THROW synchronously (missing shell) — callers walk the fallback chain. */
export type SpawnPtyFn = (options: SpawnPtyOptions) => PtyLike

/**
 * Scrollback retention cap, in characters (~a few thousand dense lines — the
 * renderer's xterm keeps its own 5k-line scrollback; this buffer only has to
 * cover the REATTACH replay). Trimmed at a line boundary so a replay never
 * starts mid-escape-sequence of a torn first line.
 */
export const MAX_SCROLLBACK_CHARS = 2_000_000

/** SIGTERM -> SIGKILL escalation grace (t3code's 1s). */
export const KILL_GRACE_MS = 1_000

/**
 * Env vars stripped from the shell's environment (t3code's blocklist model — a
 * small denylist, deliberately NOT an allowlist, so PATH/toolchain vars survive):
 * Electron/dev-server plumbing a user shell must not inherit.
 */
const ENV_BLOCKLIST = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_PORT', 'PORT', 'NODE_OPTIONS']
const ENV_BLOCKLIST_PREFIX = 'VIBE_MISTRO_'

/**
 * The ordered shell candidates (t3code `resolveShellCandidates`, POSIX): the
 * user's `$SHELL`, then common absolute fallbacks. NOT a login shell — the env
 * already comes from the login-shell probe (`shell-env.ts`), and `-l` would
 * re-source rc files into a second login context.
 */
export function shellCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh']
  return [...new Set(candidates.filter((c): c is string => typeof c === 'string' && c.length > 0))]
}

/** The PTY env: the resolved shell env minus the blocklist, holes dropped for node-pty. */
export function terminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (ENV_BLOCKLIST.includes(key) || key.startsWith(ENV_BLOCKLIST_PREFIX)) continue
    env[key] = value
  }
  return env
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)))

interface Session {
  terminalId: string
  pty: PtyLike
  /** The shell's cwd, retained so `restart` can respawn WITHOUT the agent (which
   *  may have been evicted since open — the session outlives it, ADR-0014). */
  cwd: string
  /** Retained scrollback for the reattach replay, capped at {@link MAX_SCROLLBACK_CHARS}. */
  scrollback: string
  exited: boolean
  /** The pending SIGKILL escalation timer, when a close is in flight. */
  killTimer: ReturnType<typeof setTimeout> | null
}

export interface TerminalManagerDeps {
  spawnPty: SpawnPtyFn
  /** The base environment (production: `getShellEnv()`). */
  env: NodeJS.ProcessEnv
  /** Publish one stream event to the renderer(s). */
  emit: (event: TerminalEvent) => void
  /** Injectable clock for the kill escalation (tests use fake timers). */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>()
  private readonly deps: TerminalManagerDeps

  constructor(deps: TerminalManagerDeps) {
    this.deps = deps
  }

  /**
   * Open the Workspace's shell session, or REATTACH to the live one. A running
   * session just replies with its scrollback snapshot (the Surface remounted); an
   * exited session is respawned fresh (its banner was seen — reopening the tab
   * means "give me a shell"); no session spawns one. Never throws: a spawn failure
   * (no usable shell / bad cwd) resolves `{ok:false}` for the Surface to render.
   */
  openOrAttach(
    workspaceId: string,
    options: { cwd: string; cols: number; rows: number },
  ): TerminalSpawnResult {
    const existing = this.sessions.get(workspaceId)
    if (existing && !existing.exited) {
      return { ok: true, terminalId: existing.terminalId, snapshot: existing.scrollback, exited: false }
    }
    if (existing) this.drop(workspaceId) // exited residue — respawn below
    return this.spawnInto(workspaceId, options.cwd, options.cols, options.rows)
  }

  /**
   * Spawn a fresh shell and register it as the Workspace's session (replacing any
   * prior record for the key). Walks the shell fallback chain; never throws — a
   * failure resolves `{ok:false}` and leaves NO session behind. Shared by
   * `openOrAttach` (fresh/exited) and `restart`.
   */
  private spawnInto(workspaceId: string, cwd: string, cols: number, rows: number): TerminalSpawnResult {
    const c = clamp(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    const r = clamp(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    const env = terminalEnv(this.deps.env)
    let pty: PtyLike | null = null
    let lastError: unknown = null
    for (const shell of shellCandidates(this.deps.env)) {
      try {
        pty = this.deps.spawnPty({ file: shell, args: [], cwd, env, cols: c, rows: r })
        break
      } catch (err) {
        lastError = err // missing/broken shell — walk the fallback chain
      }
    }
    if (!pty) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      console.error(`[vibe-mistro:terminal] spawn failed (${workspaceId}): ${message}`)
      return { ok: false, error: `Could not start a shell: ${message}` }
    }

    const session: Session = {
      terminalId: DEFAULT_TERMINAL_ID,
      pty,
      cwd,
      scrollback: '',
      exited: false,
      killTimer: null,
    }
    this.sessions.set(workspaceId, session)
    // Both callbacks guard on this session still being the CURRENT record for the
    // key — so after a `close` (record dropped) OR a `restart` (record REPLACED by
    // a fresh session object), the previous shell's late output/exit can't bleed
    // into the reopened/restarted session under the same id.
    pty.onData((data) => {
      if (this.sessions.get(workspaceId) !== session) return
      session.scrollback = capScrollback(session.scrollback + data)
      this.deps.emit({ workspaceId, terminalId: session.terminalId, event: { type: 'output', data } })
    })
    pty.onExit(({ exitCode }) => {
      session.exited = true
      this.cancelKillTimer(session)
      if (this.sessions.get(workspaceId) !== session) return
      this.deps.emit({ workspaceId, terminalId: session.terminalId, event: { type: 'exited', exitCode } })
    })
    return { ok: true, terminalId: session.terminalId, snapshot: '', exited: false }
  }

  /** Forward input to the session's PTY. Oversized writes are refused whole (logged). */
  write(workspaceId: string, data: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session || session.exited) return
    if (data.length > MAX_TERMINAL_WRITE_CHARS) {
      console.error(`[vibe-mistro:terminal] write refused: ${data.length} chars (${workspaceId})`)
      return
    }
    session.pty.write(data)
  }

  /** Resize the session's PTY, clamped to the shared bounds. */
  resize(workspaceId: string, cols: number, rows: number): void {
    const session = this.sessions.get(workspaceId)
    if (!session || session.exited) return
    session.pty.resize(
      clamp(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
      clamp(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
    )
  }

  /**
   * Kill the session (explicit tab close / Workspace removal): SIGTERM, then
   * SIGKILL after {@link KILL_GRACE_MS} if the process hasn't exited (t3code's
   * escalation). The session record drops immediately — a close is final, so
   * late output from the dying process is not re-buffered or re-emitted.
   */
  close(workspaceId: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session) return
    this.sessions.delete(workspaceId)
    this.killPty(session)
  }

  /**
   * Reset a session's retained scrollback (the Clear affordance) — the shell keeps
   * running; only the buffer used for the reattach replay is wiped, so a later
   * reattach starts blank instead of replaying pre-clear output. The renderer
   * clears its own xterm view; no session state beyond the buffer changes.
   */
  clear(workspaceId: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session) return
    session.scrollback = ''
  }

  /**
   * Kill the session's shell and spawn a FRESH one in the same cwd (the Restart
   * affordance) — revives an exited session too. The cwd is the session's own
   * (stored at open), so restart needs NO agent and works after eviction. The old
   * pty is killed with the same SIGTERM->SIGKILL escalation, but the map entry is
   * REPLACED by the fresh session first, so the dying shell's late output is
   * suppressed by the session-identity guard. Never throws — a respawn failure
   * resolves `{ok:false}` and leaves no session (the caller renders the error).
   */
  restart(workspaceId: string, cols: number, rows: number): TerminalSpawnResult {
    const session = this.sessions.get(workspaceId)
    if (!session) return { ok: false, error: 'No terminal session to restart.' }
    const result = this.spawnInto(workspaceId, session.cwd, cols, rows) // replaces the map entry ON SUCCESS
    this.killPty(session) // AFTER the swap, so its late output routes to the dropped session
    // A respawn failure leaves the OLD (now-killed) session still mapped — drop it
    // so restart-fail leaves no zombie, and the dying shell's exit is suppressed.
    if (!result.ok && this.sessions.get(workspaceId) === session) this.sessions.delete(workspaceId)
    return result
  }

  /**
   * SIGTERM the session's shell, escalating to SIGKILL after {@link KILL_GRACE_MS}
   * if it lingers (t3code's escalation). Operates on the session's pty alone —
   * the caller owns the map (close removes, restart replaces), so this never
   * touches `sessions`. A no-op on an already-exited session.
   */
  private killPty(session: Session): void {
    if (session.exited) return
    try {
      session.pty.kill('SIGTERM')
    } catch {
      return // already-dead process — nothing to escalate
    }
    const setTimeoutFn = this.deps.setTimeoutFn ?? setTimeout
    session.killTimer = setTimeoutFn(() => {
      if (session.exited) return
      try {
        session.pty.kill('SIGKILL')
      } catch {
        // Exited between the check and the kill — the escalation is moot.
      }
    }, KILL_GRACE_MS)
    // Don't hold the process open for a grace timer alone (Electron quit path).
    ;(session.killTimer as { unref?: () => void }).unref?.()
  }

  /** Whether the Workspace currently has a session (running or exited residue). */
  has(workspaceId: string): boolean {
    return this.sessions.has(workspaceId)
  }

  /** Kill every session (app quit). */
  disposeAll(): void {
    for (const workspaceId of [...this.sessions.keys()]) this.close(workspaceId)
  }

  /** Drop a session record without kill semantics (exited residue being respawned). */
  private drop(workspaceId: string): void {
    const session = this.sessions.get(workspaceId)
    if (!session) return
    this.cancelKillTimer(session)
    this.sessions.delete(workspaceId)
  }

  private cancelKillTimer(session: Session): void {
    if (session.killTimer === null) return
    const clearTimeoutFn = this.deps.clearTimeoutFn ?? clearTimeout
    clearTimeoutFn(session.killTimer)
    session.killTimer = null
  }
}

/**
 * Cap the reattach buffer, trimming at a line boundary past the cap so a replay
 * never opens mid-line (mirrors t3code's line-capped history, char-budgeted here
 * to avoid re-counting lines on every chunk).
 */
export function capScrollback(buffer: string): string {
  if (buffer.length <= MAX_SCROLLBACK_CHARS) return buffer
  const cut = buffer.length - MAX_SCROLLBACK_CHARS
  const newline = buffer.indexOf('\n', cut)
  return newline === -1 ? buffer.slice(cut) : buffer.slice(newline + 1)
}
