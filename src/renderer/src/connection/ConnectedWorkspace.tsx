import { type JSX } from 'react'
import type { AuthMethod, ThreadConfigAxis, ThreadConnection, ThreadMeta } from '../../../shared/ipc'
import { ColdThread } from '../conversation/ColdThread'
import { Conversation } from '../conversation/Conversation'

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
 */
export function ConnectedWorkspace({
  connection,
  activeThread,
  isLive,
  seedSessionId,
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
  /** The session to seed a live view with (bound-this-session wins over the cursor). */
  seedSessionId: string | null
  /** Change an agent control on the active Thread's bound session (#66, ADR-0007). */
  onSetConfig: (axis: ThreadConfigAxis, value: string, sessionId: string) => void
  /** A draft's first prompt bound its session — lift it to App's live-state. */
  onBound: (sessionId: string) => void
  /** Promote the (cold) active Thread to live (Continue) — App hosts + reselects it. */
  onContinue: () => void
  /** Back out of a cold view to the connection's primary live Thread. */
  onCloseCold: () => void
  /** Mid-session expiry (-32000): route to in-place re-auth with these methods. */
  onAuthExpired: (authMethods: AuthMethod[]) => void
}): JSX.Element {
  return (
    <div className="workspace">
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
          modes={connection.modes}
          models={connection.models}
          reasoningEffort={connection.reasoningEffort}
          onSetConfig={onSetConfig}
          onAuthExpired={onAuthExpired}
          onBound={onBound}
        />
      ) : (
        <ColdThread key={activeThread.id} thread={activeThread} onClose={onCloseCold} onContinue={onContinue} />
      )}
    </div>
  )
}
