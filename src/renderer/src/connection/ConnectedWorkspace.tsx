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
  // The connection carries exactly ONE Thread's Agent-controls values — the
  // connect-time `session/new` Thread (`connection.threadId`). Show the picker ONLY
  // when the active Thread IS that primary one, so a sibling live Thread (New-thread
  // / Continue) never displays the primary's Mode/Model as if they were its own (a
  // trust-relevant lie, since Mode gates write-approval). Per-Thread sourcing +
  // post-`session/load` population (so every live Thread gets its own correct
  // controls) is the tracked follow-up; until then a non-primary Thread shows none.
  const showControls = activeThread.id === connection.threadId
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
          modes={showControls ? connection.modes : null}
          models={showControls ? connection.models : null}
          reasoningEffort={showControls ? connection.reasoningEffort : null}
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
