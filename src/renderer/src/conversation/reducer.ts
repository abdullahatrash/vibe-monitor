/**
 * Conversation reducer — a PURE function (no React, no IPC) that folds the
 * streamed ACP `acp:event` payloads for one Thread into an ordered list of
 * conversation items, plus the Thread title and live usage/cost. Per ADR-0001
 * the renderer owns this interpretation; main forwards `session/update` (and the
 * raw `session/request_permission` server request) without interpreting them.
 *
 * Mapping (discriminated on `update.sessionUpdate`, from docs/acp-capture.md §4):
 *   agent_thought_chunk      -> reasoning item,  append content.text, keyed by messageId
 *   agent_message_chunk      -> assistant item,  append content.text, keyed by messageId
 *   tool_call                -> tool item, create/merge keyed by toolCallId (TB3)
 *   tool_call_update         -> tool item, merge keyed by toolCallId (status -> completed, rawOutput)
 *   session_info_update      -> set title
 *   usage_update             -> set context usage {used,size} + cost {amount,currency}
 *   available_commands_update-> store commands (not rendered this slice)
 *   (any other sessionUpdate) -> generic fallback item, never dropped
 *
 * Beyond `session/update`, the reducer also folds two non-notification payloads
 * (TB3): the agent's `session/request_permission` server request -> a permission
 * item the user answers; and child lifecycle errors (`{type:'exit'|'error'}`) ->
 * an error item that re-enables the composer so a wedged turn can't disable it
 * forever (carry-over from #4).
 *
 * The user's own prompt is echoed via `send-prompt`; `turn-complete` clears the
 * optimistic processing flag (driven by the `session/prompt` response).
 */

/** An image echoed in a sent user turn (#100). `previewUrl` is the full data URL. */
export interface UserImage {
  previewUrl: string
}

export interface UserItem {
  kind: 'user'
  id: string
  text: string
  /** Image attachments echoed with this turn (#100); absent on replay from JSONL. */
  images?: UserImage[]
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

/** A file path the tool touched (`locations` entry). */
export interface ToolLocation {
  path?: string
}

/**
 * A tool the agent ran, keyed by its `toolCallId` (docs/acp-capture.md §4, §7).
 * Created by `tool_call`, merged by `tool_call_update`; `status` transitions
 * `pending` -> `completed`.
 */
export interface ToolItem {
  kind: 'tool'
  id: string
  toolCallId: string
  /** The ACP tool `kind` (`read`, `edit`, …) — not our item discriminator. */
  toolKind: string | null
  status: string
  title: string | null
  locations: ToolLocation[]
  rawInput: unknown
  rawOutput: unknown
  content: unknown[]
}

/** One option offered by `session/request_permission`. */
export interface PermissionOption {
  kind: string
  name: string
  optionId: string
}

/**
 * An agent permission request (`session/request_permission`, §6). Linked to its
 * pending tool via `toolCallId`. Answered by replying with the chosen
 * `optionId` to the agent's JSON-RPC `requestId`; once answered we record the
 * choice so the prompt renders resolved instead of re-prompting.
 */
export interface PermissionItem {
  kind: 'permission'
  id: string
  /** JSON-RPC id of the agent's request — the handle we answer by. */
  requestId: number | string
  toolCallId: string | null
  options: PermissionOption[]
  /** The option the user picked, or null while still pending. */
  chosenOptionId: string | null
  chosenName: string | null
}

/** A surfaced turn/agent failure — keeps a wedged turn from hiding the cause. */
export interface ErrorItem {
  kind: 'error'
  id: string
  message: string
}

/** Any `session/update` kind without a dedicated renderer — nothing is invisible. */
export interface FallbackItem {
  kind: 'fallback'
  id: string
  sessionUpdate: string
  raw: unknown
}

/**
 * A system notice woven into the conversation (TB4 #33) — currently the honest
 * "agent context was reset" line shown after a `session/load` resume failed and
 * main re-bound a fresh session. Not a turn error; the composer stays usable.
 */
export interface NoticeItem {
  kind: 'notice'
  id: string
  message: string
}

export type ConversationItem =
  | UserItem
  | ReasoningItem
  | AssistantItem
  | ToolItem
  | PermissionItem
  | ErrorItem
  | FallbackItem
  | NoticeItem

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
  /** Monotonic counter for stable error item ids. */
  errorSeq: number
  /** Monotonic counter for stable notice item ids (TB4 #33). */
  noticeSeq: number
}

/**
 * The user-facing "agent context reset" copy (TB4 #33). Honest per ADR-0005: the
 * visible history above is OURS (read from JSONL) and stays; only the agent's own
 * memory restarted, so it won't recall the earlier turns.
 */
export const REBOUND_NOTICE =
  "Agent context was reset — the agent couldn't resume this thread, so it starts fresh and won't recall earlier turns. Your conversation history above is preserved."

export const initialConversationState: ConversationState = {
  items: [],
  title: null,
  usage: null,
  cost: null,
  availableCommands: [],
  isProcessing: false,
  fallbackSeq: 0,
  errorSeq: 0,
  noticeSeq: 0,
}

export type ConversationAction =
  | { type: 'send-prompt'; id: string; text: string; images?: UserImage[] }
  | { type: 'acp-event'; payload: unknown }
  | { type: 'turn-complete' }
  | { type: 'turn-error'; message: string }
  | { type: 'recover' }
  | { type: 'resolve-permission'; requestId: number | string; optionId: string; name: string }
  // The agent's context was reset after a failed `session/load` resume (TB4 #33):
  // append the honest "context reset" notice. Not a turn error — input stays usable.
  | { type: 'agent-rebound' }
  // Seed a live Thread from its replayed JSONL history (TB5 #34): replace the
  // whole state, so switching INTO a Thread shows its saved conversation before
  // live events resume. The provided state is already folded (via replayTranscript).
  | { type: 'hydrate'; state: ConversationState }

export function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  switch (action.type) {
    case 'hydrate':
      return action.state
    case 'send-prompt':
      return {
        ...state,
        isProcessing: true,
        items: [
          ...state.items,
          { kind: 'user', id: action.id, text: action.text, images: action.images },
        ],
      }
    case 'turn-complete':
      return { ...state, isProcessing: false }
    case 'turn-error':
      return { ...appendError(state, action.message), isProcessing: false }
    case 'recover':
      // Manual escape hatch for a wedged turn (e.g. a dismissed permission that
      // never resolved `session/prompt`): re-enable input, note why.
      return { ...appendError(state, 'Turn ended manually — input re-enabled.'), isProcessing: false }
    case 'resolve-permission':
      return resolvePermission(state, action.requestId, action.optionId, action.name)
    case 'agent-rebound':
      return appendNotice(state, REBOUND_NOTICE)
    case 'acp-event':
      return reduceAcpEvent(state, action.payload)
  }
}

// --- ACP event handling ----------------------------------------------------

interface SessionUpdate {
  sessionUpdate: string
  /** `{type,text}` for chunks; an array for tool calls — narrowed per branch. */
  content?: unknown
  messageId?: string
  title?: string
  used?: number
  size?: number
  cost?: { amount?: number; currency?: string }
  availableCommands?: Array<{ name?: string; description?: string }>
  toolCallId?: string
  kind?: string
  status?: string
  locations?: ToolLocation[]
  rawInput?: unknown
  rawOutput?: unknown
}

function reduceAcpEvent(state: ConversationState, payload: unknown): ConversationState {
  const permission = extractPermissionRequest(payload)
  if (permission) return appendPermission(state, permission)

  const failure = extractLifecycleFailure(payload)
  if (failure) return handleLifecycleFailure(state, failure)

  const update = extractSessionUpdate(payload)
  if (!update) return state // other lifecycle/server-request payloads aren't conversation items

  switch (update.sessionUpdate) {
    case 'agent_thought_chunk':
      return appendChunk(state, 'reasoning', update)
    case 'agent_message_chunk':
      return appendChunk(state, 'assistant', update)
    case 'tool_call':
    case 'tool_call_update':
      return applyToolCall(state, update)
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

interface PermissionRequest {
  requestId: number | string
  toolCallId: string | null
  options: PermissionOption[]
}

/**
 * Narrow a `session/request_permission` server request (§6). Main forwards it
 * raw; the `method` field is the tag and `id` is the handle we answer by.
 */
function extractPermissionRequest(payload: unknown): PermissionRequest | null {
  if (!payload || typeof payload !== 'object') return null
  const message = payload as { id?: unknown; method?: unknown; params?: unknown }
  if (message.method !== 'session/request_permission') return null
  if (typeof message.id !== 'number' && typeof message.id !== 'string') return null

  const params = (message.params ?? {}) as {
    toolCall?: { toolCallId?: unknown }
    options?: unknown
  }
  const toolCallId =
    typeof params.toolCall?.toolCallId === 'string' ? params.toolCall.toolCallId : null
  const options = Array.isArray(params.options)
    ? params.options
        .filter(
          (o): o is PermissionOption =>
            !!o && typeof o.optionId === 'string' && typeof o.name === 'string',
        )
        .map((o) => ({ kind: String(o.kind ?? ''), name: o.name, optionId: o.optionId }))
    : []

  return { requestId: message.id, toolCallId, options }
}

interface LifecycleFailure {
  message: string
}

/** Narrow a serialized child lifecycle failure (`{type:'exit'|'error'}`). */
function extractLifecycleFailure(payload: unknown): LifecycleFailure | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { type?: unknown; message?: unknown; info?: { code?: unknown; signal?: unknown } }
  if (p.type === 'error') {
    return { message: typeof p.message === 'string' ? p.message : 'Agent error.' }
  }
  if (p.type === 'exit') {
    return { message: `vibe-acp exited (code=${p.info?.code ?? '?'}, signal=${p.info?.signal ?? '?'}).` }
  }
  return null
}

/**
 * An agent crash/exit mid-turn must not leave the composer stuck. Surface the
 * cause and clear `isProcessing` — but only while a turn is in flight, so a
 * normal shutdown after the user is done doesn't spew phantom errors.
 */
function handleLifecycleFailure(state: ConversationState, failure: LifecycleFailure): ConversationState {
  if (!state.isProcessing) return state
  return { ...appendError(state, failure.message), isProcessing: false }
}

function appendChunk(
  state: ConversationState,
  kind: 'reasoning' | 'assistant',
  update: SessionUpdate,
): ConversationState {
  const messageId = update.messageId ?? ''
  const text = (update.content as { text?: string } | undefined)?.text ?? ''

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

/**
 * Fold `tool_call` / `tool_call_update` into a tool item keyed by `toolCallId`.
 * Both kinds merge the same way: each field overwrites only when the update
 * actually carries it, so a `tool_call_update` that ships just `status` +
 * `rawOutput` keeps the diff/title/input from the original `tool_call`.
 */
function applyToolCall(state: ConversationState, update: SessionUpdate): ConversationState {
  const toolCallId = update.toolCallId
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return appendFallback(state, update) // malformed: never drop it
  }

  const index = state.items.findIndex(
    (item): item is ToolItem => item.kind === 'tool' && item.toolCallId === toolCallId,
  )
  const existing = index >= 0 ? (state.items[index] as ToolItem) : null

  const merged: ToolItem = {
    kind: 'tool',
    id: `tool:${toolCallId}`,
    toolCallId,
    toolKind: typeof update.kind === 'string' ? update.kind : (existing?.toolKind ?? null),
    status: typeof update.status === 'string' ? update.status : (existing?.status ?? 'pending'),
    title: typeof update.title === 'string' ? update.title : (existing?.title ?? null),
    locations: Array.isArray(update.locations) ? update.locations : (existing?.locations ?? []),
    rawInput: update.rawInput !== undefined ? update.rawInput : existing?.rawInput,
    rawOutput: update.rawOutput !== undefined ? update.rawOutput : existing?.rawOutput,
    content: Array.isArray(update.content) ? update.content : (existing?.content ?? []),
  }

  if (existing) {
    const items = state.items.slice()
    items[index] = merged
    return { ...state, items }
  }
  return { ...state, items: [...state.items, merged] }
}

function appendPermission(state: ConversationState, request: PermissionRequest): ConversationState {
  const item: PermissionItem = {
    kind: 'permission',
    id: `permission:${request.requestId}`,
    requestId: request.requestId,
    toolCallId: request.toolCallId,
    options: request.options,
    chosenOptionId: null,
    chosenName: null,
  }
  return { ...state, items: [...state.items, item] }
}

function resolvePermission(
  state: ConversationState,
  requestId: number | string,
  optionId: string,
  name: string,
): ConversationState {
  const index = state.items.findIndex(
    (item): item is PermissionItem => item.kind === 'permission' && item.requestId === requestId,
  )
  if (index < 0) return state
  const items = state.items.slice()
  items[index] = { ...(items[index] as PermissionItem), chosenOptionId: optionId, chosenName: name }
  return { ...state, items }
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

function appendError(state: ConversationState, message: string): ConversationState {
  const item: ErrorItem = { kind: 'error', id: `error:${state.errorSeq}`, message }
  return { ...state, items: [...state.items, item], errorSeq: state.errorSeq + 1 }
}

function appendNotice(state: ConversationState, message: string): ConversationState {
  const item: NoticeItem = { kind: 'notice', id: `notice:${state.noticeSeq}`, message }
  return { ...state, items: [...state.items, item], noticeSeq: state.noticeSeq + 1 }
}

function extractCommands(update: SessionUpdate): AcpCommand[] {
  const list = update.availableCommands
  if (!Array.isArray(list)) return []
  return list
    .filter((c): c is { name: string; description?: string } => typeof c?.name === 'string')
    .map((c) => ({ name: c.name, description: typeof c.description === 'string' ? c.description : undefined }))
}
