import { describe, it, expect } from 'vitest'
import {
  conversationReducer,
  initialConversationState,
  type AssistantItem,
  type ConversationState,
  type ErrorItem,
  type FallbackItem,
  type PermissionItem,
  type ReasoningItem,
  type ToolItem,
} from './reducer'

/**
 * Seam A: the pure reducer. We feed the captured read-turn `session/update`
 * sequence (verbatim shapes from docs/acp-capture.md §3–4) and assert the
 * ordered items, streamed reasoning + answer (accumulated by messageId), the
 * title, usage/cost, and the never-dropped generic fallback.
 */

const SESSION_ID = '8b7044cf-19d1-7a23-8da1-929c81b23170'

/** Wrap an `update` object in the `session/update` notification frame. */
function update(u: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update: u } }
}

function feed(state: ConversationState, payload: unknown): ConversationState {
  return conversationReducer(state, { type: 'acp-event', payload })
}

/** The verbatim read-turn stream: title, reasoning x2, answer x2, a read tool
 *  (a tool card since TB3), then usage. */
const READ_TURN: unknown[] = [
  update({ sessionUpdate: 'session_info_update', title: 'Read the README' }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Let me ' },
    messageId: 'r1',
  }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'check the file.' },
    messageId: 'r1',
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'EcjzekVw0',
    kind: 'read',
    status: 'pending',
    title: 'Read README.md',
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'The README ' },
    messageId: 'a1',
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'describes vibe-mistro.' },
    messageId: 'a1',
  }),
  update({
    sessionUpdate: 'usage_update',
    used: 21047,
    size: 128000,
    cost: { amount: 0.0123, currency: 'USD' },
  }),
]

describe('conversationReducer (Seam A)', () => {
  it('reduces the captured read-turn stream into ordered items, title, and usage/cost', () => {
    const state = READ_TURN.reduce<ConversationState>(feed, initialConversationState)

    // Title from session_info_update.
    expect(state.title).toBe('Read the README')

    // Usage + cost from usage_update.
    expect(state.usage).toEqual({ used: 21047, size: 128000 })
    expect(state.cost).toEqual({ amount: 0.0123, currency: 'USD' })

    // Ordered items: reasoning (1, accumulated), tool card, assistant (1, accumulated).
    expect(state.items.map((i) => i.kind)).toEqual(['reasoning', 'tool', 'assistant'])

    const reasoning = state.items[0] as ReasoningItem
    expect(reasoning.messageId).toBe('r1')
    expect(reasoning.text).toBe('Let me check the file.')

    const assistant = state.items[2] as AssistantItem
    expect(assistant.messageId).toBe('a1')
    expect(assistant.text).toBe('The README describes vibe-mistro.')
  })

  it('accumulates deltas by messageId and keeps reasoning separate from the answer', () => {
    const state = READ_TURN.reduce<ConversationState>(feed, initialConversationState)
    const reasoning = state.items.filter((i) => i.kind === 'reasoning')
    const assistant = state.items.filter((i) => i.kind === 'assistant')
    // Each messageId collapses to exactly one item, regardless of chunk count.
    expect(reasoning).toHaveLength(1)
    expect(assistant).toHaveLength(1)
  })

  it('keeps interleaved messageIds as distinct items in first-arrival order, each accumulated', () => {
    // thoughtA, thoughtB, thoughtA — proves findIndex-by-(kind+messageId) routes
    // deltas to the right item rather than the most recent one.
    const state = [
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A1 ' }, messageId: 'a' }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'B1 ' }, messageId: 'b' }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A2' }, messageId: 'a' }),
      // Two assistant messages in sequence → two assistant items.
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' }, messageId: 'm1' }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' }, messageId: 'm2' }),
    ].reduce<ConversationState>(feed, initialConversationState)

    const reasoning = state.items.filter((i): i is ReasoningItem => i.kind === 'reasoning')
    expect(reasoning.map((r) => r.messageId)).toEqual(['a', 'b']) // first-arrival order
    expect(reasoning[0].text).toBe('A1 A2') // accumulated despite the interleaved 'b'
    expect(reasoning[1].text).toBe('B1 ')

    const assistant = state.items.filter((i): i is AssistantItem => i.kind === 'assistant')
    expect(assistant.map((a) => a.messageId)).toEqual(['m1', 'm2'])
    expect(assistant.map((a) => a.text)).toEqual(['first', 'second'])
  })

  it('renders an unknown sessionUpdate as a generic fallback item (never dropped)', () => {
    const state = feed(
      initialConversationState,
      update({ sessionUpdate: 'some_future_kind', payloadField: 42 }),
    )
    expect(state.items).toHaveLength(1)
    const fallback = state.items[0] as FallbackItem
    expect(fallback.kind).toBe('fallback')
    expect(fallback.sessionUpdate).toBe('some_future_kind')
    expect(fallback.raw).toMatchObject({ sessionUpdate: 'some_future_kind', payloadField: 42 })
  })

  it('echoes the user prompt immediately and tracks turn lifecycle', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'read the readme',
    })
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'read the readme' })
    expect(state.isProcessing).toBe(true)

    state = conversationReducer(state, { type: 'turn-complete' })
    expect(state.isProcessing).toBe(false)
  })

  it('ignores non-session/update payloads (lifecycle, server requests)', () => {
    const before = initialConversationState
    const after = [
      { type: 'stderr', text: 'warning' },
      { jsonrpc: '2.0', id: 0, method: 'fs/read_text_file', params: { path: '/x' } },
      { method: 'session/update', params: {} }, // malformed: no update
    ].reduce<ConversationState>(feed, before)
    expect(after.items).toHaveLength(0)
    expect(after).toEqual(before)
  })

  it('available_commands_update is stored, not rendered', () => {
    const state = feed(
      initialConversationState,
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'init', description: 'Initialize' }, { name: 'compact' }],
      }),
    )
    expect(state.items).toHaveLength(0)
    expect(state.availableCommands).toEqual([
      { name: 'init', description: 'Initialize' },
      { name: 'compact', description: undefined },
    ])
  })
})

/**
 * TB3 Seam A: the captured write-with-permission turn (docs/acp-capture.md §7).
 * Order: tool_call (pending edit) → request_permission → tool_call_update
 * (completed, rawOutput) → usage. We assert one tool item keyed by toolCallId
 * transitions pending → completed (merging rawOutput), and that the permission
 * server request becomes a permission item linked to that toolCallId.
 */

const TOOL_CALL_ID = 'EcjzekVw0'

/** Wrap a `session/request_permission` server request (agent → client). */
function permissionRequest(id: number | string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: TOOL_CALL_ID },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
        { kind: 'allow_always', name: 'Allow for remainder of this session', optionId: 'allow_always' },
        { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always_permanent' },
        { kind: 'reject_once', name: 'Deny', optionId: 'reject_once' },
      ],
    },
  }
}

const WRITE_TURN: unknown[] = [
  update({
    sessionUpdate: 'tool_call',
    toolCallId: TOOL_CALL_ID,
    kind: 'edit',
    status: 'pending',
    title: 'Write note.txt',
    locations: [{ path: '/abs/workspace/note.txt' }],
    content: [{ type: 'diff', path: '/abs/workspace/note.txt', newText: 'vibe-mistro works.' }],
  }),
  permissionRequest(0),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: TOOL_CALL_ID,
    status: 'completed',
    rawOutput: { bytes_written: 19 },
  }),
  update({ sessionUpdate: 'usage_update', used: 21047, size: 128000 }),
]

describe('conversationReducer — write + permission (TB3 Seam A)', () => {
  it('reduces the captured write turn into one tool item that transitions pending → completed', () => {
    const state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)

    // Exactly one tool item, keyed by toolCallId across tool_call + tool_call_update.
    const tools = state.items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    const tool = tools[0]
    expect(tool.toolCallId).toBe(TOOL_CALL_ID)
    expect(tool.id).toBe(`tool:${TOOL_CALL_ID}`)
    // tool_call_update merged: status advanced and rawOutput captured…
    expect(tool.status).toBe('completed')
    expect(tool.rawOutput).toEqual({ bytes_written: 19 })
    // …while fields only the original tool_call carried are preserved.
    expect(tool.toolKind).toBe('edit')
    expect(tool.title).toBe('Write note.txt')
    expect(tool.locations).toEqual([{ path: '/abs/workspace/note.txt' }])
    expect(tool.content).toHaveLength(1)
  })

  it('turns the request_permission server request into a permission item linked by toolCallId', () => {
    const state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)
    const perms = state.items.filter((i): i is PermissionItem => i.kind === 'permission')
    expect(perms).toHaveLength(1)
    const perm = perms[0]
    expect(perm.requestId).toBe(0) // JSON-RPC id we must answer by (0 is valid)
    expect(perm.toolCallId).toBe(TOOL_CALL_ID)
    expect(perm.options.map((o) => o.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'allow_always_permanent',
      'reject_once',
    ])
    expect(perm.chosenOptionId).toBeNull()
  })

  it('records the chosen option on resolve-permission so the prompt stops asking', () => {
    let state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)
    state = conversationReducer(state, {
      type: 'resolve-permission',
      requestId: 0,
      optionId: 'allow_once',
      name: 'Allow once',
    })
    const perm = state.items.find((i): i is PermissionItem => i.kind === 'permission')!
    expect(perm.chosenOptionId).toBe('allow_once')
    expect(perm.chosenName).toBe('Allow once')
  })

  it('does not create a second tool item if tool_call_update arrives first (defensive merge)', () => {
    const state = [
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'X', status: 'completed', rawOutput: { ok: true } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'X', kind: 'edit', status: 'pending', title: 'T' }),
    ].reduce<ConversationState>(feed, initialConversationState)
    const tools = state.items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    // A later pending tool_call must not clobber an already-captured rawOutput.
    expect(tools[0].rawOutput).toEqual({ ok: true })
    expect(tools[0].title).toBe('T')
  })
})

describe('conversationReducer — hung-turn recovery (TB3)', () => {
  it('clears isProcessing and surfaces an error when the agent exits mid-turn', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'write a file',
    })
    expect(state.isProcessing).toBe(true)

    state = feed(state, { type: 'exit', info: { code: 1, signal: null } })
    expect(state.isProcessing).toBe(false)
    const err = state.items.find((i): i is ErrorItem => i.kind === 'error')
    expect(err?.message).toMatch(/exited/i)
  })

  it('ignores an agent exit when no turn is in flight (no phantom error)', () => {
    const state = feed(initialConversationState, { type: 'exit', info: { code: 0, signal: null } })
    expect(state.items).toHaveLength(0)
    expect(state.isProcessing).toBe(false)
  })

  it('the recover action re-enables input for a wedged (e.g. dismissed-permission) turn', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'write a file',
    })
    state = conversationReducer(state, { type: 'recover' })
    expect(state.isProcessing).toBe(false)
    expect(state.items.some((i) => i.kind === 'error')).toBe(true)
  })

  it('surfaces a failed turn (turn-error) as an item and ends processing', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'do thing',
    })
    state = conversationReducer(state, { type: 'turn-error', message: 'boom' })
    expect(state.isProcessing).toBe(false)
    const err = state.items.find((i): i is ErrorItem => i.kind === 'error')
    expect(err?.message).toBe('boom')
  })
})
