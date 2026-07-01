import { EventEmitter } from 'node:events'
import { AcpClient, type SpawnFn } from './acp/client'
import { handleFsReadTextFile, type ReadTextFn } from './acp/fs-read'
import { handleFsWriteTextFile, type WriteTextFn } from './acp/fs-write'
import { classifyAuthError, classifyAuthStatus, extractSignOutAvailable } from './auth/auth-state'
import { BLOCKING_AUTH_METHOD_ID, DELEGATED_AUTH_METHOD_ID } from '../shared/ipc'
import type {
  AuthMethod,
  AuthState,
  PromptImage,
  PromptResult,
  ThreadAgentControls,
  ThreadInfo,
  ThreadModes,
  ThreadModels,
  ThreadReasoningEffort,
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

/**
 * How long connect will WAIT for the eager primary `session/new` (ADR-0012) before
 * returning without it. `AcpClient.request` has no timeout of its own, so a live-but-
 * unresponsive agent would otherwise wedge connect at "Launching…"; this caps that.
 * The session still resolves in the background and seeds later drafts + the first-
 * prompt reuse, and the #153 cache covers the picker meanwhile. The handshake replies
 * in ~1s (acp-capture), so this is generous headroom, not a normal-path wait.
 */
const PRIMARY_SESSION_OPEN_TIMEOUT_MS = 5000

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
  /**
   * The originating JSON-RPC error `code` when this wraps an ACP request failure
   * (e.g. `-32602` for a timed-out/denied/expired delegated `complete`). Preserved
   * so the specific reason reaches the renderer and the diagnostic log instead of
   * collapsing into a generic message. `null` when the failure carried no code.
   */
  readonly code: number | null
  constructor(
    message: string,
    hint: string | null = null,
    authState: AuthState | null = null,
    code: number | null = null,
  ) {
    super(message)
    this.name = 'WorkspaceAgentError'
    this.hint = hint
    this.authState = authState
    this.code = code
  }
}

/**
 * A `session/load` resume failed for a reason that should fall back to a fresh
 * re-bind (TB4 #33): the captured `-32602` "Session not found" (acp-capture §9),
 * or — fail-safe — ANY other non-auth load rejection. Distinct from a plain
 * `WorkspaceAgentError` so the binding logic can tell "resume failed, re-bind"
 * apart from "mid-session auth expiry" (which routes to sign-in instead).
 */
export class SessionLoadError extends WorkspaceAgentError {
  constructor(message: string) {
    super(message)
    this.name = 'SessionLoadError'
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
  /** The agent-control selects, including the `thinking` reasoning-effort axis (#66). */
  configOptions?: unknown
}

/** The reasoning-effort configId — the only `configOption` we surface (#66, §10). */
const REASONING_EFFORT_CONFIG_ID = 'thinking'

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
  /**
   * The Workspace's single primary ACP session (ADR-0012): one `session/new`
   * opened eagerly at connect so a Draft's picker can read real, account-accurate
   * control option lists BEFORE its first prompt — and REUSED by that first prompt
   * (no second `session/new`). In-memory only (NOT persisted — ADR-0011's residue
   * invariant holds); dropped on teardown (`stop()`), so eviction frees it and a
   * re-warm re-opens one. `primaryConsumed` gives the reuse consume-once semantics.
   */
  private primarySessionValue: ThreadInfo | null = null
  private primaryConsumed = false
  /** The single in-flight primary `session/new`, shared by concurrent openers. */
  private primaryOpening: Promise<void> | null = null
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
  /**
   * Whether `initialize` advertised `agentCapabilities.loadSession` (acp-capture
   * §1/§9) — gates the `session/load` resume path (TB4 #33). When false, callers
   * go straight to a fresh re-bind instead of sending a doomed `session/load`.
   */
  private loadSessionAvailableValue = false
  /**
   * Sessions with a `session/load` in flight (TB4 #33). While a session id is in
   * this set we DROP its `session/update` notifications instead of emitting them:
   * on resume the agent replays prior history over the wire (acp-capture §9), but
   * WE already own that history in our JSONL and rendered it on reopen — forwarding
   * the replay would DOUBLE the conversation. Cleared when the load settles.
   */
  private readonly loadingSessions = new Set<string>()
  /**
   * The in-flight `start()` handshake, memoized so concurrent callers share ONE
   * (TB2 #47): the warm pool dedups the agent OBJECT, but two `startThread`s for
   * the same Workspace before the first handshake completes would otherwise both
   * run start() — and the second would hit `AcpClient.start()`'s "already started"
   * throw, disposing the child the first is still handshaking on. Null until a
   * start begins and again once it settles; on success `initialized` makes later
   * calls no-op, on failure clearing it lets a retry re-attempt from scratch.
   */
  private startPromise: Promise<void> | null = null

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
    // EXCEPT: while a `session/load` is in flight for a session, drop its replayed
    // `session/update` notifications (TB4 #33) — see `loadingSessions`.
    this.client.on('notification', (msg: unknown) => {
      if (this.isSuppressedReplay(msg)) return
      this.emit('event', msg)
    })
    this.client.on('serverRequest', (msg: unknown) => this.onServerRequest(msg))
    this.client.on('stderr', (text: string) => this.emit('event', { type: 'stderr', text }))
    this.client.on('exit', (info: unknown) => this.emit('event', { type: 'exit', info }))
    this.client.on('error', (err: Error) => this.emit('event', { type: 'error', message: err.message }))
  }

  /**
   * Spawn vibe-acp and complete `initialize`. The `initialize` response is the
   * readiness signal; start is raced against an early process error/exit so a
   * failed spawn rejects instead of hanging.
   *
   * Concurrency-safe (TB2 #47): an already-initialized agent no-ops, and
   * overlapping callers SHARE one in-flight handshake (`startPromise`) so the
   * child is spawned exactly once — never a second `AcpClient.start()` racing the
   * first. The memo clears when the handshake settles (success keeps the agent
   * initialized; a failure lets a later call retry).
   */
  start(): Promise<void> {
    if (this.initialized) return Promise.resolve()
    if (!this.startPromise) {
      this.startPromise = this.runStart().finally(() => {
        this.startPromise = null
      })
    }
    return this.startPromise
  }

  /** The actual handshake — run at most once concurrently via `start()`'s memo. */
  private async runStart(): Promise<void> {
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
      this.loadSessionAvailableValue = extractLoadSessionCapability(init)
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

  /** Whether the agent advertised `loadSession` — gates the resume path (TB4 #33). */
  get loadSessionAvailable(): boolean {
    return this.loadSessionAvailableValue
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
   * Re-query `_auth/status` and fold it into the cached auth state + sign-out gate
   * (#79). The renderer's "Check sign-in status" affordance calls this to OBSERVE
   * auth state without re-running the sign-in flow — e.g. after an out-of-band
   * `vibe` CLI sign-in, the blocking fallback, or a delegated `complete` whose
   * result we lost. Resolves the fresh `AuthState`; rejects (no wedge — relies on
   * `AcpClient.rejectAllPending` on exit/stop) on an RPC failure or early exit.
   */
  async refreshAuthStatus(): Promise<AuthState> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    const status = await this.client.request('_auth/status')
    return this.applyAuthStatus(status)
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

  /** Map a sign-out failure to a clear message (Vibe's reason + the RPC code). */
  private toSignOutError(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err
    const { code, detail } = rpcErrorParts(err)
    return new WorkspaceAgentError(formatAuthFailure('Sign-out', detail, code), AUTH_HINT, null, code)
  }

  /**
   * Map a sign-in failure to a clear message. Preserves Vibe's specific reason
   * (e.g. "Browser sign-in timed out." / "denied" / "expired" from a delegated
   * `complete`) and the JSON-RPC `code`, so the renderer surfaces the actual cause
   * instead of a generic "Sign-in failed" — and so the main-process log records it.
   */
  private toSignInError(err: unknown): WorkspaceAgentError {
    if (err instanceof WorkspaceAgentError) return err
    const { code, detail } = rpcErrorParts(err)
    return new WorkspaceAgentError(formatAuthFailure('Sign-in', detail, code), AUTH_HINT, null, code)
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
      reasoningEffort: extractReasoningEffort(result.configOptions),
    }
    this.threads.set(thread.sessionId, thread)
    return thread
  }

  /** Whether this agent currently hosts (has opened or loaded) a given session. */
  hasSession(sessionId: string): boolean {
    return this.threads.has(sessionId)
  }

  /**
   * Open the Workspace's single primary ACP session (ADR-0012), if none is open
   * yet — one `session/new` whose reported controls seed a Draft's picker pre-prompt
   * and whose session the first prompt REUSES (via `consumePrimarySession`) instead
   * of minting a second. Idempotent: a no-op once a primary session exists, so the
   * two connect entry points (Workspace-open, post-sign-in openThread) never open two.
   * Best-effort at the caller — a failure must not break connect, so callers wrap
   * this in try/catch and fall back to a null-controls draft.
   *
   * Concurrency-safe: overlapping connects on the SAME agent share one in-flight
   * `session/new` (never mint two — ADR-0012's "exactly one"). And the wait is BOUNDED
   * by `PRIMARY_SESSION_OPEN_TIMEOUT_MS` so a slow/unresponsive agent can't wedge
   * connect; a late-resolving session is still stored in the background for later
   * drafts + the first-prompt reuse.
   */
  async openPrimarySession(): Promise<void> {
    if (this.primarySessionValue) return
    if (!this.primaryOpening) {
      this.primaryOpening = this.openThread()
        .then((info) => {
          this.primarySessionValue = info
        })
        .catch(() => {
          // Best-effort: leave the value null so a later connect retries the open.
        })
        .finally(() => {
          this.primaryOpening = null
        })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PRIMARY_SESSION_OPEN_TIMEOUT_MS)
    })
    try {
      await Promise.race([this.primaryOpening, bound])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * The primary session's agent-controls (#70), for seeding a Draft's / Continue's
   * connection picker (ADR-0012 #4) — the learned option lists for the Workspace's
   * lifetime, readable even after the session is consumed by a first prompt. Null
   * until `openPrimarySession` succeeds (and again after an eviction re-warm, until
   * it re-opens).
   */
  get primarySessionControls(): ThreadAgentControls | null {
    const s = this.primarySessionValue
    return s ? { modes: s.modes, models: s.models, reasoningEffort: s.reasoningEffort } : null
  }

  /**
   * Claim the unconsumed primary session for a Draft's FIRST prompt (ADR-0012 #2),
   * marking it consumed so a second concurrent Draft mints its own session instead.
   * Returns the primary `ThreadInfo` exactly once, then null (none open, or already
   * claimed). The session stays hosted (`hasSession` stays true), so the bound
   * Thread's later prompts reuse it via the already-hosted path — no re-mint.
   */
  consumePrimarySession(): ThreadInfo | null {
    if (!this.primarySessionValue || this.primaryConsumed) return null
    this.primaryConsumed = true
    return this.primarySessionValue
  }

  /**
   * Resume a prior Thread's ACP session via `session/load` (TB4 #33, acp-capture
   * §9). Params mirror `session/new` but carry the stored `sessionId`; the success
   * result has NO `sessionId` (the caller already knows the id it loaded), so we
   * keep the one we passed and register it so the next prompt reuses it. While the
   * load is in flight we SUPPRESS the session's replayed `session/update`
   * notifications (`loadingSessions`) — we already own that history in our JSONL,
   * so forwarding the replay would double the conversation.
   *
   * On failure, throws a `SessionLoadError` for the captured `-32602` "Session not
   * found" (and — fail-safe — any other non-auth load rejection) so the caller can
   * re-bind a fresh session; a `-32000` rejection is mapped to a not-signed-in
   * `WorkspaceAgentError` instead, routing to sign-in rather than a re-bind.
   */
  async loadThread(sessionId: string): Promise<ThreadInfo> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    this.loadingSessions.add(sessionId)
    try {
      const result = await this.client.request<SessionNewResult>('session/load', {
        sessionId,
        cwd: this.workspaceDirValue,
        mcpServers: [],
      })
      const thread: ThreadInfo = {
        // The `session/load` result omits `sessionId` (acp-capture §9) — keep ours.
        sessionId,
        title: result.title ?? null,
        modes: result.modes ?? null,
        models: result.models ?? null,
        reasoningEffort: extractReasoningEffort(result.configOptions),
      }
      this.threads.set(sessionId, thread)
      return thread
    } catch (err) {
      throw this.mapLoadError(err)
    } finally {
      // Clear the suppression gate the instant the load settles (success OR
      // failure): from here on, live streaming for this session forwards normally.
      this.loadingSessions.delete(sessionId)
    }
  }

  /**
   * Send a prompt to a Thread (`session/prompt`) and resolve when the turn
   * ends. The streamed `session/update` notifications flow out on the `event`
   * channel; per ADR-0001 the renderer reduces them — we only own the turn's
   * lifecycle here. Resolves with `{stopReason, usage, userMessageId}`.
   */
  async prompt(sessionId: string, text: string, images?: PromptImage[]): Promise<PromptResult> {
    if (!this.initialized) {
      throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    }
    if (!this.threads.has(sessionId)) {
      throw new WorkspaceAgentError(`No open Thread for sessionId ${sessionId}.`)
    }

    // Image content blocks (#100, acp-capture §11): the field is snake_case
    // `mime_type` with BARE base64 in `data` (no `data:` URI prefix). The
    // ACP-conventional camelCase `mimeType` is silently accepted but leaves the
    // model BLIND to the image, so we MUST emit `mime_type` here. Image blocks go
    // BEFORE the text block in the `prompt[]` array.
    const blocks = [
      ...(images ?? []).map((img) => ({ type: 'image', data: img.data, mime_type: img.mimeType })),
      { type: 'text', text },
    ]
    try {
      return await this.client.request<PromptResult>('session/prompt', {
        sessionId,
        prompt: blocks,
      })
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
    }
  }

  /**
   * Change a Thread's Mode (`session/set_mode`, acp-capture §10). A successful
   * change returns `{}` and emits NO notification — the caller reflects it
   * optimistically (ADR-0007). Rejects (mapped + auth-cached) on failure so the
   * IPC handler can surface the error and the renderer can revert.
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (!this.initialized) throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    try {
      await this.client.request('session/set_mode', { sessionId, modeId })
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
    }
  }

  /**
   * Change a Thread's Model (`session/set_model`, acp-capture §10). The agent
   * FALSE-ACCEPTS any string as `modelId` (returns `{}` without validating against
   * `availableModels`), so the renderer must only ever pass an id from
   * `models.availableModels` — a `{}` is not proof the value was valid.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    if (!this.initialized) throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    try {
      await this.client.request('session/set_model', { sessionId, modelId })
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
    }
  }

  /**
   * Change a Thread's reasoning effort via the GENERIC config setter
   * (`session/set_config_option`, acp-capture §10). The param key is `configId`
   * (NOT `id` — `{id, value}` returns -32602), pinned to `thinking`; `value` is one
   * of the `thinking` option values (`off`/`low`/`medium`/`high`/`max`).
   */
  async setReasoningEffort(sessionId: string, value: string): Promise<void> {
    if (!this.initialized) throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    try {
      await this.client.request('session/set_config_option', {
        sessionId,
        configId: REASONING_EFFORT_CONFIG_ID,
        value,
      })
    } catch (err) {
      throw this.mapErrorAndCacheAuth(err)
    }
  }

  /**
   * Rename a Thread's session on the vibe-acp side (`_session/set_title`, an EXT
   * method — leading `_` on the wire, like `_auth/status`). Keeps Vibe's saved-session
   * metadata (and `session/list`) in sync with a rename we already applied to OUR
   * store. vibe-acp echoes the change back as a `session_info_update`, which our tee
   * absorbs (a same-title `setThreadTitle` is a no-op). Best-effort at the caller:
   * we own the title, so a failure here never blocks the rename. Rejects (mapped +
   * auth-cached) so the handler can log it.
   */
  async setTitle(sessionId: string, title: string): Promise<void> {
    if (!this.initialized) throw new WorkspaceAgentError('Agent is not initialized; call start() first.')
    try {
      await this.client.request('_session/set_title', { sessionId, title })
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
   * Cancel the active turn on a Thread (#103, acp-capture §12). `session/cancel`
   * is a NOTIFICATION — the in-flight `session/prompt` then resolves with
   * `stopReason:"cancelled"` (handled by the normal turn-complete path). Fire-and-
   * forget: no-op if the agent isn't initialized (nothing is streaming).
   */
  cancel(sessionId: string): void {
    if (!this.initialized) return
    this.client.notify('session/cancel', { sessionId })
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
    // Drop the primary session with the process (ADR-0012 #6 / ADR-0006): an
    // idle un-prompted session dies on eviction, and a re-warm re-opens a fresh one.
    this.primarySessionValue = null
    this.primaryConsumed = false
    this.primaryOpening = null
    this.initialized = false
  }

  /**
   * Graceful teardown for eviction (TB5 #50): best-effort `session/close` EVERY
   * hosted session (where the capability is advertised — `closeSession` already
   * gates that and swallows failures), THEN terminate via `stop()`. Mirrors the
   * TB6 delete close-then-drop order. The close fan-out is wrapped so a hung/erroring
   * close can never skip the `stop()` — terminate ALWAYS runs in the `finally`, so
   * disposal never wedges and never rejects. Snapshots the session ids up front
   * because `closeSession` mutates the `threads` map as it goes.
   */
  async disposeGracefully(): Promise<void> {
    try {
      for (const sessionId of [...this.threads.keys()]) {
        await this.closeSession(sessionId)
      }
    } finally {
      this.stop()
    }
  }

  private detachStartGuards(
    onError: (err: Error) => void,
    onExit: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
  ): void {
    this.client.removeListener('error', onError)
    this.client.removeListener('exit', onExit)
  }

  /**
   * Whether a notification is a `session/update` replayed for a session whose
   * `session/load` is still in flight (TB4 #33) — if so we drop it (don't emit).
   * Only `session/update` replays are gated; any other notification flows through.
   *
   * Fail-safe: while ANY load is in flight we ALSO drop a `session/update` that
   * lacks a usable string `sessionId`. We can't attribute it to a session, and a
   * malformed replay leaking into the tee during a load window would double history;
   * dropping an unattributable update for the duration of a load is the safer call.
   */
  private isSuppressedReplay(msg: unknown): boolean {
    if (this.loadingSessions.size === 0) return false
    const m = msg as { method?: unknown; params?: { sessionId?: unknown } } | null
    if (!m || m.method !== 'session/update') return false
    const sessionId = m.params?.sessionId
    if (typeof sessionId !== 'string') return true // unattributable during a load -> drop
    return this.loadingSessions.has(sessionId)
  }

  /**
   * Map a `session/load` rejection (TB4 #33). A `-32000` is a mid-session auth
   * expiry — map (and cache) it as not-signed-in so the caller routes to sign-in.
   * Everything else (the captured `-32602` "Session not found", or any other
   * failure — fail-safe) becomes a `SessionLoadError` so the caller re-binds fresh.
   */
  private mapLoadError(err: unknown): WorkspaceAgentError {
    const mapped = this.mapErrorAndCacheAuth(err)
    if (mapped.authState === 'not-signed-in') return mapped
    return new SessionLoadError(mapped.message)
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
    // Preserve the JSON-RPC/app code (the ctor's docstring promises it) so callers
    // can special-case app errors — e.g. -31008 images-unsupported (#100), which
    // the renderer turns into a "switch to a vision model" hint.
    return new WorkspaceAgentError(message, null, null, rpcErrorParts(err).code)
  }
}

/**
 * Pull a JSON-RPC error's `{code, message}` off an ACP request rejection.
 * `AcpClient` rejects a failed request with the wire `error` object
 * (`{code, message, data}`); a process-exit/stop rejection is a plain `Error`
 * (no `code`). Falls back to a non-empty detail string so the surfaced message
 * is never blank.
 */
function rpcErrorParts(err: unknown): { code: number | null; detail: string } {
  const rawCode = (err as { code?: unknown } | null)?.code
  const code = typeof rawCode === 'number' ? rawCode : null
  const rawMessage = (err as { message?: unknown } | null)?.message
  const detail =
    (typeof rawMessage === 'string' ? rawMessage : err instanceof Error ? err.message : String(err)) ||
    'unknown error'
  return { code, detail }
}

/** Format an auth failure as the reason plus the JSON-RPC code (when present). */
function formatAuthFailure(action: string, detail: string, code: number | null): string {
  return code !== null ? `${action} failed: ${detail} (code ${code})` : `${action} failed: ${detail}`
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

/**
 * Whether `initialize` advertised `agentCapabilities.loadSession: true`
 * (acp-capture §1/§9). Defaults to false on any absent/malformed shape — so we
 * only attempt `session/load` against an agent that genuinely announces resume
 * support (TB4 #33), and fall straight to a re-bind otherwise.
 */
function extractLoadSessionCapability(init: InitializeResult): boolean {
  return (init.agentCapabilities as { loadSession?: unknown } | null)?.loadSession === true
}

/**
 * Surface the reasoning-effort axis from `session/new`/`session/load`'s
 * `configOptions` (#66, acp-capture §10): find the `thinking` select and map its
 * `currentValue` + `options[{value, name?}]` to a `ThreadReasoningEffort`. Defaults
 * to null on any absent/malformed shape (no array, no `thinking`, non-string
 * `currentValue`) — so the picker simply omits the control rather than rendering a
 * broken one. Mode/Model come back as their own dedicated fields, not here.
 */
function extractReasoningEffort(configOptions: unknown): ThreadReasoningEffort | null {
  if (!Array.isArray(configOptions)) return null
  const thinking = configOptions.find(
    (o): o is { id: string; currentValue?: unknown; options?: unknown } =>
      !!o && typeof o === 'object' && (o as { id?: unknown }).id === REASONING_EFFORT_CONFIG_ID,
  )
  if (!thinking || typeof thinking.currentValue !== 'string') return null
  const options = Array.isArray(thinking.options)
    ? thinking.options
        .filter(
          (opt): opt is { value: string; name?: unknown } =>
            !!opt && typeof opt === 'object' && typeof (opt as { value?: unknown }).value === 'string',
        )
        .map((opt) => ({ value: opt.value, name: typeof opt.name === 'string' ? opt.name : undefined }))
    : []
  return { current: thinking.currentValue, options }
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
