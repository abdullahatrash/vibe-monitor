import { useEffect, useReducer, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { AuthMethod } from '../../../shared/ipc'
import {
  conversationReducer,
  initialConversationState,
  type AssistantItem,
  type ConversationItem,
  type ErrorItem,
  type FallbackItem,
  type NoticeItem,
  type PermissionItem,
  type PermissionOption,
  type ReasoningItem,
  type ToolItem,
  type UserItem,
} from './reducer'
import { eventBelongsToThread } from './event-routing'
import { replayTranscript } from './replay'
import { ChatMarkdown } from './ChatMarkdown'

/** Process-local counter for unique echoed-prompt ids. */
let promptSeq = 0

/**
 * The live handle for one Thread hosted on a Workspace agent (TB5). `sessionId`
 * is the bound ACP session, or `null` for a draft whose `session/new` is deferred
 * to its first prompt. Several of these can share one `agentId` (one `vibe-acp`
 * hosting many sessions); switching mounts the selected one (keyed by `threadId`).
 */
export interface LiveThread {
  agentId: string
  threadId: string
  workspaceId: string
  sessionId: string | null
  title: string | null
}

/**
 * A live Thread: hydrates its saved history from JSONL on mount (TB5), then
 * subscribes to the agent's `acp:event` stream — routing only THIS Thread's
 * session into the reducer (reducer.ts) — and lets the user send prompts. A
 * draft's first prompt binds its session in main (`session/new`), which signals
 * `thread:bound` BEFORE the session streams; the bound `sessionId` is reused
 * thereafter so the session is never re-minted, and the draft NEVER infers its
 * session from an arbitrary event (which could be a sibling's).
 *
 * This view no longer reports its status up: the sidebar's per-Thread streaming /
 * needs-attention indicators are sourced from main's `thread:status` push (#53),
 * which covers ALL live Threads (active or not) — main owns the authoritative turn
 * + permission lifecycle, so it doesn't need a mounted Conversation to observe one.
 */
export function Conversation({
  thread,
  onAuthExpired,
  onBound,
}: {
  thread: LiveThread
  /** Mid-session expiry (-32000): route to in-place re-auth with these methods. */
  onAuthExpired: (authMethods: AuthMethod[]) => void
  /** The Thread's session once bound (TB5) — lifts it so a switch-away-and-back
   *  re-seeds the bound session instead of re-minting it. */
  onBound?: (sessionId: string) => void
}): JSX.Element {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState)
  const [draft, setDraft] = useState('')
  // The session this Thread is bound to — null until a draft's first prompt binds
  // it (via main's `thread:bound`). Seeded from the record; mirrored into a ref so
  // the event subscription reads the LATEST value without re-subscribing (a stale
  // closure would drop the draft's own first events after binding).
  const [boundSessionId, setBoundSessionId] = useState<string | null>(thread.sessionId)
  const boundRef = useRef<string | null>(thread.sessionId)
  // Keep the lift callback in a ref so the bound subscription needn't depend on it.
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound
  const listRef = useRef<HTMLDivElement>(null)
  // True once any live event has been folded in: guards the async hydrate from
  // clobbering events that streamed in before the JSONL read resolved.
  const liveSeen = useRef(false)

  // Hydrate this Thread's saved history from JSONL once (TB5): switching INTO a
  // previously-used Thread shows its conversation before live events resume. A
  // draft (or a fresh Thread) has none, so this is a no-op there.
  //
  // Deferred (NIT): if the Thread's PRIOR turn was still in-flight when we last
  // left it, its JSONL may lag the live tail by a few un-flushed events; the
  // `liveSeen` guard keeps a late hydrate from clobbering resumed live events, but
  // the brief early-history gap on such a reopen is accepted for this slice.
  useEffect(() => {
    let active = true
    void window.api.readTranscript(thread.threadId).then((entries) => {
      if (!active || liveSeen.current) return
      const replayed = replayTranscript(entries)
      if (replayed.items.length > 0) dispatch({ type: 'hydrate', state: replayed })
    })
    return () => {
      active = false
    }
  }, [thread.threadId])

  // Bind a draft to its OWN session the instant main signals `thread:bound` —
  // BEFORE that session's first event arrives (main emits it ahead of the prompt
  // stream). We never adopt a session from an incoming event, so a sibling's
  // still-streaming turn can't be spliced into this draft. Also lifts the session
  // so a switch-away-and-back re-seeds it instead of re-minting.
  useEffect(() => {
    return window.api.onThreadBound((e) => {
      if (e.threadId !== thread.threadId) return
      boundRef.current = e.sessionId
      setBoundSessionId(e.sessionId)
      onBoundRef.current?.(e.sessionId)
      // A re-bind (TB4 #33): the agent couldn't resume this reopened Thread, so
      // main minted a fresh session. Weave the honest "context reset" notice in
      // NOW — main emits `thread:bound` before the prompt streams, so it lands
      // after the user's prompt and before the agent's response (matching replay).
      if (e.rebound) dispatch({ type: 'agent-rebound' })
    })
  }, [thread.threadId])

  // Subscribe to this agent's events; route ONLY this Thread's session to the
  // reducer (one agent hosts many sessions, TB5). Reads `boundRef` live so an
  // UNBOUND draft rejects every session-tagged event (no sibling adoption), and a
  // bound Thread takes only its own — without re-subscribing on each binding.
  useEffect(() => {
    return window.api.onAcpEvent((event) => {
      if (event.agentId !== thread.agentId) return
      if (!eventBelongsToThread(event.payload, boundRef.current)) return
      liveSeen.current = true
      dispatch({ type: 'acp-event', payload: event.payload })
    })
  }, [thread.agentId])

  // Keep the latest item in view as the answer streams in.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [state.items])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || state.isProcessing) return
    setDraft('')
    dispatch({ type: 'send-prompt', id: `user:${promptSeq++}`, text })
    try {
      const result = await window.api.sendPrompt({
        agentId: thread.agentId,
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        sessionId: boundSessionId,
        text,
      })
      if (result.ok) {
        // Reuse the now-bound session on the next prompt (no second session/new),
        // and lift it so a switch-away-and-back doesn't re-mint. `thread:bound`
        // already set this for a fresh draft; this also covers the no-store path.
        boundRef.current = result.sessionId
        setBoundSessionId(result.sessionId)
        onBound?.(result.sessionId)
      } else if (result.kind === 'not-signed-in') {
        // Mid-session expiry: route to in-place re-auth (the agent stays alive).
        onAuthExpired(result.authMethods)
      } else {
        // Surface a failed turn as a conversation item rather than dropping it.
        dispatch({ type: 'turn-error', message: result.error })
      }
    } finally {
      // The turn's stopReason resolves sendPrompt; flip back to the user's turn.
      dispatch({ type: 'turn-complete' })
    }
  }

  // Answer a pending permission request: relay the choice to the agent and mark
  // the prompt resolved so it stops asking (state stays renderer-owned).
  function respondPermission(item: PermissionItem, option: PermissionOption): void {
    void window.api.respondPermission({
      agentId: thread.agentId,
      threadId: thread.threadId,
      requestId: item.requestId,
      optionId: option.optionId,
    })
    dispatch({
      type: 'resolve-permission',
      requestId: item.requestId,
      optionId: option.optionId,
      name: option.name,
    })
  }

  // Escape hatch for a wedged turn: deny any still-pending permission (so the
  // agent stops blocking and `session/prompt` can resolve) before re-enabling
  // input. Reducer is pure, so the IPC reply happens here, not in `recover`.
  function recover(): void {
    for (const item of state.items) {
      if (item.kind !== 'permission' || item.chosenOptionId !== null) continue
      const deny =
        item.options.find((o) => o.kind.startsWith('reject')) ?? item.options[item.options.length - 1]
      if (!deny) continue
      void window.api.respondPermission({
        agentId: thread.agentId,
        threadId: thread.threadId,
        requestId: item.requestId,
        optionId: deny.optionId,
      })
      dispatch({
        type: 'resolve-permission',
        requestId: item.requestId,
        optionId: deny.optionId,
        name: deny.name,
      })
    }
    dispatch({ type: 'recover' })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const title = state.title ?? thread.title ?? 'Untitled Thread'

  return (
    <div className="conv">
      <div className="conv__head">
        <span className="dot dot--ok" aria-hidden />
        <span className="conv__title">{title}</span>
        <span className="badge">{state.isProcessing ? 'thinking…' : 'connected'}</span>
      </div>

      <UsageBar state={state} />

      <div className="messages" ref={listRef}>
        {state.items.length === 0 && (
          <p className="hint">Send a prompt to start the conversation.</p>
        )}
        {state.items.map((item) => (
          <Item key={item.id} item={item} onPermission={respondPermission} />
        ))}
      </div>

      {state.isProcessing && (
        // Escape hatch: if a turn wedges (e.g. a permission prompt is dismissed
        // and `session/prompt` never resolves), deny any pending permission and
        // re-enable input instead of sticking disabled forever (carry-over #4).
        <button className="recover" onClick={recover}>
          Turn stuck? End it and re-enable input ▶
        </button>
      )}

      <div className="composer">
        <textarea
          className="composer__input"
          placeholder="Ask Vibe… (Enter to send, Shift+Enter for a newline)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
        />
        <button
          className="btn"
          onClick={() => void send()}
          disabled={state.isProcessing || draft.trim().length === 0}
        >
          {state.isProcessing ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

export function UsageBar({ state }: { state: { usage: { used: number; size: number } | null; cost: { amount: number; currency: string } | null } }): JSX.Element | null {
  if (!state.usage && !state.cost) return null
  return (
    <div className="usage">
      {state.usage && (
        <span className="usage__item">
          context <strong>{state.usage.used.toLocaleString()}</strong> /{' '}
          {state.usage.size.toLocaleString()} tokens
        </span>
      )}
      {state.cost && (
        <span className="usage__item">
          cost <strong>{formatCost(state.cost.amount, state.cost.currency)}</strong>
        </span>
      )}
    </div>
  )
}

export function Item({
  item,
  onPermission,
}: {
  item: ConversationItem
  onPermission: (item: PermissionItem, option: PermissionOption) => void
}): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'reasoning':
      return <ReasoningRow item={item} />
    case 'assistant':
      return <AssistantRow item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'permission':
      return <PermissionRow item={item} onPermission={onPermission} />
    case 'error':
      return <ErrorRow item={item} />
    case 'fallback':
      return <FallbackRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
  }
}

function UserRow({ item }: { item: UserItem }): JSX.Element {
  return (
    <div className="msg msg--user">
      <div className="msg__role">You</div>
      <div className="msg__body">{item.text}</div>
    </div>
  )
}

function AssistantRow({ item }: { item: AssistantItem }): JSX.Element {
  return (
    <div className="msg msg--assistant">
      <div className="msg__role">Vibe</div>
      <ChatMarkdown className="msg__body" text={item.text} />
    </div>
  )
}

function ReasoningRow({ item }: { item: ReasoningItem }): JSX.Element {
  return (
    <details className="reasoning" open>
      <summary className="reasoning__summary">Reasoning</summary>
      <ChatMarkdown className="reasoning__body" text={item.text} />
    </details>
  )
}

function ToolRow({ item }: { item: ToolItem }): JSX.Element {
  const done = item.status === 'completed'
  const label = item.title ?? item.toolKind ?? 'tool'
  const path = item.locations.find((l) => l.path)?.path
  return (
    <div className="tool">
      <div className="tool__head">
        <span className={done ? 'dot dot--ok' : 'dot dot--pending'} aria-hidden />
        <span className="tool__name">{label}</span>
        <span className="tool__status">{item.status}</span>
      </div>
      {path && <div className="tool__path mono">{path}</div>}
    </div>
  )
}

function PermissionRow({
  item,
  onPermission,
}: {
  item: PermissionItem
  onPermission: (item: PermissionItem, option: PermissionOption) => void
}): JSX.Element {
  return (
    <div className="permission">
      <div className="permission__title">
        Permission request{item.toolCallId ? ` · ${item.toolCallId}` : ''}
      </div>
      {item.chosenName ? (
        <div className="permission__chosen">You chose: {item.chosenName}</div>
      ) : (
        <div className="permission__options">
          {item.options.map((option) => (
            <button
              key={option.optionId}
              className={option.kind.startsWith('reject') ? 'btn btn--ghost' : 'btn'}
              onClick={() => onPermission(item, option)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ErrorRow({ item }: { item: ErrorItem }): JSX.Element {
  return (
    <div className="alert">
      <div className="alert__title">Turn ended</div>
      <div className="alert__message">{item.message}</div>
    </div>
  )
}

function NoticeRow({ item }: { item: NoticeItem }): JSX.Element {
  return (
    <div className="notice">
      <span className="notice__icon" aria-hidden>
        ↻
      </span>
      <span className="notice__message">{item.message}</span>
    </div>
  )
}

function FallbackRow({ item }: { item: FallbackItem }): JSX.Element {
  return (
    <details className="fallback">
      <summary className="fallback__summary">{item.sessionUpdate}</summary>
      <pre className="fallback__body mono">{JSON.stringify(item.raw, null, 2)}</pre>
    </details>
  )
}

function formatCost(amount: number, currency: string): string {
  const symbol = currency.toUpperCase() === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(4)}`
}
