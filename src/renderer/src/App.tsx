import { useEffect, useReducer, useRef, useState, type JSX } from 'react'
import type {
  AuthMethod,
  ListMetadataResult,
  ThreadMeta,
  VibeDetectResult,
  WorkspaceThreads,
} from '../../shared/ipc'
import {
  authReducer,
  initialAuthViewState,
  selectAuthView,
  signedInAuthViewState,
} from './auth/auth-view'
import { routeThreadResult, type ConnectState } from './connection/routing'
import { ConnectedWorkspace } from './connection/ConnectedWorkspace'
import { ColdThread } from './conversation/ColdThread'

export function App(): JSX.Element {
  const [detect, setDetect] = useState<VibeDetectResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [connect, setConnect] = useState<ConnectState>({ status: 'idle' })
  // Persisted Workspaces + Threads (ADR-0005), listed cold on launch from
  // metadata alone — no agent spawned, no transcript loaded.
  const [recents, setRecents] = useState<ListMetadataResult>([])
  // A persisted Thread the user clicked to REOPEN read-only from its JSONL (TB3,
  // #32) — rendered with no agent spawned. null = showing the cold launch list.
  const [coldThread, setColdThread] = useState<ThreadMeta | null>(null)

  async function runDetect(): Promise<void> {
    setLoading(true)
    const result = await window.api.detectVibe()
    setDetect(result)
    setLoading(false)
  }

  async function refreshRecents(): Promise<void> {
    setRecents(await window.api.listMetadata())
  }

  /**
   * Delete a persisted Thread (TB6): main removes its metadata + JSONL and
   * best-effort closes any live session; we then re-fetch so it disappears from
   * the list. If the deleted Thread is the one open read-only, drop back to the
   * list so we don't render a now-gone transcript.
   */
  async function deleteThread(thread: ThreadMeta): Promise<void> {
    await window.api.deleteThread(thread.id)
    setColdThread((open) => (open?.id === thread.id ? null : open))
    await refreshRecents()
  }

  useEffect(() => {
    void runDetect()
    void refreshRecents()
  }, [])

  async function openProject(): Promise<void> {
    const workspaceDir = await window.api.openWorkspaceDialog()
    if (!workspaceDir) return
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.startThread({ workspaceDir })))
    // Main has now persisted the Workspace (and any Thread); reflect it in the list.
    void refreshRecents()
  }

  // After sign-in (or in-place re-auth) the agent is already started + signed in;
  // open a Thread on it and land in a connected conversation.
  async function continueToThread(agentId: string, workspaceDir: string): Promise<void> {
    setConnect({ status: 'connecting', workspaceDir })
    setConnect(routeThreadResult(await window.api.openThread({ agentId })))
  }

  /** Sign-out / mid-session expiry: drop back to the sign-in panel (same agent). */
  function toSignInPanel(agentId: string, workspaceDir: string, authMethods: AuthMethod[]): void {
    setConnect({ status: 'not-signed-in', agentId, workspaceDir, authMethods })
  }

  const connecting = connect.status === 'connecting'

  return (
    <div className="app">
      <header className="app__header">
        <h1>Vibe Mistro</h1>
        <span className="app__subtitle">Orchestrator for Mistral Vibe agents · ACP backend</span>
      </header>

      <main className="app__main">
        <section className="card">
          <div className="card__title">
            <span>Environment</span>
            <button className="btn" onClick={() => void runDetect()} disabled={loading}>
              {loading ? 'Checking…' : 'Re-check'}
            </button>
          </div>

          {detect && (
            <ul className="status">
              <StatusRow ok={detect.vibeFound} label="vibe CLI" />
              <StatusRow ok={detect.vibeAcpFound} label="vibe-acp (ACP server)" />
              <li className="status__row">
                <span className="status__label">version</span>
                <span className="status__value">{detect.vibeVersion ?? '—'}</span>
              </li>
              {detect.error && <li className="status__error">{detect.error}</li>}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card__title">
            <span>Workspace</span>
            <button className="btn" onClick={() => void openProject()} disabled={connecting}>
              {connecting ? 'Connecting…' : 'Open project'}
            </button>
          </div>

          {/* Reopened Thread: render its saved conversation from JSONL, read-only,
              with NO agent spawned (TB3). Takes over the idle view until closed. */}
          {connect.status === 'idle' && coldThread && (
            <ColdThread thread={coldThread} onClose={() => setColdThread(null)} />
          )}

          {connect.status === 'idle' && !coldThread && (
            <p className="hint">Open a project folder to start a Vibe agent and connect a Thread.</p>
          )}

          {connect.status === 'idle' && !coldThread && recents.length > 0 && (
            <RecentList
              workspaces={recents}
              onOpenThread={setColdThread}
              onDeleteThread={deleteThread}
            />
          )}

          {connect.status === 'connecting' && (
            <p className="hint">
              Launching <code>vibe-acp</code> in <code>{connect.workspaceDir}</code> and running the
              ACP handshake…
            </p>
          )}

          {connect.status === 'not-signed-in' && (
            <SignInPanel
              key={connect.agentId}
              agentId={connect.agentId}
              authMethods={connect.authMethods}
              onSignedIn={() => void continueToThread(connect.agentId, connect.workspaceDir)}
            />
          )}

          {connect.status === 'error' && (
            <div className="alert">
              <div className="alert__title">Couldn’t connect</div>
              <div className="alert__message">{connect.message}</div>
              {connect.hint && <div className="alert__hint">{connect.hint}</div>}
            </div>
          )}

          {connect.status === 'connected' && (
            <>
              {/* Key by agentId (like Conversation) so its useReducer seed resets
                  across connections — a new agent can't inherit the prior
                  session's sign-out gate. */}
              <SignedInBar
                key={connect.thread.agentId}
                agentId={connect.thread.agentId}
                authMethods={connect.thread.authMethods}
                signOutAvailable={connect.thread.signOutAvailable}
                onSignedOut={(authMethods) =>
                  toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
                }
              />
              {/* Key by agentId so the per-Workspace Thread state can't bleed across
                  connections. Hosts multiple Threads on the one agent + switching (TB5). */}
              <ConnectedWorkspace
                key={connect.thread.agentId}
                connection={connect.thread}
                threads={threadsForWorkspace(recents, connect.thread.workspaceId)}
                refreshRecents={refreshRecents}
                onAuthExpired={(authMethods) =>
                  toSignInPanel(connect.thread.agentId, connect.thread.workspaceDir, authMethods)
                }
              />
            </>
          )}
        </section>
      </main>
    </div>
  )
}

/**
 * The not-signed-in panel: clicking Sign-in drives Vibe's delegated browser
 * sign-in via main; on success it bubbles up (`onSignedIn`) so the app opens a
 * Thread on the same retained agent and lands in a connected conversation. The
 * auth lifecycle (signing-in / signed-in / error) is the pure `authReducer`.
 */
function SignInPanel({
  agentId,
  authMethods,
  onSignedIn,
}: {
  agentId: string
  authMethods: AuthMethod[]
  onSignedIn: () => void
}): JSX.Element {
  const [state, dispatch] = useReducer(authReducer, authMethods, initialAuthViewState)
  // Generation counter: bumped on every attempt start and on cancel. Neither the
  // delegated `complete` long-poll nor the blocking `browser-auth` call can be
  // aborted over ACP, so a cancelled (or superseded) attempt's eventual result
  // must be ignored rather than clobber the panel — we only apply a result whose
  // generation is still current. (This guard is method-agnostic: it covers both
  // the delegated primary and the blocking fallback.)
  const attemptRef = useRef(0)
  const view = selectAuthView(state)

  async function signIn(methodId: string): Promise<void> {
    const attempt = ++attemptRef.current
    dispatch({ type: 'sign-in-start' })
    const result = await window.api.signIn({ agentId, methodId })
    if (attempt !== attemptRef.current) return // cancelled/superseded — drop the stale result
    if (result.ok && result.authState === 'signed-in') {
      dispatch({ type: 'sign-in-success' })
      onSignedIn() // continue to a connected Thread on the same agent
    } else {
      dispatch({
        type: 'sign-in-error',
        message: result.ok ? 'Sign-in did not complete. Please try again.' : result.error,
      })
    }
  }

  function cancel(): void {
    attemptRef.current++ // invalidate the in-flight attempt; its result is dropped
    dispatch({ type: 'sign-in-cancel' })
  }

  if (view.kind === 'signed-in') {
    return (
      <div className="signin signin--done">
        <div className="signin__title">Signed in — opening your workspace…</div>
      </div>
    )
  }

  if (view.kind === 'signing-out') {
    return (
      <div className="signin">
        <div className="signin__title">Signing out…</div>
      </div>
    )
  }

  if (view.kind === 'signing-in') {
    return (
      <div className="signin">
        <div className="signin__title">Signing in…</div>
        <div className="signin__message">Complete sign-in in your browser, then return here.</div>
        <button className="btn btn--ghost signin__action" onClick={cancel}>
          Cancel
        </button>
      </div>
    )
  }

  // sign-in or error: both render the (clickable) Sign-in button so the error
  // state stays recoverable.
  return (
    <div className="signin">
      <div className="signin__title">Not signed in to Mistral Vibe</div>
      {view.kind === 'sign-in' && view.description && (
        <div className="signin__message">{view.description}</div>
      )}
      {view.kind === 'error' && <div className="signin__error">{view.message}</div>}
      <button className="btn signin__action" onClick={() => void signIn(view.methodId)}>
        {view.kind === 'error' ? `Retry — ${view.methodName}` : view.methodName}
      </button>
    </div>
  )
}

/**
 * The signed-in indicator shown while connected: status + a Sign-out control
 * gated on `signOutAvailable` (Vibe exposes no account identity, so none is
 * shown). Sign-out returns to the sign-in panel (`onSignedOut`) for an account
 * switch. The sign-out lifecycle is the pure `authReducer`.
 */
function SignedInBar({
  agentId,
  authMethods,
  signOutAvailable,
  onSignedOut,
}: {
  agentId: string
  authMethods: AuthMethod[]
  signOutAvailable: boolean
  onSignedOut: (authMethods: AuthMethod[]) => void
}): JSX.Element | null {
  const [state, dispatch] = useReducer(
    authReducer,
    signedInAuthViewState(authMethods, signOutAvailable),
  )
  const view = selectAuthView(state)

  async function signOut(): Promise<void> {
    dispatch({ type: 'sign-out-start' })
    const result = await window.api.signOut({ agentId })
    if (result.ok) {
      dispatch({ type: 'sign-out-success' })
      onSignedOut(result.authMethods)
    } else {
      dispatch({ type: 'sign-out-error', message: result.error })
    }
  }

  if (view.kind === 'signing-out') {
    return (
      <div className="signedin">
        <span className="signedin__label">Signing out…</span>
      </div>
    )
  }

  if (view.kind !== 'signed-in') return null

  return (
    <div className="signedin">
      <span className="dot dot--ok" aria-hidden />
      <span className="signedin__label">Signed in to Mistral Vibe</span>
      {view.identity && <span className="signedin__identity">{view.identity}</span>}
      {view.error && <span className="signedin__error">{view.error}</span>}
      <span className="signedin__spacer" />
      {view.signOutAvailable && (
        <button className="btn btn--ghost" onClick={() => void signOut()}>
          Sign out
        </button>
      )}
    </div>
  )
}

/**
 * The cold launch list (ADR-0005 metadata-first lazy reopen): persisted
 * Workspaces with their Threads, most-recent-first, rendered from metadata alone —
 * NO `vibe-acp` spawned. Clicking a Thread reopens it read-only from its JSONL
 * (`onOpenThread`, TB3) — still no agent; that replays the transcript locally.
 */
function RecentList({
  workspaces,
  onOpenThread,
  onDeleteThread,
}: {
  workspaces: WorkspaceThreads[]
  onOpenThread: (thread: ThreadMeta) => void
  /** Delete a Thread (TB6) — removes its metadata + JSONL, then refreshes the list. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  return (
    <div className="recents">
      <div className="recents__title">Recent workspaces</div>
      <ul className="recents__list">
        {workspaces.map((w) => (
          <li key={w.id} className="recents__workspace">
            <div className="recents__ws-name" title={w.dir}>
              {w.displayName}
            </div>
            {w.threads.length > 0 ? (
              <ul className="recents__threads">
                {w.threads.map((t) => (
                  <RecentThread
                    key={t.id}
                    thread={t}
                    onOpen={onOpenThread}
                    onDelete={onDeleteThread}
                  />
                ))}
              </ul>
            ) : (
              <div className="recents__empty">No threads yet</div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One Thread row in the cold list: opens read-only on click (TB3), with a delete
 * control (TB6). Delete is two-step — a first click arms an INLINE confirm (Delete
 * / Cancel) rather than a native `confirm()` (which would block the renderer), so
 * a single misclick can't nuke a Thread's history.
 */
function RecentThread({
  thread,
  onOpen,
  onDelete,
}: {
  thread: ThreadMeta
  onOpen: (thread: ThreadMeta) => void
  onDelete: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <li className="recents__thread">
      <button className="recents__thread-btn" onClick={() => onOpen(thread)}>
        {threadLabel(thread)}
      </button>
      {confirming ? (
        <span className="recents__thread-confirm">
          <button
            className="btn btn--ghost btn--danger"
            onClick={() => {
              setConfirming(false)
              void onDelete(thread)
            }}
          >
            Delete
          </button>
          <button className="btn btn--ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="recents__thread-delete"
          aria-label="Delete thread"
          title="Delete thread"
          onClick={() => setConfirming(true)}
        >
          ✕
        </button>
      )}
    </li>
  )
}

/** A Thread's list label — its title, or a placeholder until one arrives (TB2). */
function threadLabel(thread: ThreadMeta): string {
  return thread.title ?? 'Untitled thread'
}

/** The persisted Threads under a connected Workspace (by minted id), for its list (TB5). */
function threadsForWorkspace(recents: ListMetadataResult, workspaceId: string): ThreadMeta[] {
  return recents.find((w) => w.id === workspaceId)?.threads ?? []
}

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
