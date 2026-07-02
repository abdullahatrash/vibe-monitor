/**
 * Core domain of the shared IPC contract: Vibe detection, the Workspace directory
 * picker, and the warm-agent lifecycle (start / open / stop / active / evict) plus the
 * streamed ACP event channel — with the agent/session/connection payload shapes those
 * carry. Keep this file free of Node/DOM imports so both sides can consume it.
 */
import type { AuthMethod } from './auth'

/** The core channel entries, merged into the single `IPC` const in `./index`. */
export const coreChannels = {
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
  /**
   * Renderer -> main: the agentId of the currently SELECTED (on-screen) Workspace,
   * or null when none is connected/selected (TB5 #50). Main protects this agent
   * from idle/cap eviction so the Workspace the user is looking at is never
   * evicted out from under them.
   */
  setActiveAgent: 'agent:set-active',
  /** Main -> renderer: agents the pool just EVICTED (TB5 #50) — see {@link AgentEvictedEvent}. */
  agentEvicted: 'agent:evicted',
  /** Main -> renderer: streamed ACP event tagged by the owning agent — see {@link AcpEvent}. */
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

/**
 * The reasoning-effort axis (#66), surfaced from `session/new`'s `thinking`
 * configOption (acp-capture §10) — a select of `off`/`low`/`medium`/`high`/`max`.
 * Distinct from Mode/Model: it has no dedicated method, so a change goes through
 * the generic `session/set_config_option` with `configId: 'thinking'`. Each option
 * carries a `value`; `name` is the display label when the agent provides one.
 */
export interface ThreadReasoningEffort {
  current: string
  options: { value: string; name?: string }[]
}

/**
 * A Thread's full agent-controls bundle (#66 axes, #70 per-Thread): the current
 * values + options for Mode / Model / Reasoning effort, as a session reports them
 * from `session/new` (a fresh mint) or `session/load` (a resume). Each axis is null
 * when the agent advertises none. Carried to the renderer on `thread:bound` so EVERY
 * live Thread sources its OWN controls, keyed by its `threadId` — not the single
 * connect-time Thread's values (the #66 limitation this removes).
 */
export interface ThreadAgentControls {
  modes: ThreadModes | null
  models: ThreadModels | null
  reasoningEffort: ThreadReasoningEffort | null
}

/** A connected Thread, mapped onto the ACP `sessionId` from `session/new`. */
export interface ThreadInfo {
  /** The ACP session id this Thread is bound to (debug-visible only). */
  sessionId: string
  /** Title placeholder, when the agent provides one. */
  title: string | null
  modes: ThreadModes | null
  models: ThreadModels | null
  /** The `thinking` configOption (#66) — null when the agent advertises none. */
  reasoningEffort: ThreadReasoningEffort | null
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
 * Main -> renderer notice that the pool evicted one or more warm agents (TB5 #50,
 * idle/cap policy): the renderer resets each agent's Workspace connection to a
 * re-warmable state so the next select lazily re-connects (history intact from the
 * store, no user-visible error). By contract these are never the selected/streaming
 * Workspace, so nothing vanishes mid-use. Carries the agentIds (the renderer keys its
 * connections by Workspace but each connection holds its agentId) so it can drop
 * exactly the dead ones.
 */
export interface AgentEvictedEvent {
  agentIds: string[]
}
