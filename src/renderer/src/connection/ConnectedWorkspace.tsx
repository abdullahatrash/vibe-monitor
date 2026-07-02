import { type JSX } from 'react'
import type {
  AuthMethod,
  ThreadAgentControls,
  ThreadConfigAxis,
  ThreadConnection,
  ThreadMeta,
} from '../../../shared/ipc'
import { ColdThread } from '../conversation/ColdThread'
import { Conversation } from '../conversation/Conversation'
import { SurfacePanel } from '../side-panel/SurfacePanel'

/**
 * A connected Workspace's conversation OUTLET (ADR-0006, TB3 #48). It no longer
 * owns a Thread switcher or any selection/live-state — those are lifted to App (the
 * unified sidebar drives selection; `workspace-threads` holds the per-Workspace
 * live set + bound sessions + active Thread). This is now a thin CONTROLLED view:
 * given the connection and the App-chosen `active` Thread, it renders that Thread
 * live (`Conversation`, binding its draft session on the first prompt) or, when the
 * Thread isn't hosted on this session's agent, read-only from JSONL (`ColdThread`)
 * with a Continue affordance that promotes it live.
 *
 * It stays MOUNTED (hidden) for a background Workspace so its turn keeps streaming.
 * The sidebar's per-Thread streaming / needs-attention indicators no longer depend
 * on this view reporting up: main pushes per-Thread status for ALL live Threads
 * (#53), so a background Workspace's blocked permission surfaces without it.
 *
 * Agent controls (#70): the active Thread's OWN Mode/Model/Reasoning-effort come in
 * as `controls`, sourced PER Thread from `workspace-threads` (seeded on connect/bind,
 * keyed by `threadId`). This removes the #66 primary-Thread gate — EVERY live Thread
 * (the auto-opened one, a New-thread draft #58, a continued Thread #33) now shows and
 * changes its own controls, with no risk of a sibling displaying the primary's values.
 */
export function ConnectedWorkspace({
  connection,
  activeThread,
  isLive,
  isActive,
  busy,
  seedSessionId,
  controls,
  onSetConfig,
  onBound,
  onContinue,
  onCloseCold,
  onAuthExpired,
}: {
  connection: ThreadConnection
  /** The Thread App chose to show (its remembered active Thread for this Workspace). */
  activeThread: ThreadMeta
  /** Whether `activeThread` is hosted live on this session's agent (vs cold replay). */
  isLive: boolean
  /**
   * Whether this is the ON-SCREEN Workspace (#84). A background Workspace stays
   * mounted (hidden), so the Changes panel gates its git-status subscription on this
   * — not mere mount — to keep streaming active-Workspace-only (one watcher + fetch).
   */
  isActive: boolean
  /**
   * Whether this Workspace has a streaming turn (#86). Threaded to the Changes panel:
   * the agent can `git commit` itself mid-turn, so the v1 concurrency guard disables the
   * user's commit affordance while `busy` (no concurrent user+agent commit; status
   * re-reads at turn end). No locks/queues — just a disabled button + a hint.
   */
  busy: boolean
  /** The session to seed a live view with (bound-this-session wins over the cursor). */
  seedSessionId: string | null
  /** The active Thread's OWN agent-controls (#70), or null when none are seeded yet. */
  controls: ThreadAgentControls | null
  /** Change an agent control on the active Thread (#66/#70, ADR-0007): a bound session
   *  fires the IPC; a null session is a draft pre-pick App caches to apply on bind (#75). */
  onSetConfig: (axis: ThreadConfigAxis, value: string, sessionId: string | null) => void
  /** A draft's first prompt bound its session — lift it (and its controls) to App. */
  onBound: (sessionId: string, controls: ThreadAgentControls | null) => void
  /** Promote the (cold) active Thread to live (Continue) — App hosts + reselects it. */
  onContinue: () => void
  /** Back out of a cold view to the connection's primary live Thread. */
  onCloseCold: () => void
  /** Mid-session expiry (-32000): route to in-place re-auth with these methods. */
  onAuthExpired: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {isLive ? (
          <Conversation
            key={activeThread.id}
            thread={{
              agentId: connection.agentId,
              threadId: activeThread.id,
              workspaceId: connection.workspaceId,
              sessionId: seedSessionId,
              title: activeThread.title,
            }}
            modes={controls?.modes ?? null}
            models={controls?.models ?? null}
            reasoningEffort={controls?.reasoningEffort ?? null}
            onSetConfig={onSetConfig}
            onAuthExpired={onAuthExpired}
            onBound={onBound}
          />
        ) : (
          <ColdThread key={activeThread.id} thread={activeThread} onClose={onCloseCold} onContinue={onContinue} />
        )}
      </div>
      {/* The right-panel Surface stack (#187, ADR-0013): launcher cards collapsed, one
          Surface expanded at a time. Review re-homes the streamed git panel (#84,
          active-Workspace-only); Files is the slice-2 placeholder. */}
      <SurfacePanel
        workspaceId={connection.workspaceId}
        workspaceDir={connection.workspaceDir}
        isActive={isActive}
        busy={busy}
      />
    </div>
  )
}
