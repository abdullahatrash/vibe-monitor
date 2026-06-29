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
  /** Stop / dispose a Workspace agent (and its Threads). */
  stopAgent: 'agent:stop',
  /** Send a prompt to a Thread (`session/prompt`); resolves on turn completion. */
  sendPrompt: 'thread:prompt',
  /** Answer a `session/request_permission` by its JSON-RPC request id. */
  respondPermission: 'permission:respond',
  /** Main -> renderer: streamed ACP event tagged by the owning agent. */
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

/** A Thread plus the Workspace agent that hosts it. */
export interface ThreadConnection extends ThreadInfo {
  /** Id of the Workspace agent (one `vibe-acp` process) in main. */
  agentId: string
  workspaceDir: string
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
  /** ACP session id of the Thread to prompt. */
  sessionId: string
  /** The user's prompt text. */
  text: string
}

export type SendPromptResult =
  | { ok: true; result: PromptResult }
  | { ok: false; error: string }

/** Reply to an agent `session/request_permission` with the user's choice. */
export interface RespondPermissionArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) hosting the Thread. */
  agentId: string
  /** The JSON-RPC id of the agent's `session/request_permission` request. */
  requestId: number | string
  /** The `optionId` of the option the user selected. */
  optionId: string
}
