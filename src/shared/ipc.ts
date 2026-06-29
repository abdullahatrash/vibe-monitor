/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Keep this file free of Node/DOM imports so both sides can consume it.
 */

export const IPC = {
  /** Detect whether `vibe` / `vibe-acp` are installed and reachable. */
  detectVibe: 'vibe:detect',
  /** Open a native directory picker to choose a Workspace. */
  openWorkspaceDialog: 'workspace:open-dialog',
  /** Start a Workspace agent, run the ACP handshake, and open a Thread. */
  startThread: 'thread:start',
  /** Open a Thread on an already-started agent (after sign-in / re-auth). */
  openThread: 'thread:open',
  /** Stop / dispose a Workspace agent (and its Threads). */
  stopAgent: 'agent:stop',
  /** Send a prompt to a Thread (`session/prompt`); resolves on turn completion. */
  sendPrompt: 'thread:prompt',
  /** Answer a `session/request_permission` by its JSON-RPC request id. */
  respondPermission: 'permission:respond',
  /** Drive Vibe's browser sign-in on a not-signed-in agent (`authenticate`). */
  signIn: 'auth:sign-in',
  /** Sign out the agent's session (`_auth/signOut`). */
  signOut: 'auth:sign-out',
  /** Main -> renderer: streamed ACP event tagged by the owning agent. */
  acpEvent: 'acp:event',
  /**
   * Main -> renderer: a draft's session was just minted (`session/new`) and bound
   * to its Thread (TB5). Emitted BEFORE that session streams any event, so a draft
   * is bound before its own events arrive — it never infers its session from one.
   */
  threadBound: 'thread:bound',
  /** List persisted Workspaces + their Threads for the cold launch list (ADR-0005). */
  listMetadata: 'metadata:list',
  /** Read a Thread's persisted JSONL transcript for a process-free reopen (TB3). */
  readTranscript: 'transcript:read',
  /** Mint a NEW-Thread draft (durable id, no ACP session) under a Workspace (TB5). */
  createDraft: 'thread:create-draft',
  /**
   * Delete a Thread (TB6): remove its metadata record + JSONL transcript, and
   * best-effort close its live ACP session if one is bound. It vanishes from the
   * next `listMetadata`. Best-effort — Vibe-side cleanup never blocks ours (ADR-0005).
   */
  deleteThread: 'thread:delete',
} as const

/**
 * The `authMethods` id for Vibe's client-driven (delegated) browser sign-in
 * (acp-capture §8) — the ADR-0003 primary path. The only method `signIn` drives.
 */
export const DELEGATED_AUTH_METHOD_ID = 'browser-auth-delegated'

/**
 * The `authMethods` id for Vibe's agent-driven (blocking) browser sign-in
 * (acp-capture §8) — the ADR-0003 fallback used when the delegated method is
 * not advertised. A single `authenticate({methodId})` call; the agent opens the
 * browser and blocks until the user finishes.
 */
export const BLOCKING_AUTH_METHOD_ID = 'browser-auth'

export interface VibeDetectResult {
  vibeFound: boolean
  vibeAcpFound: boolean
  vibeVersion: string | null
  /** Resolved absolute path to the vibe-acp binary, when found. */
  vibeAcpPath: string | null
  error: string | null
}

/**
 * Whether the user is signed in to Mistral Vibe. `unknown` covers states we
 * can't conclude from the available signal (e.g. a non-auth error). Main
 * classifies; the renderer renders (ADR-0001, ADR-0003).
 */
export type AuthState = 'signed-in' | 'not-signed-in' | 'unknown'

/** An advertised sign-in method from the `initialize` response (`authMethods`). */
export interface AuthMethod {
  id: string
  name: string
  description?: string
}

/** A selectable agent mode from `session/new` (e.g. `default`, `plan`). */
export interface AcpMode {
  id: string
  name: string
  description?: string
}

/** A selectable model from `session/new`. */
export interface AcpModel {
  modelId: string
  name: string
}

export interface ThreadModes {
  currentModeId: string
  availableModes: AcpMode[]
}

export interface ThreadModels {
  currentModelId: string
  availableModels: AcpModel[]
}

/** A connected Thread, mapped onto the ACP `sessionId` from `session/new`. */
export interface ThreadInfo {
  /** The ACP session id this Thread is bound to (debug-visible only). */
  sessionId: string
  /** Title placeholder, when the agent provides one. */
  title: string | null
  modes: ThreadModes | null
  models: ThreadModels | null
}

export interface StartThreadArgs {
  /** Absolute path to the Workspace the agent should operate in. */
  workspaceDir: string
}

/** Open a Thread on an agent already started + signed in (after sign-in / re-auth). */
export interface OpenThreadArgs {
  /** Id of the started Workspace agent to open a Thread on. */
  agentId: string
}

/** A Thread plus the Workspace agent that hosts it. */
export interface ThreadConnection extends ThreadInfo {
  /** Id of the Workspace agent (one `vibe-acp` process) in main. */
  agentId: string
  workspaceDir: string
  /** Our durable, minted Thread id (TB5) — distinct from the ACP `sessionId`. */
  threadId: string
  /** Our minted Workspace id (TB5) — the key drafts/binds are recorded under. */
  workspaceId: string
  /** Whether sign-out is available — drives the connected signed-in indicator. */
  signOutAvailable: boolean
  /** Advertised sign-in methods, kept so sign-out can route back to the panel. */
  authMethods: AuthMethod[]
}

export type StartThreadResult =
  | { ok: true; thread: ThreadConnection }
  // Detected (via `_auth/status`) that the user is not signed in: the agent is
  // up and registered under `agentId` so the sign-in flow (#12) can drive it,
  // but no Thread was opened. `authMethods` feeds the sign-in panel's label.
  | { ok: false; kind: 'not-signed-in'; agentId: string; workspaceDir: string; authMethods: AuthMethod[] }
  | { ok: false; kind: 'error'; error: string; hint: string | null }

export interface AcpEvent {
  /** Id of the Workspace agent the payload came from. */
  agentId: string
  /** Raw ACP / JSON-RPC payload (or a serialized child lifecycle event). */
  payload: unknown
}

/**
 * Main -> renderer signal that a draft's `session/new` returned and its session
 * is bound to `threadId` (TB5). Sent the instant binding completes and BEFORE the
 * session streams any event, so the draft's live view adopts its OWN session up
 * front instead of inferring one from an arbitrary (possibly sibling) event.
 */
export interface ThreadBoundEvent {
  threadId: string
  sessionId: string
}

/** Token usage for a completed turn (`session/prompt` response). */
export interface PromptUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/** The `session/prompt` response — arrives when the turn ends. */
export interface PromptResult {
  stopReason: string
  usage?: PromptUsage
  userMessageId?: string
}

export interface SendPromptArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) hosting the Thread. */
  agentId: string
  /** Our durable Thread id — bound to its ACP session on the first prompt (TB5). */
  threadId: string
  /** Our minted Workspace id — the key the binding is recorded under (TB5). */
  workspaceId: string
  /**
   * The Thread's bound ACP session, or `null` for a draft's FIRST prompt — which
   * triggers `session/new` in main (ADR-0005). The caller reuses the `sessionId`
   * returned in the result on subsequent prompts so the session is not re-minted.
   */
  sessionId: string | null
  /** The user's prompt text. */
  text: string
}

export type SendPromptResult =
  // `sessionId` is the Thread's now-bound session (minted on a draft's first
  // prompt, else the one passed in) — the renderer reuses it on the next prompt.
  | { ok: true; result: PromptResult; sessionId: string }
  // Mid-session expiry (-32000): the agent stays alive so the renderer can route
  // to the sign-in panel in place and re-auth on the same agent (no restart).
  | { ok: false; kind: 'not-signed-in'; agentId: string; authMethods: AuthMethod[] }
  | { ok: false; kind: 'error'; error: string }

/** Mint a NEW-Thread draft under a Workspace (TB5): no ACP session, no agent work. */
export interface CreateDraftArgs {
  /** Our minted Workspace id the draft is created under. */
  workspaceId: string
}

/**
 * The `createDraft` reply: the minted draft Thread (`sessionId: null`), or an
 * error if metadata isn't ready. The renderer adds it to the list and selects it;
 * `session/new` is deferred to its first prompt.
 */
export type CreateDraftResult =
  | { ok: true; thread: ThreadMeta }
  | { ok: false; error: string }

/** Reply to an agent `session/request_permission` with the user's choice. */
export interface RespondPermissionArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) hosting the Thread. */
  agentId: string
  /**
   * Our durable Thread id (TB5) — the permission response is teed to THIS Thread's
   * log directly, not via the agent's last-prompted map, so answering a Thread's
   * permission after switching+prompting a sibling can't misroute the entry.
   */
  threadId: string
  /** The JSON-RPC id of the agent's `session/request_permission` request. */
  requestId: number | string
  /** The `optionId` of the option the user selected. */
  optionId: string
}

/** Trigger browser sign-in on the not-signed-in agent retained from startThread. */
export interface SignInArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) to authenticate. */
  agentId: string
  /** The `authMethods` id to sign in with (prefer `browser-auth-delegated`). */
  methodId: string
}

/**
 * Result of a sign-in attempt. `authState` is the post-sign-in state (re-queried
 * via `_auth/status`); failures are recoverable — the renderer can retry.
 */
export type SignInResult =
  | { ok: true; authState: AuthState }
  | { ok: false; error: string }

/** Sign out the agent's session; the agent stays alive for a re-sign-in. */
export interface SignOutArgs {
  /** Id of the Workspace agent to sign out. */
  agentId: string
}

/**
 * Result of a sign-out. On success `authState` is the post-sign-out state
 * (not-signed-in) and `authMethods` lets the renderer show the sign-in panel for
 * an account switch. Failures are recoverable — the user stays signed in.
 */
export type SignOutResult =
  | { ok: true; authState: AuthState; authMethods: AuthMethod[] }
  | { ok: false; error: string }

/**
 * Persisted Workspace metadata (ADR-0005): a project dir the user has opened.
 * The renderer lists these on launch with NO agent spawned and no transcript
 * loaded — opening for content is a later slice (TB3).
 */
export interface WorkspaceMeta {
  /** Durable, minted id (stable across launches; keyed internally by `dir`). */
  id: string
  /** Absolute Workspace directory. */
  dir: string
  /** Human label for the list (defaults to the dir when none is given). */
  displayName: string
  /** Epoch-ms of the most recent open — drives most-recent-first ordering. */
  lastOpenedAt: number
}

/**
 * Persisted Thread metadata (ADR-0001 domain id). The Thread `id` is OUR durable
 * handle, distinct from the ACP `sessionId` it last bound to (`sessionId` is the
 * resume cursor for a later reopen, `null` before any session is minted).
 */
export interface ThreadMeta {
  id: string
  workspaceId: string
  sessionId: string | null
  title: string | null
  createdAt: number
  lastActiveAt: number
}

/** A Workspace with its Threads nested, both most-recent-first — the cold list. */
export interface WorkspaceThreads extends WorkspaceMeta {
  threads: ThreadMeta[]
}

/** The `listMetadata` reply: persisted Workspaces with their Threads. */
export type ListMetadataResult = WorkspaceThreads[]

/**
 * One line of a Thread's append-only JSONL transcript (ADR-0005). The main
 * process tees these conversation INPUTS as they cross the IPC chokepoints; on
 * reopen (TB3) the renderer replays them through the existing `conversationReducer`
 * to rebuild the view with NO `vibe-acp` process. The union mirrors the reducer's
 * `ConversationAction` inputs, so the replay is a near-mechanical entry -> action map.
 *
 * Declared here (not in the main-only transcript store) so BOTH the renderer
 * replay and the preload bridge can name it across the composite project boundary
 * — the renderer cannot import the main process. `transcript.ts` re-exports it.
 */
export type TranscriptEntry =
  | { t: 'user-prompt'; id: string; text: string }
  | { t: 'acp-event'; payload: unknown }
  | { t: 'turn-complete' }
  | { t: 'turn-error'; message: string }
  | { t: 'resolve-permission'; requestId: number | string; optionId: string; name: string | null }

/** The `readTranscript` reply: a Thread's transcript entries (empty when none). */
export type ReadTranscriptResult = TranscriptEntry[]
