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
   * Renderer -> main: the agentId of the currently SELECTED (on-screen) Workspace,
   * or null when none is connected/selected (TB5 #50). Main protects this agent
   * from idle/cap eviction so the Workspace the user is looking at is never
   * evicted out from under them.
   */
  setActiveAgent: 'agent:set-active',
  /**
   * Main -> renderer: agents the pool just EVICTED (TB5 #50, idle/cap policy). The
   * renderer drops their now-dead connections so the next select re-warms lazily
   * (history intact from the store, no user-visible error). By contract these are
   * never the selected/streaming Workspace, so nothing vanishes mid-use.
   */
  agentEvicted: 'agent:evicted',
  /**
   * Main -> renderer: a draft's session was just minted (`session/new`) and bound
   * to its Thread (TB5). Emitted BEFORE that session streams any event, so a draft
   * is bound before its own events arrive — it never infers its session from one.
   */
  threadBound: 'thread:bound',
  /**
   * Main -> renderer: a Thread's live status (`streaming` / `needsAttention`)
   * changed (#53). Main owns the authoritative turn + permission lifecycle, so it
   * pushes the two sidebar flags PER Thread — covering NON-active live Threads the
   * renderer doesn't mount. The single source of truth for the sidebar indicators;
   * the renderer folds these into its status registry (same-ref fold, no loop).
   */
  threadStatus: 'thread:status',
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
   * Re-validates per-Thread streaming in main first (#53), so a click-race can't
   * tear down a mid-turn session — replies `{ok:false, reason:'streaming'}` then.
   */
  deleteThread: 'thread:delete',
  /**
   * Renderer -> main: the current NON-default per-Thread statuses (#53), pulled
   * once on mount so a renderer that loads (or dev-reloads) MID-turn re-seeds its
   * status registry instead of waiting for the next flip. Main only pushes on a
   * change (`thread:status`), so without this a fresh window misses in-flight state.
   */
  getThreadStatuses: 'thread:statuses',
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
  /**
   * Continue an existing persisted Thread from the cold launch list (TB4 #33).
   * When set, `startThread` spawns + starts the agent and records the Workspace as
   * usual, but opens NO new Thread (no `session/new`, no extra record) — it seeds
   * the connection with THIS Thread's stored `sessionId` cursor instead, so the
   * first prompt drives the lazy `session/load` resume. Falls back to opening a
   * fresh Thread when the record can't be found (degraded / no store).
   */
  continueThreadId?: string
}

/** Open a Thread on an agent already started + signed in (after sign-in / re-auth). */
export interface OpenThreadArgs {
  /** Id of the started Workspace agent to open a Thread on. */
  agentId: string
}

/** A Thread plus the Workspace agent that hosts it. */
export interface ThreadConnection extends Omit<ThreadInfo, 'sessionId'> {
  /**
   * The bound ACP session, or `null` for a continued/draft Thread whose session
   * binds lazily on first prompt (TB4 #33): a continue-start seeds this from the
   * stored cursor (which may be null for a never-prompted draft).
   */
  sessionId: string | null
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
 * Main -> renderer notice that the pool evicted one or more warm agents (TB5 #50):
 * the renderer resets each agent's Workspace connection to a re-warmable state so
 * the next select lazily re-connects. Carries the agentIds (the renderer keys its
 * connections by Workspace but each connection holds its agentId) so it can drop
 * exactly the dead ones.
 */
export interface AgentEvictedEvent {
  agentIds: string[]
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
  /**
   * True when this binding RE-bound a reopened Thread to a fresh `session/new`
   * after a `session/load` resume failed (TB4 #33). The renderer renders a
   * one-time "agent context reset" notice; absent/false on a normal draft mint.
   */
  rebound?: boolean
}

/**
 * Main -> renderer per-Thread status update (#53): the `streaming` (a `sendPrompt`
 * turn in flight) and `needsAttention` (a forwarded `session/request_permission`
 * unanswered) flags for one Thread, keyed by our durable `threadId`. Main tracks
 * these authoritatively (it sees every turn-start/-end and permission-request/
 * -answer) and pushes a change whenever a flag flips — so the unified sidebar shows
 * the indicators for ALL live Threads, active or not. The renderer folds it into
 * its status registry; a terminal transition (turn end, answer, evict) pushes the
 * flag back to false, so nothing lingers stale.
 */
export interface ThreadStatusEvent {
  threadId: string
  streaming: boolean
  needsAttention: boolean
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

/**
 * The `deleteThread` reply (#53). `ok` when the records came down (or there was
 * nothing to delete). `{ok:false, reason:'streaming'}` when main's authoritative
 * per-Thread status shows a turn in flight — a defense-in-depth refusal against the
 * click-race where the renderer's (async, possibly-stale) delete gate let a delete
 * through just as a turn began; the renderer leaves the row in place.
 */
export type DeleteThreadResult = { ok: true } | { ok: false; reason: 'streaming' }

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
  // The agent's context was reset on a reopen (TB4 #33): a `session/load` resume
  // failed, so main re-bound the SAME Thread to a fresh `session/new`. Teed so the
  // "context reset" notice persists in history across a later reopen. The copy is
  // a renderer-side constant, so the entry carries no payload.
  | { t: 'agent-rebound' }

/** The `readTranscript` reply: a Thread's transcript entries (empty when none). */
export type ReadTranscriptResult = TranscriptEntry[]
