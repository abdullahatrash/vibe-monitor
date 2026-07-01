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
  /**
   * Interrupt a Thread's active turn (#103, ADR-0009) — fire the `session/cancel`
   * NOTIFICATION (acp-capture §12). The in-flight `session/prompt` then RESOLVES
   * with `stopReason:"cancelled"`, so the existing turn-complete path flips
   * `isProcessing` off; cancel is a thin outbound control, NOT a new event/output.
   */
  cancelTurn: 'thread:cancel',
  /** Drive Vibe's browser sign-in on a not-signed-in agent (`authenticate`). */
  signIn: 'auth:sign-in',
  /** Sign out the agent's session (`_auth/signOut`). */
  signOut: 'auth:sign-out',
  /** Re-query an agent's `_auth/status` without re-running sign-in (#79). */
  checkAuthStatus: 'auth:check-status',
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
  /**
   * Main -> renderer: a Thread's TITLE changed. vibe-acp auto-titles a session from
   * its first prompt and pushes it lazily via `session_info_update` (never in
   * `session/new`), so main persists it and pings here for the cold list to re-pull.
   * The ACTIVE Thread's header already updates live via the renderer reducer.
   */
  threadTitle: 'thread:title',
  /** List persisted Workspaces + their Threads for the cold launch list (ADR-0005). */
  listMetadata: 'metadata:list',
  /** Read a Thread's persisted JSONL transcript for a process-free reopen (TB3). */
  readTranscript: 'transcript:read',
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
  /**
   * Renderer -> main: change one of a Thread's agent controls (#66) — Mode, Model,
   * or Reasoning effort — on its bound ACP session. Main maps the axis to the
   * verified setter (`session/set_mode` / `session/set_model` /
   * `session/set_config_option`, acp-capture §10) and returns ok/err. A change emits
   * NO notification (the `{}` result is the only signal), so the renderer updates the
   * displayed value OPTIMISTICALLY and reverts on an `{ok:false}` (ADR-0007).
   */
  setThreadConfig: 'thread:set-config',
  /**
   * Renderer -> main: toggle a Thread's persisted per-Thread FLAGS (#132 pin, #133
   * archive) on its metadata record. ONE channel drives both flags — pin sends
   * `{threadId, pinned}`, archive sends `{threadId, archived}`; only the passed
   * field(s) change. These are SAFE metadata ops (no session teardown), so they're
   * available on every row. Best-effort per ADR-0005: a store failure returns
   * `{ok:false}` and never breaks the live flow. Flags survive reopen/eviction (they
   * live in the MetadataStore), so a pinned/archived Thread stays so across launches.
   */
  setThreadFlags: 'thread:set-flags',
  /**
   * Rename a Thread. Sets the title on OUR metadata record (the source of truth) and,
   * when the Thread has a live session, also syncs the vibe-acp side (`_session/set_title`).
   */
  setThreadTitle: 'thread:set-title',
  /**
   * Renderer -> main: subscribe to the active Workspace's STREAMED git status
   * (#84, ADR-0008). Ref-counted per `workspaceDir` in main — the first subscribe
   * starts one fs watcher + one background fetch and emits a `snapshot`; later
   * subscribes only bump the count (and re-emit the current snapshot). Returns void;
   * status arrives on the `gitStatus` push channel. Active-Workspace-only by
   * construction: only the mounted Changes panel subscribes (ADR-0008).
   */
  gitSubscribeStatus: 'git:subscribe-status',
  /**
   * Renderer -> main: drop one subscriber's hold on a Workspace's status stream
   * (#84). The last unsubscribe tears down the watcher + fetch timer; an over-count
   * unsubscribe is a no-op. Paired with `gitSubscribeStatus` on panel mount/unmount.
   */
  gitUnsubscribeStatus: 'git:unsubscribe-status',
  /**
   * Main -> renderer: a streamed git-status update for a subscribed Workspace (#84).
   * `kind` distinguishes the trigger — `snapshot` (on subscribe), `localUpdated` (fs
   * watcher / turn-end / manual refresh), `remoteUpdated` (background fetch refreshed
   * ahead/behind). The renderer filters by `workspaceDir` and holds the latest status.
   */
  gitStatus: 'git:status',
  /**
   * Renderer -> main: read ONE changed path's working-tree unified diff (#85,
   * ADR-0008). Invoke, `{ workspaceDir, path, untracked, ignoreWhitespace? }` ->
   * `GitDiffResult` (raw patch text + a content `diffHash` + a `truncated` flag). The
   * renderer parses + renders the patch with `@pierre/diffs`; main only shells `git
   * diff`. Working-tree source only, read-only. Not agent activity, so it does NOT
   * touch the warm-agent pool. A git failure (or no diff) returns the empty result.
   */
  gitDiff: 'git:diff',
  /**
   * Renderer -> main: COMMIT working-tree changes from the Changes panel (#86,
   * ADR-0008) — the first git WRITE. Invoke, `{ workspaceDir, message, paths }` ->
   * `GitCommitResult`. `paths` is the commit-time file selection (empty = commit all);
   * main stages exactly that selection then commits (no stage/unstage UI). On success
   * main re-reads status (`gitStatus.refresh`) so the committed files drop off the
   * panel — a `.git`-only change the fs watcher won't see, like #84's turn-end refresh.
   * NOT agent activity, so it does NOT touch the warm-agent pool (like `git:diff`).
   */
  gitCommit: 'git:commit',
  /**
   * Renderer -> main: list the active Workspace's branches (#87, ADR-0008). Invoke,
   * `{ workspaceDir }` -> `GitBranchesResult` (local + remote-only branches, deduped).
   * Read-only, so — like `git:diff` — it does NOT touch the warm-agent pool. A git
   * failure returns `{ok:false, error}` (never throws). The dropdown fetches on open.
   */
  gitBranches: 'git:branches',
  /**
   * Renderer -> main: CHECK OUT a branch on the active Workspace (#87). Invoke,
   * `{ workspaceDir, name }` -> `GitOpResult`. `name` is the SWITCH TARGET — a local
   * branch name, or the bare trailing name for a remote-only branch (the renderer
   * strips the remote prefix so git's DWIM creates a tracking local). On success main
   * re-reads status (`gitStatus.refresh`) so the panel header shows the new branch. A
   * dirty-tree refusal returns `{ok:false, error}` (NO data loss — git protects).
   */
  gitCheckout: 'git:checkout',
  /**
   * Renderer -> main: CREATE + switch to a new branch on the active Workspace (#87).
   * Invoke, `{ workspaceDir, name }` -> `GitOpResult` (`git switch -c <name>` from the
   * current HEAD; no base ref in v1). On success main re-reads status so the header
   * shows the new branch. A name collision returns `{ok:false, error}` (never throws).
   */
  gitCreateBranch: 'git:create-branch',
  /**
   * Renderer -> main: read the CURRENT branch's GitHub PR via the `gh` CLI (#88, slice 4,
   * ADR-0008). Invoke, `{ workspaceDir }` -> `GhPrResult` — `{ok:true, pr}` (the PR or
   * null when the branch has none / the repo isn't on GitHub), or `{ok:false, error}` for
   * gh-missing / not-authed / an unexpected gh failure. A NETWORK call (gh hits the GitHub
   * API), so the renderer fetches on branch-change + manual refresh, NOT on every status
   * tick. Read-only, so — like the other git ops — it does NOT touch the warm-agent pool.
   */
  ghCurrentPr: 'gh:current-pr',
  /**
   * Renderer -> main: CREATE a PR for the current branch via `gh pr create` (#88). Invoke,
   * `{ workspaceDir, title, body }` -> `GhCreateResult` (`{ok:true, url}` — the new PR's
   * URL — or `{ok:false, error}`). gh inherits the user's `gh auth`; we pass no `--base`
   * (gh defaults to the repo's default branch) and do NOT push (the renderer gates the
   * affordance on the branch having an upstream). NOT agent activity, so no `pool.touch`.
   */
  ghCreatePr: 'gh:create-pr',
  /**
   * Renderer -> main: REVEAL a file referenced by a clickable file-path chip (#116) in
   * the OS file manager. Fire-and-forget (invoke → `Promise<void>`, like `respondPermission`).
   * The chip text is AGENT-AUTHORED (untrusted), so main never OPENS/executes the target —
   * it resolves the (possibly relative) path against the hosting agent's Workspace cwd,
   * CONFINES it to the Workspace (symlink-resolved), and calls `shell.showItemInFolder`
   * (highlight only, no Launch Services / code execution). Best-effort — an out-of-Workspace
   * or bad path is a logged no-op, never thrown. Reveal can't deep-link a line, so the
   * chip's `Lx:Cy` ref stays display-only. (Do NOT switch this to `shell.openPath` — that
   * would execute `.app`/`.command`/installers from untrusted markdown on one click.)
   */
  revealPath: 'shell:reveal-path',
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
 * the indicators for ALL live Threads, active or not. The renderer folds it into
 * its status registry; a terminal transition (turn end, answer, evict) pushes the
 * flag back to false, so nothing lingers stale.
 */
export interface ThreadStatusEvent {
  threadId: string
  streaming: boolean
  needsAttention: boolean
}

/**
 * Main -> renderer: a Thread's persisted title changed — vibe-acp's auto-title on the
 * first prompt (or a later rename). Carries the new title; the renderer re-pulls the
 * cold list so the sidebar re-renders (the active Thread's header updates via the reducer).
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
 * The `deleteThread` reply (#53). `ok` when the records came down (or there was
 * nothing to delete). `{ok:false, reason:'streaming'}` when main's authoritative
 * per-Thread status shows a turn in flight — a defense-in-depth refusal against the
 * click-race where the renderer's (async, possibly-stale) delete gate let a delete
 * through just as a turn began; the renderer leaves the row in place.
 */
export type DeleteThreadResult = { ok: true } | { ok: false; reason: 'streaming' }

/**
 * Interrupt a Thread's active turn (#103, ADR-0009). Fired by the Stop button,
 * routed to `WorkspaceAgent.cancel` -> `session/cancel` notification. A no-op when
 * `sessionId` is null (an unbound draft has no active turn to cancel).
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
 * Re-query an agent's current `_auth/status` without re-running sign-in (#79).
 * Lets the panel OBSERVE auth state — picking up an out-of-band `vibe` CLI
 * sign-in, the blocking fallback, or a delegated `complete` whose result we lost.
 */
export interface CheckAuthStatusArgs {
  /** Id of the Workspace agent to re-query. */
  agentId: string
}

/**
 * Result of a re-check. `signOutAvailable` seeds the signed-in indicator when the
 * check lands signed-in (mirrors `SignOutResult`'s gate). Failures are recoverable.
 */
export type CheckAuthStatusResult =
  | { ok: true; authState: AuthState; signOutAvailable: boolean }
  | { ok: false; error: string }

/** Which agent control a `setThreadConfig` change targets (#66). */
export type ThreadConfigAxis = 'mode' | 'model' | 'reasoningEffort'

/**
 * Change one agent control on a Thread's bound ACP session (#66). `value` is the
 * new id for the axis — a `modeId` from `availableModes`, a `modelId` from
 * `availableModels` (NEVER an arbitrary string: `session/set_model` false-accepts
 * any string, acp-capture §10), or a reasoning-effort `value` from the `thinking`
 * options.
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
 * Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive). ONE
 * payload drives either flag: a pin toggle sends `{threadId, pinned}`, an archive
 * toggle sends `{threadId, archived}`; each is optional so only the passed field(s)
 * change on the metadata record (`setThreadFlags` patches, never clears the other).
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

/**
 * One changed path in a Workspace's working tree (#84, ADR-0008). `status` is the
 * raw `git status --porcelain=2` XY code (e.g. `.M`, `A.`, `RM`, `MM`) or `?` for an
 * untracked path — the renderer maps it to a display glyph. `insertions`/`deletions`
 * are the merged `git diff` + `git diff --cached` numstat for the path (0 for a
 * binary `-`/`-` entry). `staged` is true when the index half (X) is non-clean; a
 * path can be both staged and worktree-dirty (e.g. `MM`) — `staged` then still true.
 */
export interface GitFile {
  path: string
  status: string
  insertions: number
  deletions: number
  staged: boolean
  untracked: boolean
}

/**
 * A Workspace working tree's git status (#84, ADR-0008) — the observational v1
 * payload. `isRepo:false` (with the empty defaults) covers a non-repo Workspace OR
 * any git failure swallowed into the stream (never a throw): the renderer then shows
 * no Changes panel ("a Workspace need not be a git repo", CONTEXT.md). `ahead`/
 * `behind` are 0 with no upstream; `branch`/`upstream` are null when detached / unset.
 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

/** Which trigger produced a `gitStatus` push (#84). */
export type GitStatusKind = 'snapshot' | 'localUpdated' | 'remoteUpdated'

/**
 * Main -> renderer streamed git-status update (#84). Tagged by `workspaceDir` so a
 * renderer with one mounted Changes panel ignores events for other Workspaces (the
 * push fans out to every window, like `thread:status`).
 */
export interface GitStatusEvent {
  workspaceDir: string
  kind: GitStatusKind
  status: GitStatus
}

/** Args for `gitSubscribeStatus` / `gitUnsubscribeStatus` (#84). */
export interface GitStatusSubscriptionArgs {
  workspaceDir: string
}

/**
 * Args for `gitDiff` (#85): read one changed path's working-tree diff. `path` is the
 * `GitFile.path` (relative to the Workspace root, as `git status` reported it).
 * `untracked` routes to the `git diff --no-index -- /dev/null <path>` form (a new file
 * has no index entry to diff against). `ignoreWhitespace` re-reads the diff with `-w`
 * for the panel's whitespace toggle — @pierre can't ignore whitespace on a pre-parsed
 * patch, so the toggle drives a fresh read (a new `diffHash`) here.
 */
export interface GitDiffArgs {
  workspaceDir: string
  path: string
  untracked: boolean
  ignoreWhitespace?: boolean
}

/**
 * The `gitDiff` reply (#85): a changed path's RAW working-tree unified diff plus a
 * content `diffHash` (sha256 of `patch`) the renderer memoizes on, so an unchanged
 * file skips a re-parse / re-render. `truncated` is true when the patch was capped
 * (~120 KB) — the viewer flags it. The empty result (`patch:''`, `diffHash:''`,
 * `truncated:false`) covers BOTH a clean path (no diff) and a swallowed git failure;
 * the renderer renders nothing for it (degrade quietly, like #84's non-repo panel).
 */
export interface GitDiffResult {
  patch: string
  diffHash: string
  truncated: boolean
}

/**
 * Args for `gitCommit` (#86): commit working-tree changes. `message` is the commit
 * message (the panel disables Commit on an empty/whitespace one). `paths` is the
 * commit-time selection of `GitFile.path`s — a NON-empty subset stages exactly those
 * (a mixed `reset` + `add -- <paths>`), an EMPTY array commits ALL changes (`add -A`).
 */
export interface GitCommitArgs {
  workspaceDir: string
  message: string
  paths: string[]
}

/**
 * The `gitCommit` reply (#86). `{ok:true}` on a clean commit (main then refreshes the
 * Changes panel so the committed files drop off). `{ok:false, error}` carries git's
 * ACTUAL reason — "nothing to commit", a failed pre-commit hook, an index lock — not a
 * collapsed "commit failed" (#78 style). The renderer shows `error` inline + recoverable.
 */
export type GitCommitResult = { ok: true } | { ok: false; error: string }

/**
 * One branch in a Workspace's repo (#87). `name` is the local branch name (e.g. `main`,
 * `feat/x`) or, for a remote-only branch, the `<remote>/<branch>` name (e.g.
 * `origin/feature`). `isRemote` distinguishes the two; `current` marks the checked-out
 * branch; `isDefault` marks the repo's default branch (best-effort from origin/HEAD,
 * false everywhere when unresolved). The list shows local branches + only the remotes
 * with NO matching local (deduped), so a tracked branch appears once.
 */
export interface GitBranch {
  name: string
  isRemote: boolean
  current: boolean
  isDefault: boolean
}

/**
 * The `gitBranches` reply (#87). `{ok:true, branches}` on a successful list (local +
 * remote-only, deduped). `{ok:false, error}` carries git's actual reason (e.g. not a
 * git repository) — never a collapsed message. The dropdown surfaces the error inline.
 */
export type GitBranchesResult = { ok: true; branches: GitBranch[] } | { ok: false; error: string }

/**
 * The reply shape for a branch WRITE — `gitCheckout` / `gitCreateBranch` (#87).
 * `{ok:true}` on a clean switch/create (main then refreshes status so the panel header
 * shows the new branch). `{ok:false, error}` carries git's ACTUAL reason — a dirty-tree
 * checkout refusal (NO data loss; git protects), a name collision — surfaced inline +
 * recoverable.
 */
export type GitOpResult = { ok: true } | { ok: false; error: string }

/** Args for `gitBranches` (#87): list one Workspace's branches. */
export interface GitBranchesArgs {
  workspaceDir: string
}

/**
 * Args for `gitCheckout` / `gitCreateBranch` (#87). For a checkout `name` is the branch's
 * full name and `track` says whether it's a remote-only branch: `track:true` →
 * `git switch --track <remote>/<branch>` (an unambiguous tracking-local create), else
 * `git switch <name>`. For a create, `name` is the NEW branch name (`track` unused).
 */
export interface GitBranchOpArgs {
  workspaceDir: string
  name: string
  track?: boolean
}

/**
 * A GitHub pull request, as `gh pr view --json number,title,url,state` reports it (#88).
 * `state` is gh's uppercase status — `OPEN` / `CLOSED` / `MERGED` (kept verbatim; the
 * renderer tints the chip on it). `url` is the PR's web URL (opened externally via the
 * renderer's `target="_blank"` anchor -> main's `setWindowOpenHandler` -> `shell.openExternal`).
 */
export interface GhPr {
  number: number
  title: string
  url: string
  state: string
}

/**
 * The `ghCurrentPr` reply (#88). `{ok:true, pr}` where `pr` is the current branch's PR or
 * `null` (no PR for the branch, or the repo isn't on GitHub — both a normal "no PR
 * surface", NOT an error). `{ok:false, error}` is reserved for gh-missing / not-authed /
 * an unexpected gh failure — surfaced as a subtle hint in the panel, never a crash.
 */
export type GhPrResult = { ok: true; pr: GhPr | null } | { ok: false; error: string }

/**
 * The `ghCreatePr` reply (#88). `{ok:true, url}` carries the new PR's URL (gh prints it on
 * success — the renderer shows the chip + opens it externally). `{ok:false, error}` carries
 * a friendly reason: gh-missing, the `gh auth login` hint, "push your branch first", or
 * gh's verbatim stderr — surfaced inline + recoverable.
 */
export type GhCreateResult = { ok: true; url: string } | { ok: false; error: string }

/** Args for `ghCurrentPr` (#88): read one Workspace's current-branch PR. */
export interface GhCurrentPrArgs {
  workspaceDir: string
}

/** Args for `ghCreatePr` (#88): create a PR for one Workspace's current branch. */
export interface GhCreatePrArgs {
  workspaceDir: string
  title: string
  body: string
}

/**
 * Args for `revealPath` (#116): reveal a file referenced by a clickable file-path chip.
 * `agentId` identifies the hosting Workspace agent so main can resolve `path`'s
 * Workspace cwd (the renderer has no fs, so relative→absolute resolution is main's
 * job) and confine it. `path` is the `FileLink.path` from the chip — already stripped
 * of any `:line:col` position.
 */
export interface RevealPathArgs {
  agentId: string
  path: string
}
