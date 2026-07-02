/**
 * Thread domain of the shared IPC contract: prompts, permission answers, turn cancel,
 * the per-Thread live-status / bound / title pushes, Workspace + Thread metadata + the
 * JSONL transcript, delete / remove-Workspace, and the agent-controls / flags / title
 * setters. Keep this file free of Node/DOM imports so both sides can consume it.
 */
import type { ThreadAgentControls } from './core'
import type { AuthMethod } from './auth'

/** The thread channel entries, merged into the single `IPC` const in `./index`. */
export const threadChannels = {
  /** Send a prompt to a Thread (`session/prompt`); resolves on turn completion. */
  sendPrompt: 'thread:prompt',
  /** Answer a `session/request_permission` by its JSON-RPC request id. */
  respondPermission: 'permission:respond',
  /** Interrupt a Thread's active turn (#103) — see {@link CancelTurnArgs}. */
  cancelTurn: 'thread:cancel',
  /** Main -> renderer: a draft's session was minted + bound (TB5) — see {@link ThreadBoundEvent}. */
  threadBound: 'thread:bound',
  /** Main -> renderer: a Thread's live status changed (#53) — see {@link ThreadStatusEvent}. */
  threadStatus: 'thread:status',
  /** Main -> renderer: a Thread's TITLE changed — see {@link ThreadTitleEvent}. */
  threadTitle: 'thread:title',
  /** List persisted Workspaces + their Threads for the cold launch list (ADR-0005). */
  listMetadata: 'metadata:list',
  /** Read a Thread's persisted JSONL transcript for a process-free reopen (TB3). */
  readTranscript: 'transcript:read',
  /**
   * Read a Thread's persisted image attachments for replay — ONE batched read per
   * reopen (file name -> data URL), called only when the transcript references
   * images, so image-less reopens cost no extra IPC.
   */
  readThreadAttachments: 'transcript:attachments',
  /** Delete a Thread (TB6) — see {@link DeleteThreadResult}. */
  deleteThread: 'thread:delete',
  /** Remove a Workspace ("Remove project") — see {@link RemoveWorkspaceResult}. */
  removeWorkspace: 'workspace:remove',
  /**
   * Renderer -> main: the current NON-default per-Thread statuses (#53), pulled
   * once on mount so a renderer that loads (or dev-reloads) MID-turn re-seeds its
   * status registry instead of waiting for the next flip. Main only pushes on a
   * change (`thread:status`), so without this a fresh window misses in-flight state.
   */
  getThreadStatuses: 'thread:statuses',
  /** Renderer -> main: change one of a Thread's agent controls (#66) — see {@link SetThreadConfigArgs}. */
  setThreadConfig: 'thread:set-config',
  /** Renderer -> main: toggle a Thread's persisted FLAGS (#132/#133) — see {@link SetThreadFlagsArgs}. */
  setThreadFlags: 'thread:set-flags',
  /**
   * Rename a Thread. Sets the title on OUR metadata record (the source of truth) and,
   * when the Thread has a live session, also syncs the vibe-acp side (`_session/set_title`).
   */
  setThreadTitle: 'thread:set-title',
} as const

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
  /**
   * The just-bound session's agent-controls (#70), so THIS Thread's picker sources
   * its OWN Mode/Model/Reasoning effort rather than inheriting the connect-time
   * Thread's. Non-null whenever the bind produced a fresh `session/new`/`session/load`
   * result (mint, re-bind, or resume); null on a plain reuse of an already-hosted
   * session (no fresh result — the renderer keeps whatever it already holds).
   */
  controls: ThreadAgentControls | null
}

/**
 * Main -> renderer per-Thread status update (#53): the `streaming` (a `sendPrompt`
 * turn in flight) and `needsAttention` (a forwarded `session/request_permission`
 * unanswered) flags for one Thread, keyed by our durable `threadId`. Main tracks
 * these authoritatively (it sees every turn-start/-end and permission-request/
 * -answer) and pushes a change whenever a flag flips — so the unified sidebar shows
 * the indicators for ALL live Threads, active or not (covering NON-active live
 * Threads the renderer doesn't mount). The renderer folds it into its status
 * registry (same-ref fold, no loop); a terminal transition (turn end, answer, evict)
 * pushes the flag back to false, so nothing lingers stale.
 */
export interface ThreadStatusEvent {
  threadId: string
  streaming: boolean
  needsAttention: boolean
}

/**
 * Main -> renderer: a Thread's persisted title changed — vibe-acp auto-titles a
 * session from its first prompt and pushes it lazily via `session_info_update` (never
 * in `session/new`), so main persists it and pings here (a later rename lands the same
 * way). Carries the new title; the renderer re-pulls the cold list so the sidebar
 * re-renders (the ACTIVE Thread's header already updates live via the reducer).
 */
export interface ThreadTitleEvent {
  threadId: string
  title: string
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

/**
 * An image attachment on a prompt (#100). Our IPC type uses camelCase `mimeType`;
 * the ACP snake_case `mime_type` conversion happens ONLY at the ACP boundary in
 * `workspace-agent.ts` (see acp-capture §11 — the model is blind to camelCase).
 */
export interface PromptImage {
  /** BARE base64 (no data: prefix). */
  data: string
  /** e.g. 'image/png'. */
  mimeType: string
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
  /** Optional image attachments (#100). */
  images?: PromptImage[]
}

export type SendPromptResult =
  // `sessionId` is the Thread's now-bound session (minted on a draft's first
  // prompt, else the one passed in) — the renderer reuses it on the next prompt.
  | { ok: true; result: PromptResult; sessionId: string }
  // Mid-session expiry (-32000): the agent stays alive so the renderer can route
  // to the sign-in panel in place and re-auth on the same agent (no restart).
  | { ok: false; kind: 'not-signed-in'; agentId: string; authMethods: AuthMethod[] }
  // `code` carries the JSON-RPC/app error code when known (#100) — e.g. -31008 —
  // so the renderer can special-case it (an image-too-large / unsupported reason).
  | { ok: false; kind: 'error'; error: string; code?: number }

/**
 * Interrupt a Thread's active turn (#103, ADR-0009) — fire the `session/cancel`
 * NOTIFICATION (acp-capture §12), routed to `WorkspaceAgent.cancel`. The in-flight
 * `session/prompt` then RESOLVES with `stopReason:"cancelled"`, so the existing
 * turn-complete path flips `isProcessing` off; cancel is a thin outbound control,
 * NOT a new event/output. A no-op when `sessionId` is null (an unbound draft has no
 * active turn to cancel).
 */
export interface CancelTurnArgs {
  /** agent hosting the Thread. */
  agentId: string
  /** the Thread's bound ACP session, or null if not yet bound. */
  sessionId: string | null
}

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

/**
 * The `deleteThread` reply (#53). `ok` when the records came down (or there was
 * nothing to delete): main removes the Thread's metadata record + JSONL transcript,
 * and best-effort closes its live ACP session if one is bound — it vanishes from the
 * next `listMetadata`. Best-effort — Vibe-side cleanup never blocks ours (ADR-0005).
 * `{ok:false, reason:'streaming'}` when main's authoritative per-Thread status shows a
 * turn in flight — a defense-in-depth refusal against the click-race where the
 * renderer's (async, possibly-stale) delete gate let a delete through just as a turn
 * began; the renderer leaves the row in place (so a click-race can't tear a mid-turn
 * session).
 */
export type DeleteThreadResult = { ok: true } | { ok: false; reason: 'streaming' }

/**
 * The `removeWorkspace` reply (Codex-style "Remove project"). Main stops/disposes the
 * Workspace's warm agent (if any), then removes OUR records — the Workspace metadata
 * entry + every Thread metadata entry under it + their JSONL transcripts. It NEVER
 * deletes files on disk (the project directory is untouched). Allowed even mid-turn —
 * the agent is stopped cleanly. Always `{ ok: true }` — the removal is fully
 * best-effort (ADR-0005): each step is guarded so nothing can reject the live flow, and
 * an unknown/already-gone Workspace is a harmless no-op. There is no failure signal for
 * the renderer to branch on; it just refreshes the list (the Workspace vanishes from
 * the next `listMetadata`).
 */
export type RemoveWorkspaceResult = { ok: true }

/** Which agent control a `setThreadConfig` change targets (#66). */
export type ThreadConfigAxis = 'mode' | 'model' | 'reasoningEffort'

/**
 * Change one agent control on a Thread's bound ACP session (#66) — Mode, Model, or
 * Reasoning effort. Main maps the axis to the verified setter (`session/set_mode` /
 * `session/set_model` / `session/set_config_option`, acp-capture §10) and returns
 * ok/err. `value` is the new id for the axis — a `modeId` from `availableModes`, a
 * `modelId` from `availableModels` (NEVER an arbitrary string: `session/set_model`
 * false-accepts any string, acp-capture §10), or a reasoning-effort `value` from the
 * `thinking` options. A change emits NO notification (the `{}` result is the only
 * signal), so the renderer updates the displayed value OPTIMISTICALLY and reverts on
 * an `{ok:false}` (ADR-0007).
 */
export interface SetThreadConfigArgs {
  /** Id of the Workspace agent (one `vibe-acp` process) hosting the Thread. */
  agentId: string
  /** The Thread's bound ACP session — the change is between-turns, so it's never null. */
  sessionId: string
  axis: ThreadConfigAxis
  value: string
}

/**
 * The `setThreadConfig` reply (#66). `ok` once the setter's `{}` result lands; on
 * `{ok:false}` the renderer reverts the optimistic display to the prior value and
 * surfaces the error (ADR-0007).
 */
export type SetThreadConfigResult = { ok: true } | { ok: false; error: string }

/**
 * Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive) on its
 * metadata record. ONE payload drives either flag: a pin toggle sends `{threadId,
 * pinned}`, an archive toggle sends `{threadId, archived}`; each is optional so only
 * the passed field(s) change (`setThreadFlags` patches, never clears the other). These
 * are SAFE metadata ops (no session teardown), so they're available on every row. Flags
 * survive reopen/eviction (they live in the MetadataStore), so a pinned/archived Thread
 * stays so across launches.
 */
export interface SetThreadFlagsArgs {
  /** OUR durable Thread id whose flags to patch. */
  threadId: string
  pinned?: boolean
  archived?: boolean
}

/**
 * The `setThreadFlags` reply. `{ok:true}` once the flag is persisted; `{ok:false}`
 * when the best-effort store write failed (ADR-0005 — the renderer keeps the list as
 * it was and the toggle is a no-op rather than throwing into the live flow).
 */
export type SetThreadFlagsResult = { ok: true } | { ok: false }

/**
 * Rename a Thread. `title` is set on OUR metadata record (the owner). `agentId` +
 * `sessionId` are supplied when the Thread is LIVE, so main can additionally sync the
 * vibe-acp side (`_session/set_title`); omit both for a cold Thread (store-only rename).
 */
export interface SetThreadTitleArgs {
  /** OUR durable Thread id to rename. */
  threadId: string
  /** The new title (trimmed + non-empty-checked in main; an empty title is rejected). */
  title: string
  /** The hosting Workspace agent, when the Thread is live — enables the ACP sync. */
  agentId?: string
  /** The Thread's bound ACP session, when live — the target of `_session/set_title`. */
  sessionId?: string | null
}

/**
 * The `setThreadTitle` reply. `{ok:true}` once the title is persisted to our store;
 * `{ok:false}` only on a store failure (or an empty title) — the ACP sync is
 * best-effort and never flips this to false. On `{ok:false}` the renderer reverts.
 */
export type SetThreadTitleResult = { ok: true } | { ok: false }

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
  /**
   * Pinned to the top of the unified list (#132). Optional/additive — `undefined`
   * reads as false, so legacy records (and every never-pinned Thread) need no
   * migration. Toggled via `setThreadFlags`; sorted by `orderByPin`.
   */
  pinned?: boolean
  /**
   * Archived — hidden from the main list into a collapsible "Archived" section
   * (#133). Optional/additive like `pinned` (`undefined` = not archived). Toggled
   * via `setThreadFlags`; split out by `partitionArchived`.
   */
  archived?: boolean
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
  | { t: 'user-prompt'; id: string; text: string; images?: TranscriptImageRef[] }
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

/**
 * A persisted image attachment referenced by a `user-prompt` transcript entry.
 * Additive/optional on the v1 entry — NO schema-version bump: `isTranscriptEntry`
 * discriminates on `t` alone, so legacy lines (no `images`) parse unchanged and
 * older readers ignore the field (same precedent as `ThreadMeta.pinned`).
 */
export interface TranscriptImageRef {
  /** File name under the Thread's attachments dir (e.g. `3f2a….png`). Never a path. */
  file: string
  /** e.g. 'image/png' — recorded for forward use; reads derive mime from the extension. */
  mimeType: string
}

/**
 * The `readThreadAttachments` reply: attachment file name -> full data URL for
 * every image persisted under the Thread. Missing dir (image-less Thread) → `{}`.
 */
export type ReadThreadAttachmentsResult = Record<string, string>
