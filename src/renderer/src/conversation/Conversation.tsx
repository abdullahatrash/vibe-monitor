import { useEffect, useReducer, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type { ThreadConnection } from '../../../shared/ipc'
import {
  conversationReducer,
  initialConversationState,
  type AssistantItem,
  type ConversationItem,
  type ErrorItem,
  type FallbackItem,
  type PermissionItem,
  type PermissionOption,
  type ReasoningItem,
  type ToolItem,
  type UserItem,
} from './reducer'

/** Process-local counter for unique echoed-prompt ids. */
let promptSeq = 0

/**
 * A connected Thread: subscribes to the agent's `acp:event` stream, reduces it
 * into conversation items (reducer.ts), and lets the user send prompts. Reads
 * are served transparently in main, so a read-only turn streams reasoning + an
 * answer and completes without any approval UI (that's TB3).
 */
export function Conversation({ thread }: { thread: ThreadConnection }): JSX.Element {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Subscribe once per agent; ignore events from other agents sharing the channel.
  useEffect(() => {
    return window.api.onAcpEvent((event) => {
      if (event.agentId !== thread.agentId) return
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
        sessionId: thread.sessionId,
        text,
      })
      // Surface a failed turn as a conversation item rather than dropping it.
      if (!result.ok) dispatch({ type: 'turn-error', message: result.error })
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

function UsageBar({ state }: { state: { usage: { used: number; size: number } | null; cost: { amount: number; currency: string } | null } }): JSX.Element | null {
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

function Item({
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
      <div className="msg__body">{item.text}</div>
    </div>
  )
}

function ReasoningRow({ item }: { item: ReasoningItem }): JSX.Element {
  return (
    <details className="reasoning" open>
      <summary className="reasoning__summary">Reasoning</summary>
      <div className="reasoning__body">{item.text}</div>
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
