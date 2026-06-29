import { describe, it, expect } from 'vitest'
import {
  conversationReducer,
  initialConversationState,
  type AssistantItem,
  type ConversationState,
  type FallbackItem,
  type ReasoningItem,
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
 *  (no dedicated renderer in TB2 → fallback), then usage. */
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
    content: { type: 'text', text: 'describes vibe-monitor.' },
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

    // Ordered items: reasoning (1, accumulated), tool_call fallback, assistant (1, accumulated).
    expect(state.items.map((i) => i.kind)).toEqual(['reasoning', 'fallback', 'assistant'])

    const reasoning = state.items[0] as ReasoningItem
    expect(reasoning.messageId).toBe('r1')
    expect(reasoning.text).toBe('Let me check the file.')

    const assistant = state.items[2] as AssistantItem
    expect(assistant.messageId).toBe('a1')
    expect(assistant.text).toBe('The README describes vibe-monitor.')
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
