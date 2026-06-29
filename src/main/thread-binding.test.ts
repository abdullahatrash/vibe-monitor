import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBoundSession, type SessionOpener } from './thread-binding'
import { createThreadDraft } from './persistence/drafts'
import { MetadataStore } from './persistence/metadata-store'
import type { ThreadInfo } from '../shared/ipc'

/**
 * Bind-on-first-prompt (ADR-0005, TB5 #34): a draft (sessionId null) triggers
 * exactly ONE `session/new` on the Workspace's agent on its first prompt, binds
 * the returned sessionId onto the SAME Thread id, and reuses it thereafter.
 * Tested at the agent seam with an injected fake opener (counting `session/new`
 * calls) over a REAL temp-dir store — never a live `vibe-acp`.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-binding-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A fake agent that mints a fresh sessionId per `openThread` (one per session/new). */
function fakeOpener(prefix = 'sess'): SessionOpener & { calls: number } {
  let n = 0
  return {
    calls: 0,
    async openThread(): Promise<ThreadInfo> {
      this.calls++
      n++
      return { sessionId: `${prefix}-${n}`, title: null, modes: null, models: null }
    },
  }
}

describe('ensureBoundSession', () => {
  it('mints one session on a draft, binds it by id, and reuses it (no second session/new)', async () => {
    const store = new MetadataStore({ filePath: join(dir, 'bind.json') })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/bind' })
    const draft = await createThreadDraft(store, ws.id)
    const agent = fakeOpener()

    // First prompt on the draft: exactly one session/new, bound onto the same id.
    const first = await ensureBoundSession({
      agent,
      store,
      threadId: draft.id,
      workspaceId: ws.id,
      sessionId: null,
    })
    expect(agent.calls).toBe(1)
    expect(first.minted).toBe(true)
    expect(first.sessionId).toBe('sess-1')

    // The SAME Thread id now carries the bound sessionId (resume cursor).
    const bound = store.snapshot().threads.find((t) => t.id === draft.id)
    expect(bound?.id).toBe(draft.id)
    expect(bound?.sessionId).toBe('sess-1')
    expect(store.snapshot().threads.filter((t) => t.id === draft.id)).toHaveLength(1) // no duplicate

    // A subsequent prompt passes the bound sessionId: NO second session/new.
    const second = await ensureBoundSession({
      agent,
      store,
      threadId: draft.id,
      workspaceId: ws.id,
      sessionId: first.sessionId,
    })
    expect(agent.calls).toBe(1) // unchanged
    expect(second.minted).toBe(false)
    expect(second.sessionId).toBe('sess-1')
  })

  it('binds two drafts under one agent to two distinct sessions (multi-Thread per Workspace)', async () => {
    const store = new MetadataStore({ filePath: join(dir, 'multi.json') })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/multi' })
    const a = await createThreadDraft(store, ws.id)
    const b = await createThreadDraft(store, ws.id)
    const agent = fakeOpener()

    const ra = await ensureBoundSession({ agent, store, threadId: a.id, workspaceId: ws.id, sessionId: null })
    const rb = await ensureBoundSession({ agent, store, threadId: b.id, workspaceId: ws.id, sessionId: null })

    expect(agent.calls).toBe(2) // one session/new per draft
    expect(ra.sessionId).not.toBe(rb.sessionId) // independent sessions on one agent

    const threads = store.snapshot().threads
    expect(threads.find((t) => t.id === a.id)?.sessionId).toBe(ra.sessionId)
    expect(threads.find((t) => t.id === b.id)?.sessionId).toBe(rb.sessionId)
  })
})
