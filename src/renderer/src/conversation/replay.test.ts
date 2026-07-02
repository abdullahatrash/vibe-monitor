import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '../../../shared/ipc'
import {
  conversationReducer,
  initialConversationState,
  REBOUND_NOTICE,
  type AssistantItem,
  type ConversationState,
  type NoticeItem,
  type PermissionItem,
  type ReasoningItem,
  type ToolItem,
} from './reducer'
import { replayTranscript, transcriptHasImages } from './replay'

/**
 * TB3 (#32): a reopened Thread renders FROM its JSONL, no `vibe-acp` spawned.
 * `replayTranscript` folds the logged `TranscriptEntry[]` through the SAME
 * `conversationReducer` the live turn used (ADR-0001) — so a recorded turn
 * replays to the very state it originally produced. These tests pin that.
 */

const SESSION_ID = '8b7044cf-19d1-7a23-8da1-929c81b23170'

/** Wrap an `update` object in the `session/update` notification frame. */
function update(u: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update: u } }
}

/** The recorded read-turn transcript: prompt, streamed events, clean turn end. */
const READ_TRANSCRIPT: TranscriptEntry[] = [
  { t: 'user-prompt', id: 'user:0', text: 'read the readme' },
  { t: 'acp-event', payload: update({ sessionUpdate: 'session_info_update', title: 'Read the README' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me ' }, messageId: 'r1' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'check the file.' }, messageId: 'r1' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'tool_call', toolCallId: 'EcjzekVw0', kind: 'read', status: 'pending', title: 'Read README.md' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'tool_call_update', toolCallId: 'EcjzekVw0', status: 'completed', rawOutput: { ok: true } }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The README ' }, messageId: 'a1' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'describes vibe-mistro.' }, messageId: 'a1' }) },
  { t: 'acp-event', payload: update({ sessionUpdate: 'usage_update', used: 21047, size: 128000, cost: { amount: 0.0123, currency: 'USD' } }) },
  { t: 'turn-complete' },
]

describe('replayTranscript (TB3 #32)', () => {
  it('folds a recorded turn to the same ConversationState the live turn produced', () => {
    const replayed = replayTranscript(READ_TRANSCRIPT)

    // Equivalent to driving the live reducer with the same input stream.
    const live: ConversationState = [
      { type: 'send-prompt', id: 'user:0', text: 'read the readme' } as const,
      ...READ_TRANSCRIPT.slice(1, -1).map(
        (e) => ({ type: 'acp-event', payload: (e as { payload: unknown }).payload }) as const,
      ),
      { type: 'turn-complete' } as const,
    ].reduce(conversationReducer, initialConversationState)

    expect(replayed).toEqual(live)

    // And the rebuilt view is exactly what the user saw: ordered items, text, title.
    expect(replayed.title).toBe('Read the README')
    expect(replayed.usage).toEqual({ used: 21047, size: 128000 })
    expect(replayed.cost).toEqual({ amount: 0.0123, currency: 'USD' })
    expect(replayed.items.map((i) => i.kind)).toEqual(['user', 'reasoning', 'tool', 'assistant'])
    expect((replayed.items[1] as ReasoningItem).text).toBe('Let me check the file.')
    expect((replayed.items[2] as ToolItem).status).toBe('completed')
    expect((replayed.items[3] as AssistantItem).text).toBe('The README describes vibe-mistro.')
    expect(replayed.isProcessing).toBe(false)
  })

  it('renders a replayed resolved permission as resolved, recovering the chosen name from the request', () => {
    // A write+permission turn: the request_permission event carries the option
    // names; the resolve-permission entry (teed by main) has name:null (TB2).
    const TOOL_CALL_ID = 'EcjzekVw0'
    const transcript: TranscriptEntry[] = [
      { t: 'user-prompt', id: 'user:0', text: 'write a file' },
      { t: 'acp-event', payload: update({ sessionUpdate: 'tool_call', toolCallId: TOOL_CALL_ID, kind: 'edit', status: 'pending', title: 'Write note.txt' }) },
      {
        t: 'acp-event',
        payload: {
          jsonrpc: '2.0',
          id: 4,
          method: 'session/request_permission',
          params: {
            sessionId: SESSION_ID,
            toolCall: { toolCallId: TOOL_CALL_ID },
            options: [
              { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
              { kind: 'reject_once', name: 'Deny', optionId: 'reject_once' },
            ],
          },
        },
      },
      // Main observed only requestId + optionId at the chokepoint -> name is null.
      { t: 'resolve-permission', requestId: 4, optionId: 'allow_once', name: null },
      { t: 'acp-event', payload: update({ sessionUpdate: 'tool_call_update', toolCallId: TOOL_CALL_ID, status: 'completed', rawOutput: { bytes_written: 19 } }) },
      { t: 'turn-complete' },
    ]

    const replayed = replayTranscript(transcript)
    const perm = replayed.items.find((i): i is PermissionItem => i.kind === 'permission')!
    // Resolved (renders "You chose: …", no re-prompt) with the name recovered
    // from the matching request event's options by optionId.
    expect(perm.chosenOptionId).toBe('allow_once')
    expect(perm.chosenName).toBe('Allow once')
  })

  it('forces isProcessing false even when the final turn was cut off (no terminal entry)', () => {
    // App closed mid-turn: a prompt + a streamed chunk, but NO turn-complete /
    // turn-error. Live this would leave isProcessing true; a cold reopen is never
    // mid-turn, so replay must clear it (no phantom spinner).
    const cutOff: TranscriptEntry[] = [
      { t: 'user-prompt', id: 'user:0', text: 'do a long thing' },
      { t: 'acp-event', payload: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' }, messageId: 'a1' }) },
    ]
    expect(replayTranscript(cutOff).isProcessing).toBe(false)
  })

  it('replays an agent-rebound entry as a persisted context-reset notice (TB4 #33)', () => {
    // A reopened Thread whose resume failed: main teed the notice right after the
    // user prompt, before the re-bound turn's events. Reopening must show it again.
    const transcript: TranscriptEntry[] = [
      { t: 'user-prompt', id: 'user:0', text: 'continue please' },
      { t: 'agent-rebound' },
      { t: 'acp-event', payload: update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh start.' }, messageId: 'a1' }) },
      { t: 'turn-complete' },
    ]

    const replayed = replayTranscript(transcript)
    expect(replayed.items.map((i) => i.kind)).toEqual(['user', 'notice', 'assistant'])
    const notice = replayed.items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.message).toBe(REBOUND_NOTICE)
    expect(replayed.isProcessing).toBe(false)
  })

  it('replays an empty transcript to the initial (empty) conversation, never throwing', () => {
    // A cold/never-prompted Thread reads back [] (IPC) — the view is just empty.
    const replayed = replayTranscript([])
    expect(replayed).toEqual(initialConversationState)
    expect(replayed.items).toHaveLength(0)
    expect(replayed.isProcessing).toBe(false)
  })
})

describe('replayTranscript image attachments', () => {
  const PROMPT_WITH_IMAGES: TranscriptEntry[] = [
    {
      t: 'user-prompt',
      id: 'user:0',
      text: 'what is in this screenshot?',
      images: [
        { file: 'aaaa.png', mimeType: 'image/png' },
        { file: 'bbbb.jpg', mimeType: 'image/jpeg' },
      ],
    },
    { t: 'turn-complete' },
  ]

  it('resolves image refs through the attachment map into previewUrls on the user item', () => {
    const replayed = replayTranscript(PROMPT_WITH_IMAGES, {
      'aaaa.png': 'data:image/png;base64,AAAA',
      'bbbb.jpg': 'data:image/jpeg;base64,BBBB',
    })

    const user = replayed.items[0]
    expect(user.kind).toBe('user')
    expect(user.kind === 'user' && user.images).toEqual([
      { previewUrl: 'data:image/png;base64,AAAA' },
      { previewUrl: 'data:image/jpeg;base64,BBBB' },
    ])
  })

  it('a ref missing from the map (deleted/corrupt file) degrades that image, keeping the rest', () => {
    const replayed = replayTranscript(PROMPT_WITH_IMAGES, {
      'bbbb.jpg': 'data:image/jpeg;base64,BBBB',
    })

    const user = replayed.items[0]
    expect(user.kind === 'user' && user.images).toEqual([{ previewUrl: 'data:image/jpeg;base64,BBBB' }])
  })

  it('no attachment map at all (store failed / legacy caller) replays text-only, never throwing', () => {
    const replayed = replayTranscript(PROMPT_WITH_IMAGES)

    const user = replayed.items[0]
    expect(user.kind).toBe('user')
    expect(user.kind === 'user' && user.images).toBeUndefined()
    expect(user.kind === 'user' && user.text).toBe('what is in this screenshot?')
  })

  it('transcriptHasImages gates the attachments IPC: true only when a prompt carries refs', () => {
    expect(transcriptHasImages(PROMPT_WITH_IMAGES)).toBe(true)
    expect(transcriptHasImages(READ_TRANSCRIPT)).toBe(false)
    expect(transcriptHasImages([{ t: 'user-prompt', id: 'u1', text: 'hi', images: [] }])).toBe(false)
    expect(transcriptHasImages([])).toBe(false)
  })
})
