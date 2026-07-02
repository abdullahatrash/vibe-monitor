import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  IPC,
  type CancelTurnArgs,
  type DeleteThreadResult,
  type GitStatusEvent,
  type ListMetadataResult,
  type OpenThreadArgs,
  type ReadTranscriptResult,
  type ReadThreadAttachmentsResult,
  type TranscriptImageRef,
  type RemoveWorkspaceResult,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type CheckAuthStatusArgs,
  type CheckAuthStatusResult,
  type SetThreadConfigArgs,
  type SetThreadConfigResult,
  type SetThreadFlagsArgs,
  type SetThreadFlagsResult,
  type SetThreadTitleArgs,
  type SetThreadTitleResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadConnection,
  type ThreadStatusEvent,
  type ThreadTitleEvent,
} from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { groupThreadsByWorkspace, MetadataStore } from './persistence/metadata-store'
import {
  acpEventEntry,
  agentReboundEntry,
  resolvePermissionEntry,
  sessionIdFromPayload,
  titleFromSessionInfoUpdate,
  TranscriptStore,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
} from './persistence/transcript'
import { TranscriptBridge } from './persistence/transcript-bridge'
import { AttachmentStore } from './persistence/attachment-store'
import { WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'
import { AgentPool } from './agent-pool'
import { AgentActivity } from './agent-activity'
import { ensureBoundSession, resolveContinueTarget } from './thread-binding'
import { deleteThread } from './persistence/delete-thread'
import { removeWorkspace } from './persistence/remove-workspace'
import { permissionRequestIdOf, ThreadStatusTracker, type ThreadStatusChange } from './thread-status'
import { gitFetch, readGitStatus } from './git/status'
import { GitStatusManager } from './git/status-stream'
import { chokidarWatchFactory, realClock } from './git/runtime'
import { registerGitIpc } from './git/register-ipc'
import { registerFilesIpc } from './files/register-ipc'
import { FilesListCache, shouldInvalidateFilesCacheOnGitStatus } from './files/cache'

// Test seam (e2e smoke): point the whole persisted profile (metadata.json +
// transcripts) at a throwaway dir so the suite launches against a KNOWN state
// (fresh first-run, or a pre-seeded fixture) without touching the real profile.
// Must run before `app.whenReady()` — `userData` is read at ready. No-op in
// normal launches (the env var is unset).
if (process.env.VIBE_MISTRO_USER_DATA) {
  app.setPath('userData', process.env.VIBE_MISTRO_USER_DATA)
}

/**
 * The warm-agent pool (ADR-0006 decision 3, TB2 #47): one `vibe-acp` agent per
 * OPEN Workspace, lazily spawned on first select and kept warm thereafter — the
 * lifecycle owner that replaces the old dispose-then-respawn `agents` map. The
 * renderer still addresses an agent by the pool-minted `agentId` handle (one
 * handle per Workspace), so `signIn`/`prompt`/etc resolve via `pool.get(agentId)`.
 */
const pool = new AgentPool({
  createAgent: (workspaceDir) =>
    new WorkspaceAgent({
      workspaceDir,
      env: getShellEnv(),
      // Delegated sign-in (#12): open the returned signInUrl in the system browser.
      openUrl: (url) => void shell.openExternal(url),
    }),
  // Graceful teardown on dispose/evict/stopAgent (TB5 #50, acceptance #3): best-
  // effort `session/close` each hosted session THEN terminate. Fire-and-forget —
  // the pool updates its maps synchronously and the child shuts down in the
  // background, so the renderer re-warms transparently without awaiting close.
  disposeAgent: (agent) => void agent.disposeGracefully(),
})

/**
 * Warm-pool bounds (ADR-0006 decision 3, TB5 #50). Defaults chosen for a desktop
 * orchestrator where a Workspace's child is cheap to re-warm (history is in our
 * store, ADR-0005) but holding many idle `vibe-acp` processes leaks memory:
 *  - `IDLE_EVICT_MS` (15 min): a Workspace untouched this long is almost certainly
 *    abandoned for now; releasing its child reclaims memory and a re-select
 *    re-warms in well under a second.
 *  - `MAX_WARM_AGENTS` (4): a generous ceiling for how many Workspaces a user
 *    actively juggles at once — past it the least-recently-used is trimmed. This
 *    also bounds the live `acp:event` listener fan-out (the #53 prerequisite).
 *  - `SWEEP_INTERVAL_MS` (1 min): coarse enough to be near-free, fine enough that
 *    eviction lands within a minute of crossing the idle line.
 * Protection (the selected, mid-turn, or mid-sign-in agent) overrides BOTH (#50).
 */
const IDLE_EVICT_MS = 15 * 60 * 1000
const MAX_WARM_AGENTS = 4
const SWEEP_INTERVAL_MS = 60 * 1000

/**
 * The eviction-protection signals (TB5 #50) — which agent is ON SCREEN, which have a
 * turn in flight, which are mid-sign-in — as one tested unit (agent-activity.ts). The
 * pool's policies consult `isAgentProtected` below; the DECISION itself is the pure
 * `isProtected` (agent-protection.ts), which the class feeds with live state.
 *
 * Single-window assumption: `setActive` tracks the one window's on-screen agent (the
 * pool itself is process-global today — see `window-all-closed`). If a multi-window
 * slice ever lands, protection must become per-window (a set/map of active agents, one
 * per window) or one window's eviction sweep could evict another window's on-screen agent.
 */
const activity = new AgentActivity()

/**
 * The eviction-protection predicate (TB5 #50) handed to the pool's pure policies:
 * NEVER evict the on-screen Workspace's agent, one mid-turn, or one mid-sign-in.
 */
const isAgentProtected = (agentId: string): boolean => activity.isProtected(agentId)

/**
 * Per-THREAD live status, the single source of truth for the sidebar's
 * `streaming` / `needsAttention` indicators (#53). Distinct from the activity
 * tracker's turn counts (which are per-AGENT, for eviction protection): this keys off
 * our durable `threadId` so a NON-active live Thread's turn or blocked permission
 * surfaces in the sidebar even though only the active Thread's `Conversation` is
 * mounted. Fed from the lifecycle signals main already sees — turn begin/end, a
 * forwarded `session/request_permission` out/answered, agent evict — and pushed to
 * the renderer (`emitThreadStatus`) on every change.
 */
const threadStatus = new ThreadStatusTracker()

/**
 * Push one or more per-Thread status changes to every renderer (#53). A null /
 * empty change (the flag didn't actually flip) is a no-op, so main never floods the
 * channel; the renderer also folds an unchanged status to the same map reference.
 */
function emitThreadStatus(changes: ThreadStatusChange | ThreadStatusChange[] | null): void {
  if (!changes) return
  const list = Array.isArray(changes) ? changes : [changes]
  if (list.length === 0) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    for (const change of list) win.webContents.send(IPC.threadStatus, change satisfies ThreadStatusEvent)
  }
}

/** Push a Thread's title change to every renderer so the cold list re-renders. */
function emitThreadTitle(event: ThreadTitleEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    win.webContents.send(IPC.threadTitle, event)
  }
}

/**
 * Per-Workspace cache of the Files Surface listing (#188, ADR-0013 decision 4). Served by
 * the `files:list` handler (files/register-ipc.ts); invalidated by the panel's Refresh (a
 * `refresh:true` invoke, which bypasses it) and — piggybacked, no new watcher — by the git
 * status-stream watcher firing (see the `emit` hook below).
 */
const filesListCache = new FilesListCache()

/**
 * The streamed git-status manager (#84, ADR-0008): per active Workspace it ref-counts
 * subscribers and runs one debounced fs watcher + one background `git fetch`,
 * emitting `snapshot`/`localUpdated`/`remoteUpdated`. Git runs in main via
 * `child_process` (ADR-0002); the manager itself is electron-free (deps injected
 * here), so its emit is wired to `webContents.send` below — mirroring
 * `emitThreadStatus`. Torn down on quit so no watcher/timer outlives the app.
 */
const gitStatus = new GitStatusManager({
  read: (workspaceDir) => readGitStatus(workspaceDir),
  fetch: (workspaceDir) => gitFetch(workspaceDir),
  watch: chokidarWatchFactory,
  clock: realClock,
  emit: (event: GitStatusEvent) => {
    // Piggyback the files cache on the git watcher (#188): a `localUpdated` push means
    // the working tree changed (fs watcher / turn-end / commit), so the cached listing
    // may be stale — drop it. `snapshot`/`remoteUpdated` don't touch local files. This is
    // the WHOLE invalidation hook — no new fs watcher (ADR-0013). The decision is the
    // pure `shouldInvalidateFilesCacheOnGitStatus`, unit-tested in cache.test.ts.
    if (shouldInvalidateFilesCacheOnGitStatus(event.kind)) filesListCache.invalidate(event.workspaceDir)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.gitStatus, event)
    }
  },
})

/** The periodic idle-evict sweep timer (cleared on quit). */
let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * The stores + transcript bridge every conversation-flow handler needs, created at
 * app-ready (they need `userData`) and injected into `registerIpc` — the DI seam
 * `docs/conventions.md` prescribes. `store` is NON-null: `MetadataStore.load()`
 * degrades to empty state internally (never a throw), so the old `| null` type and
 * its per-handler degraded forks were unreachable. `transcript` nullability IS real
 * (the dir `mkdir` can fail) — the bridge folds that into a silent-no-op tee.
 */
interface MainDeps {
  store: MetadataStore
  transcript: TranscriptStore | null
  bridge: TranscriptBridge
  /** Null when the attachments dir `mkdir` failed — image persistence no-ops (logged). */
  attachments: AttachmentStore | null
}

/**
 * Push an eviction notice to every renderer (TB5 #50) so it drops the now-dead
 * agents' Workspace connections and re-warms them lazily on next select. Also
 * clears the agents' activity + transcript-bridge entries so neither can leak
 * across evictions, and any streaming/pending status the evicted agents' Threads
 * held (#53) — a torn-down agent leaves no stale indicator behind (protection keeps
 * a busy agent from idle/cap eviction, but an explicit stop/dispose can still land).
 * A no-op when nothing was evicted.
 */
function notifyAgentsEvicted(bridge: TranscriptBridge, agentIds: string[]): void {
  if (agentIds.length === 0) return
  for (const agentId of agentIds) {
    activity.evict(agentId)
    bridge.evictAgent(agentId)
    emitThreadStatus(threadStatus.evictAgent(agentId))
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(IPC.agentEvicted, { agentIds })
  }
}

/**
 * Persist a Thread's auto-title from a `session_info_update` and push it to the
 * renderer. vibe-acp titles a session from its first prompt and emits the title
 * LAZILY (never in `session/new`), so without this every Thread stays "Untitled".
 * Resolve the Thread by the event's OWN sessionId, set the title in place via
 * `setThreadTitle` (preserves createdAt / sessionId / flags AND holds list position —
 * a title is not activity), then ping the renderer ONLY if it changed. Using the
 * non-reordering setter also makes this idempotent, so the echo of our own rename
 * (§set_title emits a `session_info_update` back) is absorbed silently. Best-effort:
 * no matching Thread or a persist failure just skips — the active Thread's header
 * still updates live via the renderer reducer regardless.
 */
async function recordThreadTitle(deps: MainDeps, sessionId: string | null, title: string): Promise<void> {
  if (!sessionId) return
  const threadId = deps.store.findThreadIdBySessionId(sessionId)
  if (!threadId) return
  try {
    if (await deps.store.setThreadTitle(threadId, title)) emitThreadTitle({ threadId, title })
  } catch {
    // a persistence failure is non-fatal — skip the push, keep the live title
  }
}

/**
 * Build a best-effort close for a Thread's LIVE ACP session on delete (TB6 #35),
 * or `undefined` when there's nothing to close. Resolves the Thread's bound
 * `sessionId` from the metadata snapshot up front (before the record is removed),
 * then closes it across the active agents — a session is hosted by exactly one
 * agent and `closeSession` no-ops on the rest. A cold Thread / unbound draft (no
 * `sessionId`) returns `undefined`, so the deletion just removes our records.
 */
function bestEffortCloseFor(deps: MainDeps, threadId: string): (() => Promise<void>) | undefined {
  const sessionId = deps.store.snapshot().threads.find((t) => t.id === threadId)?.sessionId
  if (!sessionId) return undefined
  return async () => {
    for (const agent of pool.agents()) await agent.closeSession(sessionId)
  }
}

/**
 * Build a `ThreadConnection` for the renderer — the shared tail of the draft and
 * continue flows (previously duplicated across both). Seeds the picker from the
 * Workspace's eager primary session (ADR-0012) so a fresh draft / reopened Thread
 * shows Mode/Model/effort on first paint; null-safe -> all-null when no primary
 * session opened (best-effort failure).
 */
function buildConnection(
  agentId: string,
  agent: WorkspaceAgent,
  seed: { threadId: string; workspaceId: string; sessionId: string | null; title: string | null },
): ThreadConnection {
  const controls = agent.primarySessionControls
  return {
    agentId,
    workspaceDir: agent.workspaceDir,
    sessionId: seed.sessionId,
    title: seed.title,
    modes: controls?.modes ?? null,
    models: controls?.models ?? null,
    reasoningEffort: controls?.reasoningEffort ?? null,
    threadId: seed.threadId,
    workspaceId: seed.workspaceId,
    signOutAvailable: agent.signOutAvailable,
    authMethods: agent.authMethods,
  }
}

/**
 * Build a connection for a fresh DRAFT Thread (ADR-0011): mint our durable Thread
 * id but open NO ACP session and persist NO record. The Thread stays a renderer-
 * only draft until its FIRST prompt, which drives `session/new` + the persist via
 * `ensureBoundSession`/`mintAndBind`. This is the fix for the empty-Thread bug —
 * opening a Workspace no longer records a Thread nobody prompted. `sessionId` stays
 * null — the eager primary session (if any) is a main-side detail its first prompt
 * claims. Seeds the `agentId -> threadId` transcript bridge so a session-less
 * lifecycle event tees to this Thread. `workspaceId` is the persisted Workspace id
 * (from `recordWorkspaceOpen`) so the first-prompt `upsertThread` records under the
 * real Workspace; a synthesized id is used only when the open's persist failed (the
 * draft never persists then anyway).
 */
function draftConnection(
  deps: MainDeps,
  agentId: string,
  agent: WorkspaceAgent,
  workspaceId: string | null,
): ThreadConnection {
  const threadId = randomUUID()
  deps.bridge.bind(agentId, threadId)
  return buildConnection(agentId, agent, {
    threadId,
    workspaceId: workspaceId ?? randomUUID(),
    sessionId: null,
    title: null,
  })
}

/**
 * Build a connection that CONTINUES an existing persisted Thread (TB4 #33) WITHOUT
 * opening a new one: look its record up in the metadata store and seed the
 * connection with its ids + stored `sessionId` cursor (the lazy `session/load`
 * resume happens on first prompt). Also seeds the transcript bridge so a
 * session-less lifecycle event tees to this Thread. Returns `null` when there's no
 * matching record, so the caller falls back to opening a fresh draft.
 */
function continueConnection(
  deps: MainDeps,
  agentId: string,
  agent: WorkspaceAgent,
  threadId: string,
): ThreadConnection | null {
  const target = resolveContinueTarget(deps.store, threadId)
  if (!target) return null
  deps.bridge.bind(agentId, target.threadId)
  return buildConnection(agentId, agent, {
    threadId: target.threadId,
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    title: target.title,
  })
}

/**
 * Persist that a Workspace was opened, BEFORE the agent starts, so even a
 * not-signed-in Workspace lists. Returns the persisted Workspace id (so a fresh
 * draft's first-prompt `upsertThread` can record its Thread under the real
 * Workspace), or `null` on failure. Best-effort: a failing `persist()` (disk full /
 * read-only userData) must NEVER reject the connect flow — the renderer's onClick
 * has no `.catch`, so a throw here would wedge the UI on "Launching…".
 */
async function recordWorkspaceOpen(deps: MainDeps, workspaceDir: string): Promise<string | null> {
  try {
    const ws = await deps.store.upsertWorkspace({
      dir: workspaceDir,
      displayName: basename(workspaceDir),
    })
    return ws.id
  } catch {
    // A persistence failure is non-fatal — the connect flow proceeds (degraded).
    return null
  }
}

/**
 * Map a thread-open failure to a result. An auth-classified error (a -32000
 * mid-session/expiry) keeps the agent ALIVE and routes to the sign-in panel;
 * any other failure stops + disposes the agent.
 */
function threadFailureResult(agentId: string, agent: WorkspaceAgent, err: unknown): StartThreadResult {
  if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
    // Keep the agent WARM in the pool so the renderer's follow-up signIn({agentId})
    // reuses it (it's already registered by `pool.acquire`) — a warm-but-unauthed
    // Workspace is driven to sign-in, never respawned.
    return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: agent.workspaceDir, authMethods: agent.authMethods }
  }
  // A non-auth failure: dispose the agent so the next select re-warms fresh.
  pool.dispose(agentId)
  if (err instanceof WorkspaceAgentError) return { ok: false, kind: 'error', error: err.message, hint: err.hint }
  return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err), hint: null }
}

/**
 * Wire a freshly-spawned pool agent's `event` tee — called exactly ONCE per spawn
 * (a reused warm agent already has its listener). Each streamed payload is teed to
 * ITS Thread's JSONL, routed by the event's OWN sessionId so that with several
 * warm agents an event always lands in the right Thread regardless of which
 * Workspace is focused, then forwarded to the renderer tagged by `agentId`.
 * Best-effort: the tee never gates the live forward.
 */
function wireAgentEvents(deps: MainDeps, agentId: string, agent: WorkspaceAgent, sender: WebContents): void {
  agent.on('event', (payload: unknown) => {
    const sessionId = sessionIdFromPayload(payload)
    deps.bridge.tee(deps.bridge.threadIdFor(agentId, sessionId), acpEventEntry(payload))
    // vibe-acp pushes the session's auto-title lazily after the first prompt via a
    // `session_info_update` (never in `session/new`) — capture it so the Thread stops
    // showing "Untitled". Persist + push by the event's OWN sessionId; best-effort.
    const title = titleFromSessionInfoUpdate(payload)
    if (title !== null) void recordThreadTitle(deps, sessionId, title)
    // A forwarded `session/request_permission` blocks the turn until the renderer
    // answers — surface it as the Thread's `needsAttention` (#53). Resolve its
    // Thread the same way the tee does (the event's OWN sessionId via the store,
    // falling back to the agent's active Thread); skip when unattributable.
    const requestId = permissionRequestIdOf(payload)
    if (requestId !== null) {
      const threadId = deps.bridge.threadIdFor(agentId, sessionId)
      if (threadId) emitThreadStatus(threadStatus.addPermission(agentId, threadId, requestId))
    }
    if (!sender.isDestroyed()) {
      sender.send(IPC.acpEvent, { agentId, payload })
    }
  })
}

/**
 * Run one prompt turn: bind-on-first-prompt, tee the input, send `session/prompt`,
 * and map the outcome to a `SendPromptResult`. Extracted from the IPC handler so
 * the handler stays a thin eviction-protection wrapper (TB5 #50). `sender` is the
 * request's webContents (for the up-front `thread:bound` signal).
 */
async function runPromptTurn(
  deps: MainDeps,
  sender: WebContents,
  agent: WorkspaceAgent,
  args: SendPromptArgs,
): Promise<SendPromptResult> {
  // Bind on first prompt (ADR-0005, TB5): a draft (sessionId null) mints its
  // session via `session/new` NOW and binds it onto this Thread id; a reopened
  // Thread whose stored session isn't hosted resumes via `session/load` (re-binding
  // fresh on a resume failure); an already-bound Thread reuses its session — no
  // second `session/new`. A binding failure surfaces WITHOUT teeing: nothing was
  // logged yet, so a failed first prompt leaves no transcript residue.
  let sessionId: string
  let rebound: boolean
  try {
    // Point the bridge at the Thread being prompted, so a session-less lifecycle
    // event tees to the ACTIVE Thread when several share an agent — refreshed every
    // prompt (last-write-wins, and only the active Thread prompts at a time).
    deps.bridge.bind(args.agentId, args.threadId)
    // A draft's first prompt (sessionId null) claims the Workspace's eager primary
    // session (ADR-0012), so it binds to that instead of minting a SECOND
    // `session/new`; consumed once, so a second concurrent draft mints its own.
    // Never claimed for a reopened/already-bound Thread (those aren't case (i)).
    const preopened = args.sessionId === null ? (agent.consumePrimarySession() ?? undefined) : undefined
    const bound = await ensureBoundSession({
      agent,
      store: deps.store,
      threadId: args.threadId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      preopened,
    })
    sessionId = bound.sessionId
    rebound = bound.rebound
    // Tell the renderer this Thread is now bound, the INSTANT `session/new` /
    // `session/load` returns and BEFORE `agent.prompt` streams any event below
    // (same webContents, so ordered ahead of those `acp:event`s). This binds the
    // Thread's live view to its OWN session up front, so it never infers a
    // session from an arbitrary (possibly sibling) event. `rebound` (TB4 #33)
    // carries a NEW session for a reopened Thread whose resume failed — the
    // renderer rebinds its live view to it AND renders the "context reset" notice.
    //
    // We emit whenever the bind produced a fresh result with `controls` (#70) — a
    // mint, a re-bind, OR a successful resume — so the Thread's picker sources its
    // OWN Mode/Model/effort from THIS session (the #66 single-Thread limitation this
    // removes). A plain reuse of an already-hosted session brings null controls and
    // no re-emit (the renderer keeps what it holds). We hand the renderer the
    // session's REPORTED controls only; the renderer caches the user's prior
    // non-default selection and RE-ASSERTS it after a `session/load` resume (#72,
    // ADR-0007) — main stays oblivious to that within-session, renderer-only cache.
    if (bound.controls && !sender.isDestroyed()) {
      sender.send(IPC.threadBound, { threadId: args.threadId, sessionId, rebound, controls: bound.controls })
    }
  } catch (err) {
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }

  // A prompt is Thread ACTIVITY: bump the persisted `lastActiveAt` so the sidebar's
  // timestamp + order reflect the last prompt, not the first bind. Without this a
  // continued Thread (successful resume) or any later prompt on an already-hosted
  // session never re-wrote the store — the record kept its bind-time timestamp
  // forever. Best-effort + fire-and-forget (ADR-0005): a persist failure logs and
  // never gates the turn.
  void deps.store.touchThread(args.threadId).catch((err) => {
    console.error(
      `[vibe-mistro:metadata] touchThread failed (${args.threadId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  })

  // Tee the user's prompt (the conversation INPUT) to THIS Thread's log before
  // sending it, so it precedes the streamed events it triggers. We hold the
  // Thread id, so no bridge lookup — a draft's first prompt can't misroute to
  // another Thread. Main has no renderer item id, so mint an opaque replay key.
  //
  // Image attachments persist FIRST (awaited: the refs must exist when the entry
  // is appended, and the entry must precede the turn's `acp-event` tees — the
  // TranscriptStore chain serializes in CALL order). `saveAll` never rejects; a
  // failed/oversized image drops out of the refs and the prompt replays
  // text-only. Skipped for a tombstoned Thread so a removeWorkspace racing this
  // in-flight prompt can't re-create the attachments dir after its delete.
  let imageRefs: TranscriptImageRef[] | undefined
  if (deps.attachments && args.images?.length && !deps.bridge.isTombstoned(args.threadId)) {
    imageRefs = await deps.attachments.saveAll(args.threadId, args.images)
    if (imageRefs.length === 0) imageRefs = undefined
  }
  deps.bridge.tee(args.threadId, userPromptEntry(randomUUID(), args.text, imageRefs))
  // On a re-bind (TB4 #33), persist the "context reset" notice right AFTER the
  // user's prompt and BEFORE the turn's events — so a later reopen replays it
  // in the same position the live view rendered it (`thread:bound` -> notice).
  if (rebound) deps.bridge.tee(args.threadId, agentReboundEntry())
  try {
    const result = await agent.prompt(sessionId, args.text, args.images)
    // Tee the clean turn end: this signal lives ONLY in this IPC response
    // (never an `acp:event`), so without it a replay leaves `isProcessing`
    // stuck true. Serialized after the turn's events (TranscriptStore chain).
    deps.bridge.tee(args.threadId, turnCompleteEntry())
    return { ok: true, result, sessionId }
  } catch (err) {
    // Mid-session expiry (-32000): keep the agent alive so the renderer can
    // re-auth in place on the same agent; don't stop it. This is a re-auth
    // flow, NOT a conversation error — tee `turn-complete` (the renderer
    // synthesizes no ErrorItem here either), so replay isn't left processing.
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      deps.bridge.tee(args.threadId, turnCompleteEntry())
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    const message = err instanceof Error ? err.message : String(err)
    deps.bridge.tee(args.threadId, turnErrorEntry(message))
    // Carry the JSON-RPC/app code (e.g. -31008 for an unsupported/oversized image,
    // #100) so the renderer can special-case it rather than show a generic error.
    return {
      ok: false,
      kind: 'error',
      error: message,
      code: err instanceof WorkspaceAgentError ? err.code ?? undefined : undefined,
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(deps: MainDeps): void {
  // Feature registrars (conventions.md `registerIpc(deps)` DI): the git and files
  // handler groups are self-contained pass-throughs to their modules, registered
  // next to them.
  registerGitIpc({ gitStatus })
  registerFilesIpc({ pool, cache: filesListCache })

  ipcMain.handle(IPC.detectVibe, () => detectVibe())

  ipcMain.handle(IPC.openWorkspaceDialog, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.startThread, async (event, args: StartThreadArgs): Promise<StartThreadResult> => {
    // Warm pool (ADR-0006 decision 3): lazily spawn this Workspace's agent on its
    // first select and REUSE it thereafter — no dispose-then-respawn. A reused warm
    // agent skips the handshake (start() early-returns below) and its event tee is
    // already wired, so a re-select / continue never re-handshakes.
    const { agentId, agent, created } = pool.acquire(args.workspaceDir)
    if (created) wireAgentEvents(deps, agentId, agent, event.sender)

    // Enforce the warm-count cap right after warming this Workspace (TB5 #50): if
    // we're now over MAX_WARM_AGENTS, trim the least-recently-active UNPROTECTED
    // agent and tell the renderer to re-warm it lazily on next select. The agent we
    // just acquired is most-recently-active, so it's never the one trimmed.
    notifyAgentsEvicted(deps.bridge, pool.enforceCap({ maxWarm: MAX_WARM_AGENTS, isProtected: isAgentProtected }))

    // Persist the Workspace open up front (ADR-0005), so even a not-signed-in
    // Workspace shows in the cold list. Best-effort — must not reject connect.
    // Its id seeds a fresh draft's first-prompt upsert (below).
    const workspaceId = await recordWorkspaceOpen(deps, args.workspaceDir)

    try {
      // Idempotent: spawns + handshakes a fresh agent, no-ops a warm one (already
      // initialized) — so reuse never re-spawns the child or re-runs the handshake.
      await agent.start()

      // Detected not-signed-in: keep the agent warm (the sign-in flow drives it)
      // but don't open a Thread — session/new would fail with -32000. The renderer
      // shows the sign-in panel and re-tries openThread after sign-in.
      if (agent.authState === 'not-signed-in') {
        return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: args.workspaceDir, authMethods: agent.authMethods }
      }

      // Open the Workspace's eager primary session (ADR-0012) so a draft's/continue's
      // picker reads real controls pre-prompt, and the first prompt REUSES it (no
      // second `session/new`). Best-effort: a `session/new` failure must NOT break
      // connect — fall back to a null-controls draft (the #153 cache still covers the
      // picker). Signed-in was just checked, so a -32000 shouldn't happen; catch
      // defensively anyway. A no-op on a re-select whose agent already opened one.
      try {
        await agent.openPrimarySession()
      } catch {
        // Swallow: connect proceeds with a null-controls draft/continue connection.
      }

      // Continue from the cold launch list (TB4 #33): connect to the EXISTING
      // Thread (its first prompt drives the lazy `session/load` resume) without
      // opening — and persisting — a throwaway empty Thread. Falls through to a
      // fresh draft when the record can't be resolved.
      if (args.continueThreadId) {
        const continued = continueConnection(deps, agentId, agent, args.continueThreadId)
        if (continued) return { ok: true, thread: continued }
      }

      // Open a fresh DRAFT Thread (ADR-0011): NO `session/new`, NO empty record.
      // The draft binds a session + persists only on its first prompt, so clicking
      // a Workspace never leaves a Thread nobody prompted. The `agent.start()`
      // above still surfaces a not-signed-in / handshake error via the catch.
      return { ok: true, thread: draftConnection(deps, agentId, agent, workspaceId) }
    } catch (err) {
      return threadFailureResult(agentId, agent, err)
    }
  })

  ipcMain.handle(IPC.openThread, async (_event, args: OpenThreadArgs): Promise<StartThreadResult> => {
    // Land in a fresh DRAFT Thread on an agent already started + signed in (after
    // sign-in or an in-place re-auth). Reuses the retained agent — no re-spawn — and,
    // like Workspace-open, opens NO session and persists NO record until the first
    // prompt (ADR-0011). Records the Workspace open to learn its id for that upsert.
    const agent = pool.get(args.agentId)
    if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.`, hint: null }
    pool.touch(args.agentId) // landing in a Thread is activity — outrank idle peers (TB5 #50)
    const workspaceId = await recordWorkspaceOpen(deps, agent.workspaceDir)
    // Open the eager primary session (ADR-0012) for this post-sign-in draft too, so
    // its picker reads real controls and its first prompt reuses it. Best-effort —
    // a failure falls back to a null-controls draft. No-op if one is already open.
    try {
      await agent.openPrimarySession()
    } catch {
      // Swallow: the draft connection is still returned (null-controls fallback).
    }
    return { ok: true, thread: draftConnection(deps, args.agentId, agent, workspaceId) }
  })

  ipcMain.handle(
    IPC.sendPrompt,
    async (event, args: SendPromptArgs): Promise<SendPromptResult> => {
      const agent = pool.get(args.agentId)
      if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.` }

      // Activity + eviction protection (TB5 #50): a prompt is real activity, so
      // touch the agent (it outranks idle peers under the idle/cap policy), and
      // mark a turn IN FLIGHT for the call's duration so the sweep/cap can't evict
      // a streaming Workspace out from under the user. `endTurn` runs no matter how
      // the turn settles (success, error, or a thrown bind), so the flag can't leak.
      pool.touch(args.agentId)
      activity.beginTurn(args.agentId)
      // Per-THREAD streaming (#53): mark THIS Thread streaming for the whole turn
      // (covering the bind), so a non-active live Thread's in-flight turn shows in
      // the sidebar. Cleared in the same `finally` as the per-agent protection.
      emitThreadStatus(threadStatus.beginTurn(args.agentId, args.threadId))
      try {
        return await runPromptTurn(deps, event.sender, agent, args)
      } finally {
        activity.endTurn(args.agentId)
        // Clear streaming, then sweep any permission left unanswered when the turn
        // settled abnormally (error / -32000) — the agent isn't blocking anymore,
        // so no `needsAttention` should linger past the turn (#53). The blanket
        // `clearThread` is safe because the renderer's single-prompt gate guarantees
        // ONE in-flight turn per Thread, so it can't strand a concurrent turn's
        // permission (see `ThreadStatusTracker.clearThread`).
        emitThreadStatus(threadStatus.endTurn(args.agentId, args.threadId))
        emitThreadStatus(threadStatus.clearThread(args.threadId))
        // Re-read git status for THIS Workspace at turn end (#84): the working-tree
        // watcher ignores `.git/`, so the agent's OWN git commands (e.g. a commit) are
        // invisible to it — this trigger catches them. No-op unless the Workspace's
        // Changes panel is subscribed.
        gitStatus.refresh(agent.workspaceDir)
      }
    },
  )

  ipcMain.handle(IPC.respondPermission, (_event, args: RespondPermissionArgs) => {
    // Main only relays the user's choice back to the agent by request id; the
    // approve/deny decision lives in the renderer (ADR-0001). We also tee the
    // choice to the transcript — main sees requestId + optionId but not the
    // option's display name (renderer-side), so the entry's `name` is null.
    // Tee by the renderer-supplied `threadId` directly (TB5), NOT the agent's
    // last-prompted map: answering Thread A's permission after switching+prompting
    // a sibling B must land in A's log, not B's.
    const agent = pool.get(args.agentId)
    pool.touch(args.agentId) // answering a permission is activity (TB5 #50)
    deps.bridge.tee(args.threadId, resolvePermissionEntry(args.requestId, args.optionId))
    // Clear the Thread's `needsAttention` (#53): the blocking permission is answered.
    emitThreadStatus(threadStatus.resolvePermission(args.agentId, args.requestId))
    agent?.respondPermission(args.requestId, args.optionId)
  })

  ipcMain.handle(IPC.cancelTurn, (_event, args: CancelTurnArgs) => {
    // Interrupt the active turn (#103, ADR-0009): resolve the pool agent and fire
    // the `session/cancel` notification. The cancelled `session/prompt` resolves
    // via the normal turn-complete path — no new output shape here.
    if (!args.sessionId) return // an unbound draft has no active turn to cancel
    const agent = pool.get(args.agentId)
    agent?.cancel(args.sessionId)
  })

  ipcMain.handle(IPC.setActiveAgent, (_event, agentId: string | null) => {
    // The renderer reports which Workspace agent is currently ON SCREEN (TB5 #50).
    // Tracked so `isAgentProtected` shields it from idle/cap eviction — the
    // Workspace the user is looking at is never trimmed out from under them.
    activity.setActive(agentId)
  })

  ipcMain.handle(IPC.signIn, async (_event, args: SignInArgs): Promise<SignInResult> => {
    // Drive Vibe's browser sign-in on the agent retained from startThread; main
    // orchestrates + relays the resulting AuthState, the renderer owns the view
    // state (ADR-0001). Credentials never touch us — Vibe owns the keyring (ADR-0003).
    const agent = pool.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    // Protect the agent for the WHOLE sign-in (TB5 #50): a delegated browser OAuth
    // can pend past IDLE_EVICT_MS while the user is on another Workspace, so without
    // this the sweep would evict it mid-flight and reject the call. `endAuth` always
    // runs in `finally`, so the flag can't leak even on failure/early-exit.
    pool.touch(args.agentId)
    activity.beginAuth(args.agentId)
    try {
      const authState = await agent.signIn(args.methodId)
      return { ok: true, authState }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // Diagnostic breadcrumb to main-process stderr (NOT the renderer transcript):
      // the formatted message already carries Vibe's reason + the JSON-RPC code, so
      // an intermittent failure (e.g. a timed-out delegated `complete`) is traceable.
      console.error(`[vibe-mistro:auth] sign-in failed (agent ${args.agentId}): ${error}`)
      return { ok: false, error }
    } finally {
      activity.endAuth(args.agentId)
    }
  })

  ipcMain.handle(IPC.signOut, async (_event, args: SignOutArgs): Promise<SignOutResult> => {
    // Sign out via Vibe's keyring removal and relay the new state; the agent
    // stays alive so the user can sign a different account back in (ADR-0003).
    const agent = pool.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    pool.touch(args.agentId) // sign-out is quick activity; a touch suffices (TB5 #50)
    try {
      const authState = await agent.signOut()
      return { ok: true, authState, authMethods: agent.authMethods }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[vibe-mistro:auth] sign-out failed (agent ${args.agentId}): ${error}`)
      return { ok: false, error }
    }
  })

  ipcMain.handle(
    IPC.checkAuthStatus,
    async (_event, args: CheckAuthStatusArgs): Promise<CheckAuthStatusResult> => {
      // Re-query `_auth/status` to OBSERVE current auth state without re-running
      // the sign-in flow (#79) — recovers an out-of-band `vibe` CLI sign-in, the
      // blocking fallback, or a delegated `complete` whose result we lost. A quick
      // round-trip, so a `touch` suffices (no eviction protection like signIn).
      const agent = pool.get(args.agentId)
      if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
      pool.touch(args.agentId)
      try {
        const authState = await agent.refreshAuthStatus()
        return { ok: true, authState, signOutAvailable: agent.signOutAvailable }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        console.error(`[vibe-mistro:auth] status check failed (agent ${args.agentId}): ${error}`)
        return { ok: false, error }
      }
    },
  )

  ipcMain.handle(IPC.stopAgent, (_event, agentId: string) => {
    // Explicit close: the pool stops the child and drops it; the Workspace
    // re-warms transparently on its next select (metadata + JSONL survive).
    pool.dispose(agentId)
    // Drop the agent's per-Thread status + activity + transcript bridge so an
    // explicit stop leaves no stale indicator (#53) — mirrors the eviction cleanup.
    deps.bridge.evictAgent(agentId)
    activity.evict(agentId)
    emitThreadStatus(threadStatus.evictAgent(agentId))
  })

  ipcMain.handle(IPC.deleteThread, async (_event, threadId: string): Promise<DeleteThreadResult> => {
    // Delete a Thread end-to-end (ADR-0005, TB6 #35): best-effort close its live
    // ACP session (if one is hosted), then remove OUR records — the metadata entry
    // and the JSONL transcript. Every step is best-effort: a null transcript skips
    // the file drop, no live session skips the close — never a throw, so a
    // misclick-deleted draft can't wedge.
    //
    // AUTHORITATIVE streaming guard (#53): delete is now wired into the live Thread
    // list (an idle live Thread is deletable). Main owns `threadStatus`, so re-check
    // it here and REFUSE a delete on a Thread whose turn is still in flight —
    // defense-in-depth against the click-race where the renderer's async delete gate
    // fired just as `beginTurn` streamed out. A genuinely idle live Thread holds no
    // tracker state, so it passes and deletes cleanly via `bestEffortCloseFor` +
    // the renderer's `wt remove`; only a mid-turn one is bounced (`reason:'streaming'`).
    if (threadStatus.statusFor(threadId).streaming) return { ok: false, reason: 'streaming' }
    // Clear any transcript-bridge entry pointing at this Thread BEFORE the
    // orchestration, to shrink the window in which a fresh tee could re-create its
    // JSONL. With the streaming guard above no live turn is appending to a deletable
    // Thread, so this clear plus `bestEffortCloseFor` (which reads the bound session
    // from the metadata snapshot, not the bridge) tears the session down safely.
    deps.bridge.clearThread(threadId)
    await deleteThread({
      threadId,
      store: deps.store,
      transcript: deps.transcript ?? { delete: () => Promise.resolve() },
      attachments: deps.attachments ?? undefined,
      closeSession: bestEffortCloseFor(deps, threadId),
    })
    return { ok: true }
  })

  ipcMain.handle(
    IPC.removeWorkspace,
    async (_event, workspaceId: string): Promise<RemoveWorkspaceResult> => {
      // Remove a Workspace end-to-end ("Remove project", ADR-0005): stop its warm
      // agent cleanly (if any — allowed even mid-turn), then remove OUR records — the
      // Workspace + Thread metadata and their JSONL transcripts. NEVER deletes files
      // on disk. A thin wrapper: all real logic lives in the pure `removeWorkspace`
      // orchestrator + `MetadataStore.removeWorkspace`. Best-effort throughout, so a
      // cold Workspace just no-ops — never a throw.
      const snapshot = deps.store.snapshot()
      // Resolve the Workspace dir → its warm agentId (null when cold). The dir is the
      // pool's key, so a warm agent for this Workspace is found here before removal.
      const dir = snapshot.workspaces.find((w) => w.id === workspaceId)?.dir
      const agentId = dir ? pool.agentIdForWorkspace(dir) : null
      // Tombstone this Workspace's Thread ids BEFORE anything tears down, so a late
      // tee from the disposed agent's rejected in-flight turn (or a straggling event)
      // can't re-create a just-deleted JSONL. Safe for a mid-turn removal — see
      // `TranscriptBridge`. Done first: dispose (below) rejects the pending prompt.
      for (const t of snapshot.threads) {
        if (t.workspaceId === workspaceId) deps.bridge.tombstone(t.id)
      }
      await removeWorkspace({
        workspaceId,
        store: deps.store,
        transcript: deps.transcript ?? { delete: () => Promise.resolve() },
        attachments: deps.attachments ?? undefined,
        // When a warm agent hosts this Workspace, stop it via the SAME path the
        // sweep/stop uses: `pool.dispose` (graceful teardown of hosted sessions) plus
        // `notifyAgentsEvicted` (clears the activity + transcript bridge + per-Thread
        // status AND tells the renderer to drop the now-dead connection). Order mirrors
        // `stopAgent`/the sweep: dispose the child, then broadcast the eviction cleanup.
        stopAgent: agentId
          ? () => {
              pool.dispose(agentId)
              notifyAgentsEvicted(deps.bridge, [agentId])
            }
          : undefined,
      })
      return { ok: true }
    },
  )

  ipcMain.handle(
    IPC.setThreadFlags,
    async (_event, args: SetThreadFlagsArgs): Promise<SetThreadFlagsResult> => {
      // Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive) on OUR
      // metadata record. A SAFE metadata op — no ACP session teardown — so unlike
      // delete it has no streaming guard. Best-effort per ADR-0005: a failed persist
      // returns `{ok:false}` (never throws into the live flow); the renderer then
      // leaves the list unchanged. `setThreadFlags` is a no-op for an unknown id.
      // Persisting the metadata index is not agent activity → no `pool.touch`.
      try {
        await deps.store.setThreadFlags(args.threadId, {
          pinned: args.pinned,
          archived: args.archived,
        })
        return { ok: true }
      } catch (err) {
        console.error(
          `[vibe-mistro:metadata] setThreadFlags failed (${args.threadId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        return { ok: false }
      }
    },
  )

  ipcMain.handle(
    IPC.setThreadTitle,
    async (_event, args: SetThreadTitleArgs): Promise<SetThreadTitleResult> => {
      // Rename a Thread. We OWN the title, so the source of truth is OUR store — set it
      // in place (no reorder, #132/#133 style). When the Thread has a LIVE session, ALSO
      // sync the vibe-acp side (`_session/set_title`) so its saved metadata + `session/list`
      // match; that call is best-effort (ADR-0005) — its failure never fails the rename,
      // and its `session_info_update` echo is absorbed by the idempotent store write. A
      // cold Thread (no agentId/session) renames on the store alone. `{ok:false}` only on
      // a store failure, so the renderer reverts just when nothing persisted.
      const title = args.title.trim()
      if (!title) return { ok: false } // never persist an empty title
      try {
        await deps.store.setThreadTitle(args.threadId, title)
      } catch (err) {
        console.error(
          `[vibe-mistro:metadata] setThreadTitle failed (${args.threadId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        return { ok: false }
      }
      if (args.agentId && args.sessionId) {
        const agent = pool.get(args.agentId)
        if (agent?.hasSession(args.sessionId)) {
          pool.touch(args.agentId)
          try {
            await agent.setTitle(args.sessionId, title)
          } catch (err) {
            console.error(
              `[vibe-mistro:acp] session/set_title sync failed (${args.threadId}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
      return { ok: true }
    },
  )

  ipcMain.handle(
    IPC.setThreadConfig,
    async (_event, args: SetThreadConfigArgs): Promise<SetThreadConfigResult> => {
      // Change one agent control (#66) on a Thread's bound session: resolve the
      // agent, map the axis to its verified setter (acp-capture §10), and return
      // ok/err. The renderer already reflected the change optimistically, so an
      // `{ok:false}` here is its cue to revert. Touch the agent — a config change is
      // activity, like a prompt/permission answer (TB5 #50).
      const agent = pool.get(args.agentId)
      if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
      pool.touch(args.agentId)
      try {
        if (args.axis === 'mode') await agent.setMode(args.sessionId, args.value)
        else if (args.axis === 'model') await agent.setModel(args.sessionId, args.value)
        else await agent.setReasoningEffort(args.sessionId, args.value)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(IPC.getThreadStatuses, (): ThreadStatusEvent[] => {
    // One-shot re-seed for a renderer that mounts MID-turn (#53): main pushes
    // `thread:status` only on a change, so a fresh/reloaded window would otherwise
    // miss an in-flight turn or pending permission until the next flip. Return the
    // current non-default statuses; the renderer folds them into its registry.
    return threadStatus.snapshot()
  })

  ipcMain.handle(IPC.listMetadata, (): ListMetadataResult => {
    // The cold launch list (ADR-0005): persisted Workspaces + Threads from
    // metadata alone — no agent spawned, no transcript loaded.
    return groupThreadsByWorkspace(deps.store.snapshot())
  })

  ipcMain.handle(IPC.readTranscript, (_event, threadId: string): Promise<ReadTranscriptResult> => {
    // The process-free reopen source (ADR-0005, TB3): hand the renderer the
    // Thread's logged input stream so it can replay through the reducer with NO
    // `vibe-acp` spawned. A missing/absent log reads back as [] (never throws).
    if (!deps.transcript) return Promise.resolve([])
    return deps.transcript.read(threadId)
  })

  ipcMain.handle(
    IPC.readThreadAttachments,
    (_event, threadId: string): Promise<ReadThreadAttachmentsResult> => {
      // The replay's batched image read: every persisted attachment of the Thread
      // as `file -> data URL`, resolved against the `user-prompt` entries' refs.
      // Called by the hydrate effect only when the transcript references images.
      // A null store (dir mkdir failed) or an image-less Thread reads back {}.
      if (!deps.attachments) return Promise.resolve({})
      return deps.attachments.readAll(threadId)
    },
  )
}

app.whenReady().then(async () => {
  // Load the persisted index before the first window so the renderer's launch
  // fetch sees prior Workspaces/Threads. `userData` is only valid once ready.
  // A failed load degrades to empty state INSIDE `load()` (never a throw), so the
  // store is unconditionally present — see `MainDeps`.
  const store = new MetadataStore({ filePath: join(app.getPath('userData'), 'metadata.json') })
  await store.load()

  // The per-Thread transcript dir (ADR-0005). `appendFile` won't create parent
  // dirs, so ensure it exists once here; a failure leaves `transcript` null and
  // teeing becomes a silent no-op inside the bridge (best-effort — the
  // conversation is fine).
  const transcriptsDir = join(app.getPath('userData'), 'transcripts')
  let transcript: TranscriptStore | null
  try {
    await mkdir(transcriptsDir, { recursive: true })
    transcript = new TranscriptStore({ dir: transcriptsDir })
  } catch {
    transcript = null
  }

  // The per-Thread prompt-image attachments dir (sibling of the transcripts —
  // the store mkdirs each Thread's subdir itself, but probe the root once here
  // so a broken `userData` degrades to null exactly like the transcript store).
  const attachmentsDir = join(app.getPath('userData'), 'attachments')
  let attachments: AttachmentStore | null
  try {
    await mkdir(attachmentsDir, { recursive: true })
    attachments = new AttachmentStore({ dir: attachmentsDir })
  } catch {
    attachments = null
  }

  // The ACP-event -> Thread-JSONL router (see `TranscriptBridge`): primary route by
  // the event's own sessionId (via the store), fallback by the agent's active Thread.
  const bridge = new TranscriptBridge({
    sink: transcript,
    resolveBySession: (sessionId) => store.findThreadIdBySessionId(sessionId),
  })
  const deps: MainDeps = { store, transcript, bridge, attachments }

  registerIpc(deps)
  createWindow()

  // The periodic sweep (TB5 #50): release any agent untouched past IDLE_EVICT_MS,
  // THEN re-run the cap, both skipping the protected (on-screen / mid-turn /
  // mid-sign-in) agents, and notify the renderer to re-warm any evicted ones lazily
  // on next select. Running `enforceCap` here too lets a temporarily over-cap state
  // — one that persisted because every over-cap candidate was protected at acquire
  // time — self-heal on a later sweep once a candidate becomes unprotected. Started
  // once here; the interval is `unref`'d so it never keeps the process alive on its
  // own, and is cleared on quit. Resilient across the macOS window-close/reopen
  // cycle — after `disposeAll` the pool is empty, so the sweep no-ops until re-warmed.
  sweepTimer = setInterval(() => {
    notifyAgentsEvicted(bridge, pool.evictIdle({ idleMs: IDLE_EVICT_MS, isProtected: isAgentProtected }))
    notifyAgentsEvicted(bridge, pool.enforceCap({ maxWarm: MAX_WARM_AGENTS, isProtected: isAgentProtected }))
  }, SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // The pool is process-global, which is fine for single-window TB1/TB2.
  // A future multi-window slice should scope the pool per window.
  pool.disposeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // Stop the idle-evict sweep so no timer outlives the app (TB5 #50). The pool's
  // own teardown is `window-all-closed`'s `disposeAll`; this just clears the timer.
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  // Tear down every git-status subscription (#84) so no fs watcher or fetch timer
  // outlives the app — mirrors the sweep-timer cleanup above.
  gitStatus.disposeAll()
})
