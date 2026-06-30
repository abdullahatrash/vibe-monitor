import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBoundSession, resolveContinueTarget, type SessionBinder } from './thread-binding'
import { MetadataStore } from './persistence/metadata-store'
import { SessionLoadError, WorkspaceAgentError } from './workspace-agent'
import type { ThreadInfo } from '../shared/ipc'

/**
 * Bind-on-first-prompt (ADR-0005, TB5 #34, #58): a draft (sessionId null) triggers
 * exactly ONE `session/new` on the Workspace's agent on its first prompt, binds
 * the returned sessionId onto the SAME Thread id, and reuses it thereafter. Since
 * #58 the draft is renderer-only until that first prompt — its id is minted in the
 * renderer and NOTHING is persisted until the bind here, so these tests pass a
 * locally-minted id (never a pre-persisted record) and assert it round-trips as the
 * id persisted. Tested at the agent seam with an injected fake opener (counting
 * `session/new` calls) over a REAL temp-dir store — never a live `vibe-acp`.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-binding-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/**
 * A fake binder that mints a fresh sessionId per `openThread` (one per session/new)
 * and HOSTS each minted session thereafter — so `hasSession` mirrors a real agent,
 * letting a subsequent prompt take the reuse branch instead of re-minting.
 */
function fakeOpener(prefix = 'sess'): SessionBinder & { calls: number } {
  let n = 0
  const hosted = new Set<string>()
  return {
    calls: 0,
    loadSessionAvailable: true,
    hasSession: (id) => hosted.has(id),
    loadThread() {
      throw new Error('loadThread should not be called for a draft mint')
    },
    async openThread(): Promise<ThreadInfo> {
      this.calls++
      n++
      const sessionId = `${prefix}-${n}`
      hosted.add(sessionId)
      return { sessionId, title: null, modes: null, models: null, reasoningEffort: null }
    },
  }
}

/**
 * A fake binder for the REOPENED-Thread cases (TB4 #33): `hosts` is the set of
 * sessions it already holds, `loadSessionAvailable` gates resume, and `loadThread`
 * resolves (resume) or rejects (re-bind) per the injected outcome. `loadCalls` /
 * `newCalls` let a test assert which path ran.
 */
function fakeBinder(opts: {
  hosts?: Set<string>
  loadSessionAvailable?: boolean
  loadOutcome?: 'resume' | SessionLoadError | WorkspaceAgentError
}): SessionBinder & { loadCalls: number; newCalls: number } {
  let n = 0
  return {
    loadCalls: 0,
    newCalls: 0,
    loadSessionAvailable: opts.loadSessionAvailable ?? true,
    hasSession: (id) => (opts.hosts ?? new Set()).has(id),
    async loadThread(sessionId): Promise<ThreadInfo> {
      this.loadCalls++
      const outcome = opts.loadOutcome ?? 'resume'
      if (outcome !== 'resume') throw outcome
      // Resume keeps the SAME id (the session/load result carries none, §9).
      return { sessionId, title: null, modes: null, models: null, reasoningEffort: null }
    },
    async openThread(): Promise<ThreadInfo> {
      this.newCalls++
      n++
      return { sessionId: `fresh-${n}`, title: 'Fresh', modes: null, models: null, reasoningEffort: null }
    },
  }
}

describe('ensureBoundSession', () => {
  it('persists a renderer-minted draft id on first prompt (nothing before), binds it, and reuses it', async () => {
    const store = new MetadataStore({ filePath: join(dir, 'bind.json') })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/bind' })
    // #58: the draft is renderer-only — its id is minted in the renderer and NO
    // record exists until the first prompt binds it here.
    const threadId = randomUUID()
    expect(store.snapshot().threads).toHaveLength(0)
    const agent = fakeOpener()

    // First prompt on the draft: exactly one session/new, bound onto the same id.
    const first = await ensureBoundSession({
      agent,
      store,
      threadId,
      workspaceId: ws.id,
      sessionId: null,
    })
    expect(agent.calls).toBe(1)
    expect(first.minted).toBe(true)
    expect(first.sessionId).toBe('sess-1')

    // The renderer-minted id round-trips: exactly ONE record, persisted under THAT
    // id, now carrying the bound sessionId (resume cursor) — id preservation (#58).
    const threads = store.snapshot().threads
    expect(threads).toHaveLength(1)
    expect(threads[0]?.id).toBe(threadId)
    expect(threads[0]?.sessionId).toBe('sess-1')

    // A subsequent prompt passes the bound sessionId: NO second session/new.
    const second = await ensureBoundSession({
      agent,
      store,
      threadId,
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
    // Two renderer-minted draft ids, neither persisted until its first prompt (#58).
    const aId = randomUUID()
    const bId = randomUUID()
    const agent = fakeOpener()

    const ra = await ensureBoundSession({ agent, store, threadId: aId, workspaceId: ws.id, sessionId: null })
    const rb = await ensureBoundSession({ agent, store, threadId: bId, workspaceId: ws.id, sessionId: null })

    expect(agent.calls).toBe(2) // one session/new per draft
    expect(ra.sessionId).not.toBe(rb.sessionId) // independent sessions on one agent

    const threads = store.snapshot().threads
    expect(threads).toHaveLength(2) // exactly one record per prompted draft
    expect(threads.find((t) => t.id === aId)?.sessionId).toBe(ra.sessionId)
    expect(threads.find((t) => t.id === bId)?.sessionId).toBe(rb.sessionId)
  })
})

/**
 * Reopened-Thread binding (TB4 #33): the first prompt in a reopened cold Thread
 * (stored sessionId, NOT yet hosted by the freshly-spawned agent) must resume via
 * `session/load`, re-binding a fresh `session/new` on a resume failure — all keyed
 * off the agent's `hasSession` / `loadSessionAvailable` / `loadThread` seam.
 */
describe('ensureBoundSession — reopened Thread (TB4 #33)', () => {
  async function reopenedStore(sessionId: string): Promise<{
    store: MetadataStore
    workspaceId: string
    threadId: string
  }> {
    const store = new MetadataStore({ filePath: join(dir, `reopen-${randomName()}.json`) })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: `/proj/${randomName()}` })
    const thread = await store.upsertThread({ workspaceId: ws.id, sessionId })
    return { store, workspaceId: ws.id, threadId: thread.id }
  }

  it('(ii) resumes via session/load when the agent does not yet host the stored session', async () => {
    const { store, workspaceId, threadId } = await reopenedStore('old-sess')
    const agent = fakeBinder({ loadOutcome: 'resume' })

    const bound = await ensureBoundSession({ agent, store, threadId, workspaceId, sessionId: 'old-sess' })

    expect(agent.loadCalls).toBe(1) // session/load ran
    expect(agent.newCalls).toBe(0) // NO session/new
    expect(bound).toMatchObject({ sessionId: 'old-sess', minted: false, resumed: true, rebound: false })
    // The stored cursor is unchanged — same session resumed.
    expect(store.snapshot().threads.find((t) => t.id === threadId)?.sessionId).toBe('old-sess')
  })

  it('(ii->fail) re-binds a fresh session/new and updates the stored cursor on a resume failure', async () => {
    const { store, workspaceId, threadId } = await reopenedStore('dead-sess')
    const agent = fakeBinder({ loadOutcome: new SessionLoadError('Session not found: dead-sess') })

    const bound = await ensureBoundSession({ agent, store, threadId, workspaceId, sessionId: 'dead-sess' })

    expect(agent.loadCalls).toBe(1) // tried to resume…
    expect(agent.newCalls).toBe(1) // …failed, so re-bound fresh
    expect(bound).toMatchObject({ minted: true, rebound: true, resumed: false })
    expect(bound.sessionId).toBe('fresh-1')
    // SAME Thread id, NEW cursor: history stays attached, agent context restarts.
    const record = store.snapshot().threads.find((t) => t.id === threadId)
    expect(record?.id).toBe(threadId)
    expect(record?.sessionId).toBe('fresh-1')
    expect(store.snapshot().threads.filter((t) => t.id === threadId)).toHaveLength(1)
  })

  it('(ii) skips session/load and re-binds straight away when resume is NOT advertised', async () => {
    const { store, workspaceId, threadId } = await reopenedStore('old-sess')
    const agent = fakeBinder({ loadSessionAvailable: false })

    const bound = await ensureBoundSession({ agent, store, threadId, workspaceId, sessionId: 'old-sess' })

    expect(agent.loadCalls).toBe(0) // never sends a doomed session/load
    expect(agent.newCalls).toBe(1)
    expect(bound).toMatchObject({ minted: true, rebound: true })
  })

  it('(iii) reuses a session the agent already hosts — no session/load, no session/new', async () => {
    const { store, workspaceId, threadId } = await reopenedStore('live-sess')
    const agent = fakeBinder({ hosts: new Set(['live-sess']) })

    const bound = await ensureBoundSession({ agent, store, threadId, workspaceId, sessionId: 'live-sess' })

    expect(agent.loadCalls).toBe(0)
    expect(agent.newCalls).toBe(0)
    expect(bound).toMatchObject({ sessionId: 'live-sess', minted: false, resumed: false, rebound: false })
  })

  it('propagates a -32000 auth expiry from session/load WITHOUT re-binding (routes to sign-in)', async () => {
    const { store, workspaceId, threadId } = await reopenedStore('old-sess')
    const authErr = new WorkspaceAgentError('Not signed in', null, 'not-signed-in')
    const agent = fakeBinder({ loadOutcome: authErr })

    await expect(
      ensureBoundSession({ agent, store, threadId, workspaceId, sessionId: 'old-sess' }),
    ).rejects.toBe(authErr)

    expect(agent.loadCalls).toBe(1)
    expect(agent.newCalls).toBe(0) // an auth expiry is NOT a resume failure — no re-bind
  })
})

/**
 * Cold-launch "Continue" (TB4 #33 review FIX 1): continuing a reopened Thread must
 * spawn the agent but open NO new Thread — `resolveContinueTarget` READS the
 * existing record (adds NO record, mints NO session), and the first prompt resumes
 * THAT session. Pinned at the store + binding seam (the IPC handler that calls these
 * is electron-coupled).
 */
describe('resolveContinueTarget — continue without opening a Thread (TB4 #33)', () => {
  it('seeds from the existing record without persisting a new Thread, then resumes on first prompt', async () => {
    const store = new MetadataStore({ filePath: join(dir, `continue-${randomName()}.json`) })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/continue' })
    const existing = await store.upsertThread({ workspaceId: ws.id, sessionId: 'cursor-1', title: 'Earlier' })
    const before = store.snapshot().threads.length

    // Resolving the continue target reads the record — it persists nothing.
    const target = resolveContinueTarget(store, existing.id)
    expect(target).toEqual({
      threadId: existing.id,
      workspaceId: ws.id,
      sessionId: 'cursor-1',
      title: 'Earlier',
    })
    expect(store.snapshot().threads.length).toBe(before) // NO extra Thread persisted

    // The first prompt on the continued Thread resumes its stored session — no
    // session/new, no new record.
    const agent = fakeBinder({ loadOutcome: 'resume' })
    const bound = await ensureBoundSession({
      agent,
      store,
      threadId: target!.threadId,
      workspaceId: target!.workspaceId,
      sessionId: target!.sessionId,
    })
    expect(agent.loadCalls).toBe(1)
    expect(agent.newCalls).toBe(0)
    expect(bound).toMatchObject({ sessionId: 'cursor-1', resumed: true, minted: false, rebound: false })
    expect(store.snapshot().threads.length).toBe(before) // still no extra record
  })

  it('returns null for an unknown Thread id (caller falls back to opening fresh)', async () => {
    const store = new MetadataStore({ filePath: join(dir, `continue-miss-${randomName()}.json`) })
    await store.load()
    expect(resolveContinueTarget(store, 'no-such-thread')).toBeNull()
  })
})

/** A short unique suffix so each reopened-Thread test gets its own store file. */
function randomName(): string {
  return Math.random().toString(36).slice(2, 10)
}
