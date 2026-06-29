/**
 * Conversation reducer — the heart of TB2. A PURE function (no React, no IPC)
 * that folds the streamed ACP `acp:event` payloads for one Thread into an
 * ordered list of conversation items, plus the Thread title and live
 * usage/cost. Per ADR-0001 the renderer owns this interpretation; main forwards
 * `session/update` raw.
 *
 * Mapping (discriminated on `update.sessionUpdate`, from docs/acp-capture.md §4):
 *   agent_thought_chunk      -> reasoning item,  append content.text, keyed by messageId
 *   agent_message_chunk      -> assistant item,  append content.text, keyed by messageId
 *   session_info_update      -> set title
 *   usage_update             -> set context usage {used,size} + cost {amount,currency}
 *   available_commands_update-> store commands (not rendered this slice)
 *   (any other sessionUpdate) -> generic fallback item, never dropped
 *
 * The user's own prompt is echoed via `send-prompt`; `turn-complete` clears the
 * optimistic processing flag (driven by the `session/prompt` response).
 */

export interface UserItem {
  kind: 'user'
  id: string
  text: string
}

export interface ReasoningItem {
  kind: 'reasoning'
  id: string
  /** ACP `messageId` the deltas accumulate under. */
  messageId: string
  text: string
}

export interface AssistantItem {
  kind: 'assistant'
  id: string
  messageId: string
  text: string
}

/** Any `session/update` kind without a dedicated renderer — nothing is invisible. */
export interface FallbackItem {
  kind: 'fallback'
  id: string
  sessionUpdate: string
  raw: unknown
}

export type ConversationItem = UserItem | ReasoningItem | AssistantItem | FallbackItem

export interface ContextUsage {
  used: number
  size: number
}

export interface Cost {
  amount: number
  currency: string
}

export interface AcpCommand {
  name: string
  description?: string
}

export interface ConversationState {
  /** Ordered conversation items in arrival order. */
  items: ConversationItem[]
  title: string | null
  usage: ContextUsage | null
  cost: Cost | null
  /** Slash commands / skills (stored, not rendered this slice). */
  availableCommands: AcpCommand[]
  /** True between sending a prompt and the turn completing. */
  isProcessing: boolean
  /** Monotonic counter for stable generic-fallback item ids. */
  fallbackSeq: number
}

export const initialConversationState: ConversationState = {
  items: [],
  title: null,
  usage: null,
  cost: null,
  availableCommands: [],
  isProcessing: false,
  fallbackSeq: 0,
}

export type ConversationAction =
  | { type: 'send-prompt'; id: string; text: string }
  | { type: 'acp-event'; payload: unknown }
  | { type: 'turn-complete' }

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case 'send-prompt':
      return {
        ...state,
        isProcessing: true,
        items: [...state.items, { kind: 'user', id: action.id, text: action.text }],
      }
    case 'turn-complete':
      return { ...state, isProcessing: false }
    case 'acp-event':
      return reduceAcpEvent(state, action.payload)
  }
}

// --- ACP event handling ----------------------------------------------------

interface SessionUpdate {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  messageId?: string
  title?: string
  used?: number
  size?: number
  cost?: { amount?: number; currency?: string }
  availableCommands?: Array<{ name?: string; description?: string }>
}

function reduceAcpEvent(state: ConversationState, payload: unknown): ConversationState {
  const update = extractSessionUpdate(payload)
  if (!update) return state // lifecycle/server-request payloads aren't conversation items

  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
      return appendChunk(state, 'reasoning', update)
    case 'agent_message_chunk':
      return appendChunk(state, 'assistant', update)
    case 'session_info_update':
      return typeof update.title === 'string' ? { ...state, title: update.title } : state
    case 'usage_update':
      return applyUsage(state, update)
    case 'available_commands_update':
      return { ...state, availableCommands: extractCommands(update) }
    default:
      return appendFallback(state, update)
  }
}

/** Narrow a raw `acp:event` payload to a `session/update`'s `update` object. */
function extractSessionUpdate(payload: unknown): SessionUpdate | null {
  if (!payload || typeof payload !== 'object') return null
  const message = payload as { method?: unknown; params?: unknown }
  if (message.method !== 'session/update') return null
  const params = message.params as { update?: unknown } | undefined
  const update = params?.update
  if (!update || typeof update !== 'object') return null
  if (typeof (update as { sessionUpdate?: unknown }).sessionUpdate !== 'string') return null
  return update as SessionUpdate
}

function appendChunk(
  state: ConversationState,
  kind: 'reasoning' | 'assistant',
  update: SessionUpdate,
): ConversationState {
  const messageId = update.messageId ?? ''
  const text = update.content?.text ?? ''

  const index = state.items.findIndex(
    (item) => item.kind === kind && item.messageId === messageId,
  )
  if (index >= 0) {
    const existing = state.items[index] as ReasoningItem | AssistantItem
    const items = state.items.slice()
    items[index] = { ...existing, text: existing.text + text }
    return { ...state, items }
  }

  const item: ReasoningItem | AssistantItem = { kind, id: `${kind}:${messageId}`, messageId, text }
  return { ...state, items: [...state.items, item] }
}

function applyUsage(state: ConversationState, update: SessionUpdate): ConversationState {
  const usage =
    typeof update.used === 'number' && typeof update.size === 'number'
      ? { used: update.used, size: update.size }
      : state.usage
  const cost =
    update.cost && typeof update.cost.amount === 'number' && typeof update.cost.currency === 'string'
      ? { amount: update.cost.amount, currency: update.cost.currency }
      : state.cost
  return { ...state, usage, cost }
}

function appendFallback(state: ConversationState, update: SessionUpdate): ConversationState {
  const item: FallbackItem = {
    kind: 'fallback',
    id: `fallback:${state.fallbackSeq}`,
    sessionUpdate: update.sessionUpdate,
    raw: update,
  }
  return { ...state, items: [...state.items, item], fallbackSeq: state.fallbackSeq + 1 }
}

function extractCommands(update: SessionUpdate): AcpCommand[] {
  const list = update.availableCommands
  if (!Array.isArray(list)) return []
  return list
    .filter((c): c is { name: string; description?: string } => typeof c?.name === 'string')
    .map((c) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : undefined }))
}
