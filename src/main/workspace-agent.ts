import { EventEmitter } from 'node:events'
import { AcpClient, type SpawnFn } from './acp/client'
import { handleFsReadTextFile, type ReadTextFn } from './acp/fs-read'
import { handleFsWriteTextFile, type WriteTextFn } from './acp/fs-write'
import { classifyAuthError, classifyAuthStatus, extractSignOutAvailable } from './auth/auth-state'
import { BLOCKING_AUTH_METHOD_ID, DELEGATED_AUTH_METHOD_ID } from '../shared/ipc'
import type {
  AuthMethod,
  AuthState,
  PromptResult,
  ThreadInfo,
  ThreadModes,
  ThreadModels,
} from '../shared/ipc'

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
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const

export const AUTH_HINT =
  'Run `vibe` to sign in, or `vibe --setup` to configure your Mistral Vibe account.'
export const SPAWN_HINT =
  'Install Mistral Vibe and ensure `vibe-acp` is on your PATH, then run `vibe` to sign in.'

/** A failure surfaced to the renderer, optionally with an actionable hint. */
export class WorkspaceAgentError extends Error {
  readonly hint: string | null
  /**
   * Auth classification of this failure, when known. `not-signed-in` marks a
   * -32000 UnauthenticatedError (mid-session expiry) so callers route to the
   * sign-in panel and keep the agent alive instead of treating it as generic.
   */
  readonly authState: AuthState | null
  constructor(message: string, hint: string | null = null, authState: AuthState | null = null) {
    super(message)
    this.name = 'WorkspaceAgentError'
    this.hint = hint
    this.authState = authState
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
  /** Open a URL in the system browser (delegated sign-in). Injected for testing. */
  openUrl?: (url: string) => void
}

export class WorkspaceAgent extends EventEmitter {
  private readonly client: AcpClient
  private readonly workspaceDirValue: string
  private readonly readTextFile?: ReadTextFn
  private readonly writeTextFile?: WriteTextFn
  private readonly openUrl?: (url: string) => void
  /** Threads hosted by this agent, keyed by their ACP `sessionId`. */
  private readonly threads = new Map<string, ThreadInfo>()
  private initialized = false
  /** Sign-in state detected via `_auth/status` during start(). */
  private authStateValue: AuthState = 'unknown'
  /** Sign-in methods advertised by `initialize` (e.g. `browser-auth`). */
  private authMethodsValue: AuthMethod[] = []
  /** Whether `_auth/status` reports sign-out is available — gates the control. */
  private signOutAvailableValue = false
  /**
   * Whether `initialize` advertised `agentCapabilities.sessionCapabilities.close`
   * (acp-capture §1) — gates the best-effort `session/close` on Thread delete
   * (TB6 #35) so we never send a doomed -32601 to an agent that can't service it.
   */
  private sessionCloseAvailableValue = false

  constructor(options: WorkspaceAgentOptions) {
    super()
    this.workspaceDirValue = options.workspaceDir
    this.readTextFile = options.readTextFile
    this.writeTextFile = options.writeTextFile
    this.openUrl = options.openUrl
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
      const init = await Promise.race([
        this.client.request<InitializeResult>('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            // Opt in to client-driven sign-in; without this `_meta` flag the
            // agent never advertises the `browser-auth-delegated` method
            // (acp-capture §8).
            _meta: { 'browser-auth-delegated': true },
          },
          clientInfo: CLIENT_INFO,
        }),
        earlyFailure,
      ])
      this.authMethodsValue = extractAuthMethods(init)
      this.sessionCloseAvailableValue = extractSessionCloseCapability(init)
      // `initialize` can't reveal auth state (its authMethods is always
      // present), so query the `_auth/status` extension method (acp-capture §8).
      await this.detectAuthState(earlyFailure)
      this.initialized = true
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
    } finally {
      this.detachStartGuards(onError, onExit)
    }
  }

  /** The sign-in state detected during start() (`unknown` until started). */
  get authState(): AuthState {
    return this.authStateValue
  }

  /** The sign-in methods advertised by the agent's `initialize` response. */
  get authMethods(): AuthMethod[] {
    return this.authMethodsValue
  }

  /** Whether sign-out is currently available (from the last `_auth/status`). */
  get signOutAvailable(): boolean {
    return this.signOutAvailableValue
  }

  /** The absolute Workspace directory this agent operates in (for dedup). */
  get workspaceDir(): string {
    return this.workspaceDirValue
  }

  /** Fold a fresh `_auth/status` result into the cached auth state + sign-out gate. */
  private applyAuthStatus(status: unknown): AuthState {
    this.authStateValue = classifyAuthStatus(status)
    this.signOutAvailableValue = extractSignOutAvailable(status)
    return this.authStateValue
  }

  /**
   * Query the `_auth/status` extension method and classify the result. Process
   * death during the call is fatal (races `earlyFailure`); a plain RPC failure
   * is not — we fall back to `unknown` and let `session/new` surface any real
   * auth gate (the -32000 UnauthenticatedError).
   */
  private async detectAuthState(earlyFailure: Promise<never>): Promise<void> {
    try {
      const status = await Promise.race([this.client.request('_auth/status'), earlyFailure])
      this.applyAuthStatus(status)
    } catch (err) {
      if (err instanceof WorkspaceAgentError) throw err
      this.authStateValue = 'unknown'
    }
  }

  /**
   * Drive Vibe's browser sign-in, dispatching on the advertised `methodId`
   * (acp-capture §8). Two captured modes (ADR-0003):
   *   - `browser-auth-delegated` (primary): the client-driven two-step
   *     `start`/`complete`, where WE open the `signInUrl` (see `signInDelegated`).
   *   - `browser-auth` (fallback): a single agent-driven blocking call, where the
   *     AGENT opens the browser (see `signInBlocking`).
   * Any other id is refused up front — we never send an unknown/delegated-shaped
   * request to a method that can't handle it. Both modes re-query `_auth/status`
   * and return the post-sign-in `AuthState` (`signed-in` on success); both reject
   * (without wedging) on failure, cancel, or early process exit. We never see or
   * store the credential.
   */
  async signIn(methodId: string): Promise<AuthState> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    try {
      if (methodId === DELEGATED_AUTH_METHOD_ID) return await this.signInDelegated(methodId)
      if (methodId === BLOCKING_AUTH_METHOD_ID) return await this.signInBlocking(methodId)
      // Neither captured method: refuse rather than send a request the agent
      // can't service (which would surface a raw -32601/-32602).
      throw new WorkspaceAgentError(`Sign-in method '${methodId}' is not supported.`, AUTH_HINT)
    } catch (err) {
      throw this.toSignInError(err)
    }
  }

  /**
   * The client-driven delegated two-step (`browser-auth-delegated`, ADR-0003
   * primary; acp-capture §8). Non-blocking `start` mints a `signInUrl` we open in
   * the system browser; the long-poll `complete` awaits the user finishing and
   * persists the key to Vibe's keyring; we then re-query `_auth/status` to
   * confirm. Rejects (recoverably) on an expired/unknown attempt (-32602).
   *
   * Unlike start(), this does NOT race `earlyFailure`; its no-wedge property
   * relies on AcpClient.rejectAllPending firing on `exit`/`stop`, which rejects
   * any in-flight authenticate/_auth/status request. Keep that on refactor.
   */
  private async signInDelegated(methodId: string): Promise<AuthState> {
    const started = await this.client.request('authenticate', { methodId, action: 'start' })
    const meta = extractDelegatedMeta(started, methodId)
    // Fail fast before opening the browser or sending a doomed `complete`
    // (which would surface a raw -32602) if `start` returned no attempt.
    if (!meta?.attemptId) {
      throw new WorkspaceAgentError('Sign-in could not start — Vibe returned no attempt.', AUTH_HINT)
    }
    if (meta.signInUrl) this.openUrl?.(meta.signInUrl)

    await this.client.request('authenticate', {
      methodId,
      action: 'complete',
      attemptId: meta.attemptId,
    })

    const status = await this.client.request('_auth/status')
    return this.applyAuthStatus(status)
  }

  /**
   * The agent-driven blocking fallback (`browser-auth`, ADR-0003 fallback;
   * acp-capture §8) — used when the delegated method is not advertised. A SINGLE
   * `authenticate({methodId})` with NO `action`/`attemptId`: the AGENT opens the
   * browser and the call BLOCKS until the user finishes, then persists the key to
   * Vibe's keyring. We open no URL (the agent does) and discard the response —
   * `persistResult` is a credential signal we never read (ADR-0003) — then
   * re-query `_auth/status` to confirm.
   *
   * Like `signInDelegated`'s `complete`, this blocking call cannot be cancelled
   * over ACP; its no-wedge property relies on AcpClient.rejectAllPending firing on
   * `exit`/`stop` (plus the renderer's attempt-generation guard + Cancel button).
   * Keep that on refactor.
   */
  private async signInBlocking(methodId: string): Promise<AuthState> {
    await this.client.request('authenticate', { methodId })
    const status = await this.client.request('_auth/status')
    return this.applyAuthStatus(status)
  }

  /**
   * Sign out via the `_auth/signOut` extension method (acp-capture §8): Vibe
   * removes the api key from its keyring (we never see it). On `{}` we re-query
   * `_auth/status` and transition `signed-in → not-signed-in`. Gated on the last
   * known `signOutAvailable` so we don't round-trip a call the agent will reject
   * (-32602). Resolves the post-sign-out `AuthState`; rejects (no wedge) on a
   * keyring failure (-32603) or early exit.
   */
  async signOut(): Promise<AuthState> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    if (!this.signOutAvailableValue) {
      throw new WorkspaceAgentError('Sign-out is not available for this session.', AUTH_HINT)
    }
    try {
      await this.client.request('_auth/signOut')
      const status = await this.client.request('_auth/status')
      return this.applyAuthStatus(status)
    } catch (err) {
      throw this.toSignOutError(err)
    }
  }

  /** Map a sign-out failure to a clear message (not a bare RPC string). */
  private toSignOutError(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err
    const detail = (err as { message?: string })?.message ?? (err instanceof Error ? err.message : String(err))
    return new WorkspaceAgentError(`Sign-out failed: ${detail}`, AUTH_HINT)
  }

  /** Map a sign-in failure to a clear message (not a bare RPC string). */
  private toSignInError(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err
    const detail = (err as { message?: string })?.message ?? (err instanceof Error ? err.message : String(err))
    return new WorkspaceAgentError(`Sign-in failed: ${detail}`, AUTH_HINT)
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
        cwd: this.workspaceDirValue,
        mcpServers: [],
      })
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
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
      throw this.mapErrorAndCacheAuth(err)
    }
  }

  /**
   * Best-effort close of a hosted Thread's ACP session on delete (TB6 #35). Drops
   * our local handle, then — only if the session is live AND the agent advertised
   * `sessionCapabilities.close` — fires `session/close` and SWALLOWS any failure:
   * Vibe-side cleanup must never block the Thread deletion or surface as an error
   * (ADR-0005). An unknown session (cold Thread / already closed) is a silent
   * no-op. Resolves once the close round-trip settles (success or error).
   *
   * Residual: the exact `session/close` param shape is the ACP-standard
   * `{sessionId}` — the capture confirms the capability is advertised but flags
   * the request shape as unverified (docs/acp-capture.md). Strictly best-effort,
   * so a wrong shape degrades to a swallowed -32602 and the records still come down.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.threads.has(sessionId)) return
    this.threads.delete(sessionId)
    if (!this.initialized || !this.sessionCloseAvailableValue) return
    try {
      await this.client.request('session/close', { sessionId })
    } catch {
      // A close failure is non-fatal — the Thread deletion proceeds regardless.
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
      workspaceDir: this.workspaceDirValue,
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

  /**
   * Map a request rejection (JSON-RPC error, early failure) to a clear error.
   * SIDE EFFECT: a -32000 UnauthenticatedError also caches the agent's auth
   * state as `not-signed-in` (mid-session expiry) — call only from a real
   * request-failure path, never to map an error read-only (e.g. for logging),
   * or you'd silently mark a live agent signed-out.
   */
  private mapErrorAndCacheAuth(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err

    const rpc = err as { code?: number; message?: string; data?: unknown }
    const message = rpc?.message ?? (err instanceof Error ? err.message : String(err))

    // Classify by JSON-RPC code: Vibe reserves -32000 exclusively for
    // UnauthenticatedError (docs/acp-capture.md §8). This replaces the earlier
    // message-regex heuristic, which missed the real "Missing API key" wording.
    if (classifyAuthError(rpc) === 'not-signed-in') {
      // Mid-session expiry: flip the cached auth state so callers keep the agent
      // alive and route to the sign-in panel, and tag the error so they can tell
      // it apart from a generic failure.
      this.authStateValue = 'not-signed-in'
      this.signOutAvailableValue = false
      return new WorkspaceAgentError(
        `Not signed in to Mistral Vibe: ${message}`,
        AUTH_HINT,
        'not-signed-in',
      )
    }
    return new WorkspaceAgentError(message)
  }
}

interface DelegatedMeta {
  attemptId?: string
  signInUrl?: string
}

/**
 * Pull the `browser-auth-delegated` payload out of an `authenticate` response.
 * The agent keys its `_meta` by the method id (acp-capture §8): both `start`
 * (`{attemptId, signInUrl, expiresAt}`) and `complete` (`{attemptId, status}`)
 * use this envelope.
 */
function extractDelegatedMeta(response: unknown, methodId: string): DelegatedMeta | null {
  const meta = (response as { _meta?: Record<string, unknown> } | null)?._meta
  const entry = meta?.[methodId]
  if (!entry || typeof entry !== 'object') return null
  return entry as DelegatedMeta
}

/**
 * Whether `initialize` advertised the session-close capability
 * (`agentCapabilities.sessionCapabilities.close`, acp-capture §1). Defaults to
 * false on any absent/malformed shape — so we only attempt `session/close`
 * against an agent that genuinely announces it (TB6 #35).
 */
function extractSessionCloseCapability(init: InitializeResult): boolean {
  const caps = (init.agentCapabilities as { sessionCapabilities?: { close?: unknown } } | null)
    ?.sessionCapabilities
  return !!caps && caps.close !== undefined
}

/** Pull the well-formed `authMethods` out of an `initialize` result. */
function extractAuthMethods(init: InitializeResult): AuthMethod[] {
  const methods = init.authMethods
  if (!Array.isArray(methods)) return []
  return methods
    .filter(
      (m): m is AuthMethod => !!m && typeof m.id === 'string' && typeof m.name === 'string',
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: typeof m.description === 'string' ? m.description : undefined,
    }))
}
