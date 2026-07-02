import { describe, it, expect, afterAll } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acpEventEntry,
  agentReboundEntry,
  parseTranscript,
  resolvePermissionEntry,
  sessionIdFromPayload,
  titleFromSessionInfoUpdate,
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptStore,
  transcriptVersionOf,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
  type TranscriptEntry,
} from './transcript'

/** The version-header line every fresh log starts with (see TRANSCRIPT_SCHEMA_VERSION). */
const HEADER_LINE = `{"t":"__transcript_header","v":${TRANSCRIPT_SCHEMA_VERSION}}`

/**
 * The main-side per-Thread JSONL transcript (ADR-0005: vibe owns agent context,
 * we own the visible history). Exercised over a REAL temp dir via the injectable
 * append/read seam, mirroring metadata-store.test.ts / fs-write.test.ts — no
 * `userData`, no `vibe-acp` spawned.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-transcript-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A store writing `<threadId>.jsonl` files into the shared temp dir. */
function storeAt(): TranscriptStore {
  return new TranscriptStore({ dir })
}

describe('TranscriptStore append', () => {
  it('writes a version header then appends a user-prompt entry to <threadId>.jsonl', async () => {
    const store = storeAt()
    await store.append('thread-up', { t: 'user-prompt', id: 'u1', text: 'hello' })

    const raw = readFileSync(join(dir, 'thread-up.jsonl'), 'utf8')
    // Line 1 is the schema-version header; the conversation entry follows it.
    expect(raw).toBe(`${HEADER_LINE}\n{"t":"user-prompt","id":"u1","text":"hello"}\n`)
    // read() skips the header and returns just the conversation entry.
    expect(await store.read('thread-up')).toEqual([{ t: 'user-prompt', id: 'u1', text: 'hello' }])
  })

  it('appends acp-event then resolve-permission in order, append-only across turns', async () => {
    const store = storeAt()
    const id = 'thread-order'

    // First turn: prompt -> a streamed event -> a permission response.
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'go' })
    await store.append(id, { t: 'acp-event', payload: { method: 'session/update' } })
    await store.append(id, { t: 'resolve-permission', requestId: 7, optionId: 'allow', name: 'Allow' })

    const afterFirst = readFileSync(join(dir, `${id}.jsonl`), 'utf8')

    // A second turn appends WITHOUT rewriting the earlier lines.
    await store.append(id, { t: 'user-prompt', id: 'u2', text: 'again' })

    const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf8').trimEnd().split('\n')
    expect(lines).toEqual([
      HEADER_LINE, // written once, as line 1, before the first entry
      '{"t":"user-prompt","id":"u1","text":"go"}',
      '{"t":"acp-event","payload":{"method":"session/update"}}',
      '{"t":"resolve-permission","requestId":7,"optionId":"allow","name":"Allow"}',
      '{"t":"user-prompt","id":"u2","text":"again"}',
    ])
    // The first three lines are byte-identical to before the second turn (append-only).
    expect(readFileSync(join(dir, `${id}.jsonl`), 'utf8').startsWith(afterFirst)).toBe(true)
  })
})

describe('TranscriptStore read / parseTranscript', () => {
  const entries: TranscriptEntry[] = [
    { t: 'user-prompt', id: 'u1', text: 'hi' },
    { t: 'acp-event', payload: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } } },
    { t: 'resolve-permission', requestId: 'r1', optionId: 'deny', name: 'Deny' },
  ]

  it('reads a clean log back into the entry array, in order', async () => {
    const store = storeAt()
    const id = 'thread-read'
    for (const entry of entries) await store.append(id, entry)

    expect(await store.read(id)).toEqual(entries)
  })

  it('returns [] for a Thread with no log yet (never throws)', async () => {
    expect(await storeAt().read('thread-absent')).toEqual([])
  })

  it('parseTranscript round-trips clean newline-delimited JSON', () => {
    const raw = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    expect(parseTranscript(raw)).toEqual(entries)
  })

  it('tolerates a malformed/partial trailing line: parses the valid prefix, no throw', () => {
    // A crash mid-append leaves the final record torn (no closing brace, no \n).
    const torn =
      '{"t":"user-prompt","id":"u1","text":"hi"}\n' +
      '{"t":"acp-event","payload":{"a":1}}\n' +
      '{"t":"resolve-permission","requestId":2,"opti'

    expect(() => parseTranscript(torn)).not.toThrow()
    expect(parseTranscript(torn)).toEqual([
      { t: 'user-prompt', id: 'u1', text: 'hi' },
      { t: 'acp-event', payload: { a: 1 } },
    ])
  })

  it('read() tolerates a torn trailing line written to a real temp file', async () => {
    const id = 'thread-torn'
    const store = storeAt()
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'hi' })
    // Simulate a torn write by appending a partial (non-terminated) JSON line.
    appendFileSync(join(dir, `${id}.jsonl`), '{"t":"acp-event","payl')

    const read = await store.read(id)
    expect(read).toEqual([{ t: 'user-prompt', id: 'u1', text: 'hi' }])
  })

  it('parses a user-prompt WITH image refs and a legacy one WITHOUT, side by side', () => {
    // The additive optional `images` needs no schema-version bump: the guard
    // discriminates on `t` alone, so legacy lines and new lines coexist in one log.
    const raw =
      '{"t":"user-prompt","id":"u1","text":"old"}\n' +
      '{"t":"user-prompt","id":"u2","text":"new","images":[{"file":"a.png","mimeType":"image/png"}]}\n'

    expect(parseTranscript(raw)).toEqual([
      { t: 'user-prompt', id: 'u1', text: 'old' },
      { t: 'user-prompt', id: 'u2', text: 'new', images: [{ file: 'a.png', mimeType: 'image/png' }] },
    ])
  })
})

describe('userPromptEntry images', () => {
  it('carries the refs when given, and omits the field entirely when absent or empty', () => {
    const refs = [{ file: 'a.png', mimeType: 'image/png' }]
    expect(userPromptEntry('u1', 'hi', refs)).toEqual({ t: 'user-prompt', id: 'u1', text: 'hi', images: refs })
    // Legacy byte-identical shape — no `images` key, not even undefined.
    expect(userPromptEntry('u2', 'hi')).toEqual({ t: 'user-prompt', id: 'u2', text: 'hi' })
    expect('images' in userPromptEntry('u3', 'hi', [])).toBe(false)
  })
})

describe('TranscriptStore schema versioning (ADR-0005 hardening)', () => {
  it('writes the header exactly once, not before every append', async () => {
    const store = storeAt()
    const id = 'thread-header-once'
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'a' })
    await store.append(id, { t: 'user-prompt', id: 'u2', text: 'b' })

    const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf8').trimEnd().split('\n')
    expect(lines.filter((l) => l === HEADER_LINE)).toHaveLength(1)
    expect(lines[0]).toBe(HEADER_LINE) // and it's line 1
  })

  it('does NOT prepend a header to a legacy header-less log (restart-safe)', async () => {
    // A log written before versioning starts with a real entry, not a header.
    // Re-opening and appending must leave it header-less (it reads back as v1),
    // never inject a header into the MIDDLE of the file.
    const id = 'thread-legacy'
    const path = join(dir, `${id}.jsonl`)
    appendFileSync(path, '{"t":"user-prompt","id":"old","text":"pre-versioning"}\n')

    const store = storeAt() // fresh instance: header fast-path set is empty
    await store.append(id, { t: 'user-prompt', id: 'new', text: 'after upgrade' })

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toEqual([
      '{"t":"user-prompt","id":"old","text":"pre-versioning"}',
      '{"t":"user-prompt","id":"new","text":"after upgrade"}',
    ])
    expect(transcriptVersionOf(readFileSync(path, 'utf8'))).toBe(1)
  })

  it('transcriptVersionOf reads the header version, or 1 for a legacy log', () => {
    expect(transcriptVersionOf(`${HEADER_LINE}\n{"t":"turn-complete"}\n`)).toBe(
      TRANSCRIPT_SCHEMA_VERSION,
    )
    expect(transcriptVersionOf('{"t":"user-prompt","id":"u1","text":"hi"}\n')).toBe(1)
    expect(transcriptVersionOf('')).toBe(1)
  })
})

describe('TranscriptStore best-effort', () => {
  it('append does not propagate when the underlying writer throws', async () => {
    const store = new TranscriptStore({
      dir,
      append: async () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })
    // The tee must NEVER break the live conversation — a failing append is swallowed.
    await expect(store.append('thread-fail', { t: 'user-prompt', id: 'u1', text: 'x' })).resolves.toBeUndefined()
  })
})

describe('TranscriptStore.delete (TB6 #35)', () => {
  it('unlinks an existing <threadId>.jsonl so its log is gone', async () => {
    const store = storeAt()
    const id = 'thread-delete'
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'hi' })
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true)

    await store.delete(id)

    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(false)
    // And it reads back empty afterwards (no residue for a later same-id Thread).
    expect(await store.read(id)).toEqual([])
  })

  it('does not throw when the log is MISSING (never-prompted draft)', async () => {
    const store = storeAt()
    // A draft that was never prompted has no JSONL — deleting it must be a no-op.
    await expect(store.delete('thread-never-written')).resolves.toBeUndefined()
  })

  it('swallows a non-ENOENT unlink failure (best-effort, never blocks deletion)', async () => {
    const store = new TranscriptStore({
      dir,
      unlink: async () => {
        throw new Error('EACCES: permission denied')
      },
    })
    await expect(store.delete('thread-unlink-fails')).resolves.toBeUndefined()
  })
})

describe('entry constructors mirror the reducer inputs', () => {
  it('builds tagged entries matching the ConversationAction shapes', () => {
    expect(userPromptEntry('u1', 'hi')).toEqual({ t: 'user-prompt', id: 'u1', text: 'hi' })
    expect(acpEventEntry({ method: 'session/update' })).toEqual({
      t: 'acp-event',
      payload: { method: 'session/update' },
    })
    expect(resolvePermissionEntry(7, 'allow', 'Allow')).toEqual({
      t: 'resolve-permission',
      requestId: 7,
      optionId: 'allow',
      name: 'Allow',
    })
    // Main may not know the chosen option's display name at the chokepoint
    // (respondPermission carries only requestId + optionId); name is then null.
    expect(resolvePermissionEntry('r1', 'deny')).toEqual({
      t: 'resolve-permission',
      requestId: 'r1',
      optionId: 'deny',
      name: null,
    })
    // The agent-rebound notice (TB4 #33) carries no payload — the copy is a
    // renderer-side constant — and round-trips through parseTranscript.
    expect(agentReboundEntry()).toEqual({ t: 'agent-rebound' })
    expect(parseTranscript('{"t":"agent-rebound"}\n')).toEqual([{ t: 'agent-rebound' }])
  })
})

describe('TranscriptStore serializes concurrent appends (M1)', () => {
  it('preserves CALL order for fire-and-forget appends even when the writer reorders by timing', async () => {
    const written: string[] = []
    let call = 0
    // A writer whose completion delay DECREASES with call order (first call is
    // slowest). Without the per-Thread chain these un-awaited writes would land
    // out of order; serialization forces strict call order.
    const append = (_path: string, line: string): Promise<void> => {
      const delay = (10 - call++) * 4
      return new Promise((resolve) =>
        setTimeout(() => {
          written.push(line)
          resolve()
        }, delay),
      )
    }
    const store = new TranscriptStore({ dir, append })

    let tail: Promise<void> = Promise.resolve()
    for (let i = 0; i < 10; i++) {
      // Fire-and-forget exactly like the production tee — do NOT await each.
      tail = store.append('thread-serial', { t: 'user-prompt', id: `u${i}`, text: String(i) })
    }
    await tail

    // Ignore the one-time version header (not a conversation entry); the
    // user-prompt entries must land in strict call order.
    expect(
      written
        .map((l) => JSON.parse(l) as { t: string; text?: string })
        .filter((e) => e.t === 'user-prompt')
        .map((e) => e.text),
    ).toEqual(Array.from({ length: 10 }, (_, i) => String(i)))
  })

  it('preserves order with the real fs writer over a temp dir (mirrors production concurrency)', async () => {
    const store = storeAt()
    const id = 'thread-serial-fs'

    let tail: Promise<void> = Promise.resolve()
    for (let i = 0; i < 20; i++) {
      tail = store.append(id, { t: 'user-prompt', id: `u${i}`, text: String(i) })
    }
    await tail

    const texts = (await store.read(id)).map((e) => (e as { text: string }).text)
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => String(i)))
  })
})

describe('turn-outcome entries (S2)', () => {
  it('constructs turn-complete / turn-error entries mirroring the reducer actions', () => {
    expect(turnCompleteEntry()).toEqual({ t: 'turn-complete' })
    expect(turnErrorEntry('boom')).toEqual({ t: 'turn-error', message: 'boom' })
  })

  it('survives a write+read round-trip (recognized by the reader)', async () => {
    const store = storeAt()
    const id = 'thread-outcome'
    await store.append(id, turnCompleteEntry())
    await store.append(id, turnErrorEntry('explode'))
    expect(await store.read(id)).toEqual([{ t: 'turn-complete' }, { t: 'turn-error', message: 'explode' }])
  })
  // The fold of these entries through conversationReducer is asserted renderer-side
  // (src/renderer/src/conversation/reducer.test.ts, "transcript replay contract")
  // — a main-project test can't import the reducer across the composite boundary.
})

describe('sessionIdFromPayload (S3 routing)', () => {
  it('extracts the sessionId from session/update and session/request_permission payloads', () => {
    expect(
      sessionIdFromPayload({ method: 'session/update', params: { sessionId: 's1', update: {} } }),
    ).toBe('s1')
    expect(
      sessionIdFromPayload({ id: 1, method: 'session/request_permission', params: { sessionId: 's2' } }),
    ).toBe('s2')
  })

  it('returns null when no string sessionId is present (lifecycle / garbage)', () => {
    expect(sessionIdFromPayload({ type: 'exit', info: { code: 0 } })).toBeNull()
    expect(sessionIdFromPayload({ params: { sessionId: 5 } })).toBeNull()
    expect(sessionIdFromPayload(null)).toBeNull()
    expect(sessionIdFromPayload('nope')).toBeNull()
  })
})

describe('titleFromSessionInfoUpdate (auto-title capture)', () => {
  it('extracts the title from a session_info_update session/update', () => {
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'session_info_update', title: 'Refactor @auth.py' } },
      }),
    ).toBe('Refactor @auth.py')
  })

  it('returns null for other session/update kinds and non-title payloads', () => {
    // A different sessionUpdate discriminant — not a title event.
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: {} } },
      }),
    ).toBeNull()
    // Right discriminant but empty/missing/non-string title → skip (no clobber with '').
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'session_info_update', title: '' } },
      }),
    ).toBeNull()
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'session_info_update', title: 7 } },
      }),
    ).toBeNull()
    // Wrong method / garbage.
    expect(titleFromSessionInfoUpdate({ method: 'session/request_permission', params: {} })).toBeNull()
    expect(titleFromSessionInfoUpdate({ method: 'session/update', params: {} })).toBeNull()
    expect(titleFromSessionInfoUpdate(null)).toBeNull()
    expect(titleFromSessionInfoUpdate('nope')).toBeNull()
  })
})

/**
 * Permission-response routing under multiplexing (TB5 #34). Several Threads share
 * one agent; a permission response must tee to the Thread it ANSWERS (by its
 * explicit threadId), NOT the agent's last-prompted Thread. This pins the
 * per-threadId contract `respondPermission` now uses (it tees by args.threadId,
 * not the agentId -> threadId map that would misroute after a sibling prompt).
 */
describe('resolve-permission routing by threadId (TB5 multiplex)', () => {
  it('tees a resolve-permission entry to the answered Thread, not a sibling', async () => {
    const store = storeAt()
    // Thread A has a pending permission; meanwhile sibling B was the last prompted.
    await store.append('perm-A', resolvePermissionEntry('req-1', 'allow-once'))

    const a = await store.read('perm-A')
    expect(a).toEqual([{ t: 'resolve-permission', requestId: 'req-1', optionId: 'allow-once', name: null }])
    // The sibling's log is untouched — the entry did not misroute to B.
    expect(await store.read('perm-B')).toEqual([])
  })
})
