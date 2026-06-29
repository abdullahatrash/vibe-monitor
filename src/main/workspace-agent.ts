import { EventEmitter } from 'node:events'
import { AcpClient, type SpawnFn } from './acp/client'
import { handleFsReadTextFile, type ReadTextFn } from './acp/fs-read'
import { handleFsWriteTextFile, type WriteTextFn } from './acp/fs-write'
import { classifyAuthError } from './auth/auth-state'
import type { PromptResult, ThreadInfo, ThreadModes, ThreadModels } from '../shared/ipc'

/**
 * A Workspace agent: one `vibe-acp` child process plus its `AcpClient`,
 * scoped to a single Workspace directory.
 *
 * Owns the ACP handshake (`initialize`) and opens Threads (`session/new`).
 * Per ADR-0001 it stays a thin protocol layer — it does not interpret
 * `session/update` traffic; it re-emits raw payloads on the `event` channel
 * for the renderer to reduce. Structured so a single agent can host many
 * Threads later; TB1 opens one.
 */

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-monitor', version: '0.0.1' } as const

export const AUTH_HINT =
  'Run `vibe` to sign in, or `vibe --setup` to configure your Mistral Vibe account.'
export const SPAWN_HINT =
  'Install Mistral Vibe and ensure `vibe-acp` is on your PATH, then run `vibe` to sign in.'

/** A failure surfaced to the renderer, optionally with an actionable hint. */
export class WorkspaceAgentError extends Error {
  readonly hint: string | null
  constructor(message: string, hint: string | null = null) {
    super(message)
    this.name = 'WorkspaceAgentError'
    this.hint = hint
  }
}

interface InitializeResult {
  protocolVersion?: number
  agentInfo?: { name?: string; title?: string; version?: string }
  agentCapabilities?: unknown
  authMethods?: unknown
}

interface SessionNewResult {
  sessionId: string
  title?: string | null
  modes?: ThreadModes
  models?: ThreadModels
}

export interface WorkspaceAgentOptions {
  /** Absolute path to the Workspace directory. */
  workspaceDir: string
  /** Resolved login-shell environment (PATH etc.) for spawning vibe-acp. */
  env?: NodeJS.ProcessEnv
  /** Override the launch command (default `vibe-acp`). */
  command?: string
  /** Injected process factory (testing). Forwarded to the AcpClient. */
  spawn?: SpawnFn
  /** Override the file reader used to serve `fs/read_text_file` (testing). */
  readTextFile?: ReadTextFn
  /** Override the file writer used to serve `fs/write_text_file` (testing). */
  writeTextFile?: WriteTextFn
}

export class WorkspaceAgent extends EventEmitter {
  private readonly client: AcpClient
  private readonly workspaceDir: string
  private readonly readTextFile?: ReadTextFn
  private readonly writeTextFile?: WriteTextFn
  /** Threads hosted by this agent, keyed by their ACP `sessionId`. */
  private readonly threads = new Map<string, ThreadInfo>()
  private initialized = false

  constructor(options: WorkspaceAgentOptions) {
    super()
    this.workspaceDir = options.workspaceDir
    this.readTextFile = options.readTextFile
    this.writeTextFile = options.writeTextFile
    this.client = new AcpClient({
      command: options.command,
      cwd: options.workspaceDir,
      env: options.env,
      spawn: options.spawn,
    })

    // Forward raw protocol + lifecycle events; we do not interpret them here.
    this.client.on('notification', (msg: unknown) => this.emit('event', msg))
    this.client.on('serverRequest', (msg: unknown) => this.onServerRequest(msg))
    this.client.on('stderr', (text: string) => this.emit('event', { type: 'stderr', text }))
    this.client.on('exit', (info: unknown) => this.emit('event', { type: 'exit', info }))
    this.client.on('error', (err: Error) => this.emit('event', { type: 'error', message: err.message }))
  }

  /**
   * Spawn vibe-acp and complete `initialize`. The `initialize` response is the
   * readiness signal; start is raced against an early process error/exit so a
   * failed spawn rejects instead of hanging.
   */
  async start(): Promise<void> {
    if (this.initialized) return

    let onError!: (err: Error) => void
    let onExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void

    const earlyFailure = new Promise<never>((_resolve, reject) => {
      onError = (err) => reject(this.mapSpawnError(err))
      onExit = (info) =>
        reject(
          new WorkspaceAgentError(
            `vibe-acp exited before it was ready (code=${info.code}, signal=${info.signal}).`,
            SPAWN_HINT,
          ),
        )
      this.client.on('error', onError)
      this.client.on('exit', onExit)
    })
    // The losing branch of the race rejects with no awaiter; swallow it.
    earlyFailure.catch(() => {})

    try {
      this.client.start()
    } catch (err) {
      this.detachStartGuards(onError, onExit)
      throw this.mapSpawnError(err)
    }

    try {
      await Promise.race([
        this.client.request<InitializeResult>('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
          clientInfo: CLIENT_INFO,
        }),
        earlyFailure,
      ])
      this.initialized = true
    } catch (err) {
      throw this.toAgentError(err)
    } finally {
      this.detachStartGuards(onError, onExit)
    }
  }

  /**
   * Open a Thread via `session/new` and map it to the returned ACP `sessionId`.
   * Returns the Thread info (sessionId, title placeholder, modes, models).
   */
  async openThread(): Promise<ThreadInfo> {
    if (!this.initialized) throw new WorkspaceAgentError('Agent is not initialized; call start() first.')

    let result: SessionNewResult
    try {
      result = await this.client.request<SessionNewResult>('session/new', {
        cwd: this.workspaceDir,
        mcpServers: [],
      })
    } catch (err) {
      throw this.toAgentError(err)
    }

    const thread: ThreadInfo = {
      sessionId: result.sessionId,
      // `session/new` returns no title in the capture — the Thread title arrives
      // later via the `session_info_update` notification (TB2). This is defensive.
      title: result.title ?? null,
      modes: result.modes ?? null,
      models: result.models ?? null,
    }
    this.threads.set(thread.sessionId, thread)
    return thread
  }

  /**
   * Send a prompt to a Thread (`session/prompt`) and resolve when the turn
   * ends. The streamed `session/update` notifications flow out on the `event`
   * channel; per ADR-0001 the renderer reduces them — we only own the turn's
   * lifecycle here. Resolves with `{stopReason, usage, userMessageId}`.
   */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    if (!this.threads.has(sessionId)) {
      throw new WorkspaceAgentError(`No open Thread for sessionId ${sessionId}.`)
    }

    try {
      return await this.client.request<PromptResult>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      })
    } catch (err) {
      throw this.toAgentError(err)
    }
  }

  /**
   * Answer a `session/request_permission` by the agent's JSON-RPC request id
   * with the option the user picked (docs/acp-capture.md §6). Per ADR-0001 the
   * decision is made in the renderer; main just relays the chosen `optionId`
   * back by id — no client-side allowlist, no persistence.
   */
  respondPermission(requestId: number | string, optionId: string): void {
    this.client.respond(requestId, { outcome: { outcome: 'selected', optionId } })
  }

  /**
   * Forward every server-initiated request for transparency, and serve the
   * file-I/O requests Vibe delegates to us so turns don't stall: `fs/read` for
   * reads and `fs/write` for approved writes (docs/acp-capture.md §5, §7).
   * `session/request_permission` is forwarded raw — the renderer renders the
   * approval prompt and answers via `respondPermission()` (ADR-0001).
   */
  private onServerRequest(msg: unknown): void {
    this.emit('event', msg)

    const request = msg as { id?: number | string; method?: string; params?: unknown }
    if (request.id === undefined) return
    if (request.method === 'fs/read_text_file') {
      void this.serveFsRead(request.id, request.params)
    } else if (request.method === 'fs/write_text_file') {
      void this.serveFsWrite(request.id, request.params)
    }
  }

  private async serveFsRead(id: number | string, params: unknown): Promise<void> {
    const outcome = await handleFsReadTextFile(params, this.readTextFile)
    if ('result' in outcome) this.client.respond(id, outcome.result)
    else this.client.respondError(id, outcome.error)
  }

  private async serveFsWrite(id: number | string, params: unknown): Promise<void> {
    const outcome = await handleFsWriteTextFile(params, {
      write: this.writeTextFile,
      workspaceDir: this.workspaceDir,
    })
    if ('result' in outcome) this.client.respond(id, outcome.result)
    else this.client.respondError(id, outcome.error)
  }

  stop(): void {
    this.client.stop()
    this.threads.clear()
    this.initialized = false
  }

  private detachStartGuards(
    onError: (err: Error) => void,
    onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.client.removeListener('error', onError)
    this.client.removeListener('exit', onExit)
  }

  /** Spawn-time failures (ENOENT, etc.). */
  private mapSpawnError(err: unknown): WorkspaceAgentError {
    const code = (err as { code?: string })?.code
    const message = err instanceof Error ? err.message : String(err)
    if (code === 'ENOENT') {
      return new WorkspaceAgentError('`vibe-acp` was not found on your PATH.', SPAWN_HINT)
    }
    return new WorkspaceAgentError(`Failed to launch vibe-acp: ${message}`, SPAWN_HINT)
  }

  /** Map a request rejection (JSON-RPC error, early failure) to a clear error. */
  private toAgentError(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err

    const rpc = err as { code?: number; message?: string; data?: unknown }
    const message = rpc?.message ?? (err instanceof Error ? err.message : String(err))

    // Classify by JSON-RPC code: Vibe reserves -32000 exclusively for
    // UnauthenticatedError (docs/acp-capture.md §8). This replaces the earlier
    // message-regex heuristic, which missed the real "Missing API key" wording.
    if (classifyAuthError(rpc) === 'not-signed-in') {
      return new WorkspaceAgentError(`Not signed in to Mistral Vibe: ${message}`, AUTH_HINT)
    }
    return new WorkspaceAgentError(message)
  }
}
