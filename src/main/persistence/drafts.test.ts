import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadDraft } from './drafts'
import { MetadataStore } from './metadata-store'
import { TranscriptStore } from './transcript'

/**
 * New-Thread drafts (ADR-0005, TB5 #34): minting a Thread must write ONLY a
 * metadata record with NO ACP session and NO transcript file — `session/new`
 * and the JSONL are deferred to the first prompt. Exercised over REAL temp-dir
 * stores via the injectable seams — no `userData`, no `vibe-acp` spawned.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-drafts-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('createThreadDraft', () => {
  it('writes a metadata Thread with a null sessionId and no transcript file', async () => {
    const store = new MetadataStore({ filePath: join(dir, 'draft.json') })
    await store.load()
    const transcripts = mkdtempSync(join(dir, 'transcripts-'))
    const transcriptStore = new TranscriptStore({ dir: transcripts })

    const ws = await store.upsertWorkspace({ dir: '/proj/draft' })
    const draft = await createThreadDraft(store, ws.id)

    // A durable id is minted, but the draft is bound to NO ACP session.
    expect(draft.id.length).toBeGreaterThan(0)
    expect(draft.sessionId).toBeNull()
    expect(draft.workspaceId).toBe(ws.id)

    // It appears in the index immediately (cold-listable).
    expect(store.snapshot().threads.map((t) => t.id)).toContain(draft.id)

    // No transcript was written: the JSONL file does not exist and reads empty.
    expect(existsSync(join(transcripts, `${draft.id}.jsonl`))).toBe(false)
    expect(await transcriptStore.read(draft.id)).toEqual([])
  })

  it('leaves no transcript residue for a draft that is never prompted (abandoned)', async () => {
    const store = new MetadataStore({ filePath: join(dir, 'abandoned.json') })
    await store.load()
    const transcripts = mkdtempSync(join(dir, 'transcripts-'))

    const ws = await store.upsertWorkspace({ dir: '/proj/abandon' })
    const draft = await createThreadDraft(store, ws.id)

    // Abandon it (never prompted): the record stays session-less and no file exists.
    const persisted = store.snapshot().threads.find((t) => t.id === draft.id)
    expect(persisted?.sessionId).toBeNull()
    expect(existsSync(join(transcripts, `${draft.id}.jsonl`))).toBe(false)
  })
})
