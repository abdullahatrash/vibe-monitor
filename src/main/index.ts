import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  IPC,
  type DeleteThreadResult,
  type ListMetadataResult,
  type OpenThreadArgs,
  type ReadTranscriptResult,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SetThreadConfigArgs,
  type SetThreadConfigResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadConnection,
  type ThreadInfo,
  type ThreadStatusEvent,
} from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { groupThreadsByWorkspace, MetadataStore } from './persistence/metadata-store'
import {
  acpEventEntry,
  agentReboundEntry,
  resolvePermissionEntry,
  sessionIdFromPayload,
  TranscriptStore,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
  type TranscriptEntry,
} from './persistence/transcript'
import { WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'
import { AgentPool } from './agent-pool'
import { isProtected } from './agent-protection'
import { ensureBoundSession, resolveContinueTarget } from './thread-binding'
import { deleteThread } from './persistence/delete-thread'
import { permissionRequestIdOf, ThreadStatusTracker, type ThreadStatusChange } from './thread-status'

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
 * The agentId of the Workspace currently ON SCREEN (TB5 #50), reported by the
 * renderer via `setActiveAgent`. Protected from eviction so the Workspace the user
 * is looking at is never trimmed by the idle/cap policy. Null when the selection
 * has no warm agent (idle/connecting/error) — nothing to protect.
 *
 * Single-window assumption: this is an app-GLOBAL protecting the one window's
 * on-screen agent (the pool itself is process-global today — see
 * `window-all-closed`). If a multi-window slice ever lands, protection must become
 * per-window (a set/map of active agents, one per window) or one window's eviction
 * sweep could evict another window's on-screen agent.
 */
let activeAgentId: string | null = null

/**
 * Agents with a prompt turn IN FLIGHT (TB5 #50), by agentId -> open-turn count.
 * An agent mid-turn is protected from eviction so a streaming Workspace is never
 * disposed under the user. A count (not a flag) tolerates overlapping prompts; the
 * entry is removed when it hits zero so the map can't leak.
 */
const inFlightTurns = new Map<string, number>()

/**
 * Per-THREAD live status, the single source of truth for the sidebar's
 * `streaming` / `needsAttention` indicators (#53). Distinct from `inFlightTurns`
 * (which is per-AGENT, for eviction protection): this keys off our durable
 * `threadId` so a NON-active live Thread's turn or blocked permission surfaces in
 * the sidebar even though only the active Thread's `Conversation` is mounted. Fed
 * from the lifecycle signals main already sees — turn begin/end, a forwarded
 * `session/request_permission` out/answered, agent evict — and pushed to the
 * renderer (`emitThreadStatus`) on every change.
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

function beginTurn(agentId: string): void {
  inFlightTurns.set(agentId, (inFlightTurns.get(agentId) ?? 0) + 1)
}

function endTurn(agentId: string): void {
  const next = (inFlightTurns.get(agentId) ?? 0) - 1
  if (next > 0) inFlightTurns.set(agentId, next)
  else inFlightTurns.delete(agentId)
}

/**
 * Agents with a sign-in flow IN PROGRESS (TB5 #50). A backgrounded delegated
 * browser OAuth can pend longer than `IDLE_EVICT_MS` while the user is on another
 * Workspace (so the agent is neither `activeAgentId` nor mid-turn) — without this
 * the sweep would evict it mid-`signIn`, rejecting the call with "AcpClient
 * stopped". Mirrors the turn protection: `beginAuth` at the top of the sign-in
 * handler, `endAuth` in its `finally`. A one-shot `touch` wouldn't suffice — the
 * flow can outlast the idle window — so we protect for its whole duration.
 */
const signingInAgents = new Set<string>()

function beginAuth(agentId: string): void {
  signingInAgents.add(agentId)
}

function endAuth(agentId: string): void {
  signingInAgents.delete(agentId)
}

/**
 * The eviction-protection predicate (TB5 #50) handed to the pool's pure policies:
 * NEVER evict the on-screen Workspace's agent, one mid-turn, or one mid-sign-in. A
 * thin wrapper over the PURE `isProtected` (agent-protection.ts) — the load-bearing
 * safety logic is unit-tested there; this just feeds it the live main-process state.
 */
function isAgentProtected(agentId: string): boolean {
  return isProtected(agentId, { activeAgentId, inFlightTurns, signingInAgents })
}

/** The periodic idle-evict sweep timer (cleared on quit). */
let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Push an eviction notice to every renderer (TB5 #50) so it drops the now-dead
 * agents' Workspace connections and re-warms them lazily on next select. Also
 * clears the agents' transcript-bridge entries so the `agentId -> threadId` map
 * can't leak across evictions. A no-op when nothing was evicted.
 */
function notifyAgentsEvicted(agentIds: string[]): void {
  if (agentIds.length === 0) return
  for (const agentId of agentIds) {
    inFlightTurns.delete(agentId)
    transcriptThreads.delete(agentId)
    // Clear any streaming/pending status the evicted agent's Threads held (#53) so
    // a torn-down agent leaves no stale indicator behind (protection keeps a busy
    // agent from idle/cap eviction, but an explicit stop/dispose can still land).
    emitThreadStatus(threadStatus.evictAgent(agentId))
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(IPC.agentEvicted, { agentIds })
  }
}

/**
 * The single-writer metadata index (ADR-0005). Assigned at app-ready (needs
 * `userData`) and loaded before the first window so the renderer's cold list
 * fetch sees the persisted state. A failed load degrades to empty, never throws.
 */
let metadataStore: MetadataStore | null = null

/**
 * The per-Thread transcript writer (ADR-0005, TB2). Assigned at app-ready (needs
 * `userData`) alongside `metadataStore`. Best-effort like the metadata writes —
 * a failed tee never breaks the live conversation.
 */
let transcriptStore: TranscriptStore | null = null

/**
 * Bridge the ACP-keyed event flow to the JSONL key (the minted Thread `id`, TB1).
 * The PRIMARY route is the event's own ACP `sessionId` (via the store) so each
 * event/prompt lands in ITS Thread even when one agent has opened several Threads
 * in sequence — the `agentId -> threadId` map below is last-write-wins, so a late
 * event from a prior session would misroute under it. The map is the FALLBACK,
 * for chokepoints with no sessionId in hand (e.g. `respondPermission`).
 *
 * Residual (documented): both routes miss during the brief window after
 * `session/new` returns but before `recordThread` persists the sessionId +
 * seeds the map — a `session/update` streamed THEN (notably the immediate
 * `available_commands_update`, not rendered this slice) is dropped from replay.
 * The Thread title is unaffected — it's also persisted in the metadata record.
 */
const transcriptThreads = new Map<string, string>()

/** Resolve the Thread id for a chokepoint, or null to skip the tee (best-effort). */
function threadIdForTee(agentId: string, sessionId?: string | null): string | null {
  return (
    metadataStore?.findThreadIdBySessionId(sessionId ?? null) ?? transcriptThreads.get(agentId) ?? null
  )
}

/**
 * Tee one conversation INPUT to the active Thread's JSONL (ADR-0005). Best-effort
 * and fire-and-forget, guarded exactly like `recordThread`: an absent store or an
 * unresolved Thread id skips the write; the append itself swallows I/O errors.
 */
function teeTranscript(threadId: string | null, entry: TranscriptEntry): void {
  if (!transcriptStore || !threadId) return
  void transcriptStore.append(threadId, entry)
}

/**
 * Build a best-effort close for a Thread's LIVE ACP session on delete (TB6 #35),
 * or `undefined` when there's nothing to close. Resolves the Thread's bound
 * `sessionId` from the metadata snapshot up front (before the record is removed),
 * then closes it across the active agents — a session is hosted by exactly one
 * agent and `closeSession` no-ops on the rest. A cold Thread / unbound draft (no
 * `sessionId`) returns `undefined`, so the deletion just removes our records.
 */
function bestEffortCloseFor(threadId: string): (() => Promise<void>) | undefined {
  const sessionId = metadataStore?.snapshot().threads.find((t) => t.id === threadId)?.sessionId
  if (!sessionId) return undefined
  return async () => {
    for (const agent of pool.agents()) await agent.closeSession(sessionId)
  }
}

/** Our minted handles for a connected Thread (TB5) — carried to the renderer. */
interface ThreadIds {
  threadId: string
  workspaceId: string
}

/**
 * Persist that this Workspace was opened and a Thread minted, and RETURN our
 * durable Thread + Workspace ids (TB5) so the renderer can later create drafts
 * and bind-on-first-prompt under them. The Thread id is distinct from its ACP
 * `sessionId` (the resume cursor for a reopen, TB3). Best-effort: a metadata
 * write must never break the live connect flow — on a store failure we synthesize
 * ids so the live conversation still works (the binding upsert simply retries).
 * Also seeds the `agentId -> threadId` transcript bridge so the agent's streamed
 * events tee to this Thread.
 */
async function recordThread(agentId: string, workspaceDir: string, thread: ThreadInfo): Promise<ThreadIds> {
  if (metadataStore) {
    try {
      const ws = await metadataStore.upsertWorkspace({
        dir: workspaceDir,
        displayName: basename(workspaceDir),
      })
      const record = await metadataStore.upsertThread({
        workspaceId: ws.id,
        sessionId: thread.sessionId,
        title: thread.title,
      })
      transcriptThreads.set(agentId, record.id)
      return { threadId: record.id, workspaceId: ws.id }
    } catch {
      // A persistence failure is non-fatal — fall through to synthesized ids.
    }
  }
  const ids = { threadId: randomUUID(), workspaceId: randomUUID() }
  transcriptThreads.set(agentId, ids.threadId)
  return ids
}

/**
 * Resolve the ACP session to prompt, binding a draft on its first prompt (TB5) and
 * RESUMING a reopened Thread on its first prompt (TB4 #33). With a metadata store,
 * delegate to `ensureBoundSession`, which distinguishes the three cases: draft ->
 * `session/new`; reopened (stored session not hosted by this fresh agent) ->
 * `session/load`, re-binding fresh on a resume failure; already-hosted -> reuse.
 * `minted` is true for a draft mint OR a re-bind; `rebound` flags the re-bind so
 * the caller tees the "context reset" notice and re-emits `thread:bound`.
 *
 * Without a store (best-effort degraded mode), open a session directly so a draft
 * can still prompt; reuse a session the agent already hosts, else open a fresh one
 * (never the bug's `No open Thread` throw — degraded mode has no cursor to resume).
 */
async function bindThreadSession(
  agent: WorkspaceAgent,
  args: SendPromptArgs,
): Promise<{ sessionId: string; minted: boolean; rebound: boolean }> {
  // Point the bridge at the Thread being prompted, so a session-less lifecycle
  // event tees to the ACTIVE Thread when several share an agent — refreshed every
  // prompt (last-write-wins, and only the active Thread prompts at a time).
  transcriptThreads.set(args.agentId, args.threadId)
  if (metadataStore) {
    const bound = await ensureBoundSession({
      agent,
      store: metadataStore,
      threadId: args.threadId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
    })
    return { sessionId: bound.sessionId, minted: bound.minted, rebound: bound.rebound }
  }
  if (args.sessionId && agent.hasSession(args.sessionId)) {
    return { sessionId: args.sessionId, minted: false, rebound: false }
  }
  const thread = await agent.openThread()
  return { sessionId: thread.sessionId, minted: true, rebound: false }
}

/**
 * Persist that a Workspace was opened, BEFORE the agent starts, so even a
 * not-signed-in Workspace lists. Best-effort exactly like `recordThread`: a
 * failing `persist()` (disk full / read-only userData) must NEVER reject the
 * connect flow — the renderer's onClick has no `.catch`, so a throw here would
 * wedge the UI on "Launching…".
 */
async function recordWorkspaceOpen(workspaceDir: string): Promise<void> {
  if (!metadataStore) return
  try {
    await metadataStore.upsertWorkspace({
      dir: workspaceDir,
      displayName: basename(workspaceDir),
    })
  } catch {
    // A persistence failure is non-fatal — the connect flow proceeds.
  }
}

/** Build the renderer-facing connection (carries our minted ids + sign-out gate). */
function connectionFor(
  agentId: string,
  agent: WorkspaceAgent,
  thread: ThreadInfo,
  ids: ThreadIds,
): ThreadConnection {
  return {
    agentId,
    workspaceDir: agent.workspaceDir,
    ...thread,
    threadId: ids.threadId,
    workspaceId: ids.workspaceId,
    signOutAvailable: agent.signOutAvailable,
    authMethods: agent.authMethods,
  }
}

/**
 * Build a connection that CONTINUES an existing persisted Thread (TB4 #33) WITHOUT
 * opening a new one: look its record up in the metadata store and seed the
 * connection with its ids + stored `sessionId` cursor (modes/models stay null until
 * the lazy `session/load` on first prompt). Also seeds the transcript bridge so a
 * session-less lifecycle event tees to this Thread. Returns `null` when there's no
 * store or no matching record, so the caller falls back to opening a fresh Thread.
 */
function continueConnection(
  agentId: string,
  agent: WorkspaceAgent,
  threadId: string,
): ThreadConnection | null {
  if (!metadataStore) return null
  const target = resolveContinueTarget(metadataStore, threadId)
  if (!target) return null
  transcriptThreads.set(agentId, target.threadId)
  return {
    agentId,
    workspaceDir: agent.workspaceDir,
    sessionId: target.sessionId,
    title: target.title,
    modes: null,
    models: null,
    reasoningEffort: null,
    threadId: target.threadId,
    workspaceId: target.workspaceId,
    signOutAvailable: agent.signOutAvailable,
    authMethods: agent.authMethods,
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
function wireAgentEvents(agentId: string, agent: WorkspaceAgent, sender: WebContents): void {
  agent.on('event', (payload: unknown) => {
    const sessionId = sessionIdFromPayload(payload)
    teeTranscript(threadIdForTee(agentId, sessionId), acpEventEntry(payload))
    // A forwarded `session/request_permission` blocks the turn until the renderer
    // answers — surface it as the Thread's `needsAttention` (#53). Resolve its
    // Thread the same way the tee does (the event's OWN sessionId via the store,
    // falling back to the agent's active Thread); skip when unattributable.
    const requestId = permissionRequestIdOf(payload)
    if (requestId !== null) {
      const threadId = threadIdForTee(agentId, sessionId)
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
 * the handler stays a thin eviction-protection wrapper (TB5 #50) — the turn's
 * lifecycle is unchanged from TB4/TB5 (#33/#46). `sender` is the request's
 * webContents (for the up-front `thread:bound` signal).
 */
async function runPromptTurn(
  sender: WebContents,
  agent: WorkspaceAgent,
  args: SendPromptArgs,
): Promise<SendPromptResult> {
  // Bind on first prompt (ADR-0005, TB5): a draft (sessionId null) mints its
  // session via `session/new` NOW and binds it onto this Thread id; an
  // already-bound Thread reuses its session — no second `session/new`. A
  // binding failure surfaces WITHOUT teeing: nothing was logged yet, so a
  // failed first prompt leaves no transcript residue.
  let sessionId: string
  let rebound: boolean
  try {
    const bound = await bindThreadSession(agent, args)
    sessionId = bound.sessionId
    rebound = bound.rebound
    // Tell the renderer its draft is now bound, the INSTANT `session/new`
    // returns and BEFORE `agent.prompt` streams any event below (same
    // webContents, so ordered ahead of those `acp:event`s). This binds the
    // draft's live view to its OWN session up front, so it never infers a
    // session from an arbitrary (possibly sibling) event. `rebound` (TB4 #33)
    // carries a NEW session for a reopened Thread whose resume failed — the
    // renderer rebinds its live view to it AND renders the "context reset" notice.
    if (bound.minted && !sender.isDestroyed()) {
      sender.send(IPC.threadBound, { threadId: args.threadId, sessionId, rebound })
    }
  } catch (err) {
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err) }
  }

  // Tee the user's prompt (the conversation INPUT) to THIS Thread's log before
  // sending it, so it precedes the streamed events it triggers. We hold the
  // Thread id, so no bridge lookup — a draft's first prompt can't misroute to
  // another Thread. Main has no renderer item id, so mint an opaque replay key.
  teeTranscript(args.threadId, userPromptEntry(randomUUID(), args.text))
  // On a re-bind (TB4 #33), persist the "context reset" notice right AFTER the
  // user's prompt and BEFORE the turn's events — so a later reopen replays it
  // in the same position the live view rendered it (`thread:bound` -> notice).
  if (rebound) teeTranscript(args.threadId, agentReboundEntry())
  try {
    const result = await agent.prompt(sessionId, args.text)
    // Tee the clean turn end: this signal lives ONLY in this IPC response
    // (never an `acp:event`), so without it a replay leaves `isProcessing`
    // stuck true. Serialized after the turn's events (TranscriptStore chain).
    teeTranscript(args.threadId, turnCompleteEntry())
    return { ok: true, result, sessionId }
  } catch (err) {
    // Mid-session expiry (-32000): keep the agent alive so the renderer can
    // re-auth in place on the same agent; don't stop it. This is a re-auth
    // flow, NOT a conversation error — tee `turn-complete` (the renderer
    // synthesizes no ErrorItem here either), so replay isn't left processing.
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      teeTranscript(args.threadId, turnCompleteEntry())
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    const message = err instanceof Error ? err.message : String(err)
    teeTranscript(args.threadId, turnErrorEntry(message))
    return { ok: false, kind: 'error', error: message }
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

function registerIpc(): void {
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
    if (created) wireAgentEvents(agentId, agent, event.sender)

    // Enforce the warm-count cap right after warming this Workspace (TB5 #50): if
    // we're now over MAX_WARM_AGENTS, trim the least-recently-active UNPROTECTED
    // agent and tell the renderer to re-warm it lazily on next select. The agent we
    // just acquired is most-recently-active, so it's never the one trimmed.
    notifyAgentsEvicted(pool.enforceCap({ maxWarm: MAX_WARM_AGENTS, isProtected: isAgentProtected }))

    // Persist the Workspace open up front (ADR-0005), so even a not-signed-in
    // Workspace shows in the cold list. Best-effort — must not reject connect.
    await recordWorkspaceOpen(args.workspaceDir)

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

      // Continue from the cold launch list (TB4 #33): connect to the EXISTING
      // Thread (its first prompt drives the lazy `session/load` resume) without
      // opening — and persisting — a throwaway empty Thread. Falls through to the
      // normal open when the record can't be resolved (degraded / no store).
      if (args.continueThreadId) {
        const continued = continueConnection(agentId, agent, args.continueThreadId)
        if (continued) return { ok: true, thread: continued }
      }

      const thread = await agent.openThread()
      const ids = await recordThread(agentId, args.workspaceDir, thread)
      return { ok: true, thread: connectionFor(agentId, agent, thread, ids) }
    } catch (err) {
      return threadFailureResult(agentId, agent, err)
    }
  })

  ipcMain.handle(IPC.openThread, async (_event, args: OpenThreadArgs): Promise<StartThreadResult> => {
    // Open a Thread on an agent already started + signed in (after sign-in or an
    // in-place re-auth). Reuses the retained agent — no re-spawn.
    const agent = pool.get(args.agentId)
    if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.`, hint: null }
    pool.touch(args.agentId) // opening a Thread is activity — outrank idle peers (TB5 #50)
    try {
      const thread = await agent.openThread()
      const ids = await recordThread(args.agentId, agent.workspaceDir, thread)
      return { ok: true, thread: connectionFor(args.agentId, agent, thread, ids) }
    } catch (err) {
      return threadFailureResult(args.agentId, agent, err)
    }
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
      beginTurn(args.agentId)
      // Per-THREAD streaming (#53): mark THIS Thread streaming for the whole turn
      // (covering the bind), so a non-active live Thread's in-flight turn shows in
      // the sidebar. Cleared in the same `finally` as the per-agent protection.
      emitThreadStatus(threadStatus.beginTurn(args.agentId, args.threadId))
      try {
        return await runPromptTurn(event.sender, agent, args)
      } finally {
        endTurn(args.agentId)
        // Clear streaming, then sweep any permission left unanswered when the turn
        // settled abnormally (error / -32000) — the agent isn't blocking anymore,
        // so no `needsAttention` should linger past the turn (#53). The blanket
        // `clearThread` is safe because the renderer's single-prompt gate guarantees
        // ONE in-flight turn per Thread, so it can't strand a concurrent turn's
        // permission (see `ThreadStatusTracker.clearThread`).
        emitThreadStatus(threadStatus.endTurn(args.agentId, args.threadId))
        emitThreadStatus(threadStatus.clearThread(args.threadId))
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
    teeTranscript(args.threadId, resolvePermissionEntry(args.requestId, args.optionId))
    // Clear the Thread's `needsAttention` (#53): the blocking permission is answered.
    emitThreadStatus(threadStatus.resolvePermission(args.agentId, args.requestId))
    agent?.respondPermission(args.requestId, args.optionId)
  })

  ipcMain.handle(IPC.setActiveAgent, (_event, agentId: string | null) => {
    // The renderer reports which Workspace agent is currently ON SCREEN (TB5 #50).
    // Tracked so `isAgentProtected` shields it from idle/cap eviction — the
    // Workspace the user is looking at is never trimmed out from under them.
    activeAgentId = agentId
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
    beginAuth(args.agentId)
    try {
      const authState = await agent.signIn(args.methodId)
      return { ok: true, authState }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      endAuth(args.agentId)
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
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.stopAgent, (_event, agentId: string) => {
    // Explicit close: the pool stops the child and drops it; the Workspace
    // re-warms transparently on its next select (metadata + JSONL survive).
    pool.dispose(agentId)
    // Drop the agent's per-Thread status + transcript bridge so an explicit stop
    // leaves no stale indicator (#53) — mirrors the eviction cleanup.
    transcriptThreads.delete(agentId)
    inFlightTurns.delete(agentId)
    emitThreadStatus(threadStatus.evictAgent(agentId))
  })

  ipcMain.handle(IPC.deleteThread, async (_event, threadId: string): Promise<DeleteThreadResult> => {
    // Delete a Thread end-to-end (ADR-0005, TB6 #35): best-effort close its live
    // ACP session (if one is hosted), then remove OUR records — the metadata entry
    // and the JSONL transcript. Every step is best-effort: an absent store skips
    // the record drop, a null transcript skips the file drop, no live session
    // skips the close — never a throw, so a misclick-deleted draft can't wedge.
    //
    // AUTHORITATIVE streaming guard (#53): delete is now wired into the live Thread
    // list (an idle live Thread is deletable). Main owns `threadStatus`, so re-check
    // it here and REFUSE a delete on a Thread whose turn is still in flight —
    // defense-in-depth against the click-race where the renderer's async delete gate
    // fired just as `beginTurn` streamed out. A genuinely idle live Thread holds no
    // tracker state, so it passes and deletes cleanly via `bestEffortCloseFor` +
    // the renderer's `wt remove`; only a mid-turn one is bounced (`reason:'streaming'`).
    if (threadStatus.statusFor(threadId).streaming) return { ok: false, reason: 'streaming' }
    if (!metadataStore) return { ok: true }
    // Clear any transcript-bridge entry pointing at this Thread BEFORE the
    // orchestration, to shrink the window in which a fresh tee could re-create its
    // JSONL. With the streaming guard above no live turn is appending to a deletable
    // Thread, so this clear plus `bestEffortCloseFor` (which reads the bound session
    // from the metadata snapshot, not this bridge) tears the session down safely.
    for (const [agentId, bound] of transcriptThreads) {
      if (bound === threadId) transcriptThreads.delete(agentId)
    }
    await deleteThread({
      threadId,
      store: metadataStore,
      transcript: transcriptStore ?? { delete: () => Promise.resolve() },
      closeSession: bestEffortCloseFor(threadId),
    })
    return { ok: true }
  })

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
    if (!metadataStore) return []
    return groupThreadsByWorkspace(metadataStore.snapshot())
  })

  ipcMain.handle(IPC.readTranscript, (_event, threadId: string): Promise<ReadTranscriptResult> => {
    // The process-free reopen source (ADR-0005, TB3): hand the renderer the
    // Thread's logged input stream so it can replay through the reducer with NO
    // `vibe-acp` spawned. A missing/absent log reads back as [] (never throws).
    if (!transcriptStore) return Promise.resolve([])
    return transcriptStore.read(threadId)
  })
}

app.whenReady().then(async () => {
  // Load the persisted index before the first window so the renderer's launch
  // fetch sees prior Workspaces/Threads. `userData` is only valid once ready.
  metadataStore = new MetadataStore({ filePath: join(app.getPath('userData'), 'metadata.json') })
  await metadataStore.load()

  // The per-Thread transcript dir (ADR-0005). `appendFile` won't create parent
  // dirs, so ensure it exists once here; a failure leaves `transcriptStore` null
  // and teeing becomes a silent no-op (best-effort — the conversation is fine).
  const transcriptsDir = join(app.getPath('userData'), 'transcripts')
  try {
    await mkdir(transcriptsDir, { recursive: true })
    transcriptStore = new TranscriptStore({ dir: transcriptsDir })
  } catch {
    transcriptStore = null
  }

  registerIpc()
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
    notifyAgentsEvicted(pool.evictIdle({ idleMs: IDLE_EVICT_MS, isProtected: isAgentProtected }))
    notifyAgentsEvicted(pool.enforceCap({ maxWarm: MAX_WARM_AGENTS, isProtected: isAgentProtected }))
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
})
