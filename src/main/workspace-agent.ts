import { EventEmitter } from 'node:events'
import { AcpClient, type SpawnFn } from './acp/client'
import { handleFsReadTextFile, type ReadTextFn } from './acp/fs-read'
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
}

export class WorkspaceAgent extends EventEmitter {
  private readonly client: AcpClient
  private readonly workspaceDir: string
  private readonly readTextFile?: ReadTextFn
  /** Threads hosted by this agent, keyed by their ACP `sessionId`. */
  private readonly threads = new Map<string, ThreadInfo>()
  private initialized = false

  constructor(options: WorkspaceAgentOptions) {
    super()
    this.workspaceDir = options.workspaceDir
    this.readTextFile = options.readTextFile
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
   * Forward every server-initiated request for transparency, and serve the
   * read-only `fs/read_text_file` ourselves so read prompts don't stall
   * (docs/acp-capture.md §5). Writes / `request_permission` are TB3 — they are
   * forwarded but not answered here; we just don't crash on them.
   */
  private onServerRequest(msg: unknown): void {
    this.emit('event', msg)

    const request = msg as { id?: number | string; method?: string; params?: unknown }
    if (request.method === 'fs/read_text_file' && request.id !== undefined) {
      void this.serveFsRead(request.id, request.params)
    }
  }

  private async serveFsRead(id: number | string, params: unknown): Promise<void> {
    const outcome = await handleFsReadTextFile(params, this.readTextFile)
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

    if (this.isUnauthenticated(message)) {
      return new WorkspaceAgentError(`Not signed in to Mistral Vibe: ${message}`, AUTH_HINT)
    }
    return new WorkspaceAgentError(message)
  }

  private isUnauthenticated(message: string): boolean {
    // The real UnauthenticatedError code is unconfirmed — we never captured one.
    // We deliberately do NOT key on the JSON-RPC code (`-32000` is the generic
    // server-error code, so trusting it misclassifies generic/internal errors
    // as "Not signed in"). Match on the message only. Verify the actual auth
    // error shape against the live binary and tighten this later.
    return /unauthenticated|not authenticated|authentication required|requires authentication|sign[- ]?in/i.test(
      message,
    )
  }
}
