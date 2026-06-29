import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupThreadsByWorkspace, MetadataStore } from './metadata-store'

/**
 * The main-side Workspace/Thread metadata store (ADR-0005 metadata-first lazy
 * reopen). Exercised over a REAL temp-dir JSON file via the injectable fs/path
 * seam, mirroring fs-write.test.ts — no `userData`, no `vibe-acp` spawned.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-metadata-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A store bound to a fresh JSON file under the shared temp dir. */
function storeAt(file: string): MetadataStore {
  return new MetadataStore({ filePath: join(dir, file) })
}

describe('MetadataStore round-trip', () => {
  it('persists Workspaces + Threads and reads them back through a new instance', async () => {
    const file = 'roundtrip.json'
    const store = storeAt(file)
    await store.load()

    const ws = await store.upsertWorkspace({ dir: '/proj/alpha', displayName: 'alpha' })
    await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-1', title: 'first' })

    // A brand-new instance over the SAME file must read the persisted state back.
    const reopened = storeAt(file)
    await reopened.load()
    const snap = reopened.snapshot()

    expect(snap.workspaces).toHaveLength(1)
    expect(snap.workspaces[0]).toMatchObject({ dir: '/proj/alpha', displayName: 'alpha' })
    expect(snap.threads).toHaveLength(1)
    expect(snap.threads[0]).toMatchObject({ workspaceId: ws.id, sessionId: 'sess-1', title: 'first' })
  })

  it("mints a Thread id distinct from its ACP sessionId, and allows a null sessionId", async () => {
    const store = storeAt('distinct-id.json')
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/beta' })

    const bound = await store.upsertThread({ workspaceId: ws.id, sessionId: 'acp-session-xyz' })
    expect(bound.id).not.toBe(bound.sessionId)
    expect(bound.id.length).toBeGreaterThan(0)

    // A Thread can exist before any ACP session is minted (resume cursor null).
    const cold = await store.upsertThread({ workspaceId: ws.id })
    expect(cold.sessionId).toBeNull()
    expect(cold.id).not.toBe(bound.id)
  })

  it('upserts a Workspace by dir (no duplicate), refreshing lastOpenedAt and re-ordering', async () => {
    let clock = 1000
    const store = new MetadataStore({ filePath: join(dir, 'ws-order.json'), now: () => clock })
    await store.load()

    const a = await store.upsertWorkspace({ dir: '/proj/a' })
    clock = 2000
    await store.upsertWorkspace({ dir: '/proj/b' })
    clock = 3000
    // Re-open A: same record (same id), bumped timestamp, now most-recent.
    const aAgain = await store.upsertWorkspace({ dir: '/proj/a' })

    expect(aAgain.id).toBe(a.id)
    expect(aAgain.lastOpenedAt).toBe(3000)
    const dirs = store.snapshot().workspaces.map((w) => w.dir)
    expect(dirs).toEqual(['/proj/a', '/proj/b']) // most-recent-first, no duplicate
  })

  it('upserts a Thread by id (no duplicate), refreshing lastActiveAt and re-ordering', async () => {
    let clock = 1000
    const store = new MetadataStore({ filePath: join(dir, 'thread-order.json'), now: () => clock })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/c' })

    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2' })
    clock = 1300
    // Touch t1 again (e.g. a new turn): bumps lastActiveAt, no second record.
    const t1Again = await store.upsertThread({ id: t1.id, workspaceId: ws.id, sessionId: 's1b' })

    expect(t1Again.id).toBe(t1.id)
    expect(t1Again.createdAt).toBe(1100) // creation time preserved
    expect(t1Again.lastActiveAt).toBe(1300)
    expect(t1Again.sessionId).toBe('s1b') // resume cursor advanced
    const ids = store.snapshot().threads.map((t) => t.id)
    expect(ids).toEqual([t1.id, t2.id]) // t1 now most-recent
  })

  it('degrades to an empty index on a missing file (no throw)', async () => {
    const store = storeAt('does-not-exist.json')
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })
  })

  it('degrades to an empty index on a corrupt JSON file (no throw)', async () => {
    const file = join(dir, 'corrupt.json')
    writeFileSync(file, '{ this is not: valid json ]')
    const store = new MetadataStore({ filePath: file })
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })

    // Still usable after a corrupt load: the next write overwrites cleanly.
    const ws = await store.upsertWorkspace({ dir: '/proj/recover' })
    expect(store.snapshot().workspaces).toHaveLength(1)
    expect(ws.dir).toBe('/proj/recover')
  })

  it('degrades a partially-corrupt file to its valid subset (no throw on list)', async () => {
    // Valid JSON, but a malformed (null) Thread alongside a valid one and a
    // malformed Workspace alongside a valid one. Without per-record validation
    // the null record reaches snapshot()/groupThreadsByWorkspace and throws on
    // `b.lastActiveAt` — narrowing the corrupt-degrades-gracefully guarantee.
    const file = join(dir, 'partial-corrupt.json')
    writeFileSync(
      file,
      JSON.stringify({
        workspaces: [
          { id: 'w1', dir: '/ok', displayName: 'ok', lastOpenedAt: 100 },
          { id: 'wBad', dir: 123 }, // dir not a string, no timestamp → dropped
        ],
        threads: [
          null, // dropped, must not crash
          { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 10 },
          { id: 'tBad', workspaceId: 'w1' }, // missing numeric timestamps → dropped
        ],
      }),
    )
    const store = new MetadataStore({ filePath: file })
    await store.load()

    const snap = store.snapshot()
    expect(snap.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(snap.threads.map((t) => t.id)).toEqual(['t1'])
    // Listing the valid subset must not throw on the dropped malformed records.
    expect(() => groupThreadsByWorkspace(snap)).not.toThrow()
    expect(groupThreadsByWorkspace(snap)[0].threads.map((t) => t.id)).toEqual(['t1'])
  })
})

describe('MetadataStore atomic persist', () => {
  it('writes to a temp file then renames it over the target (crash-safe)', async () => {
    const events: string[] = []
    const target = join(dir, 'atomic.json')
    let tmpContent = ''
    const store = new MetadataStore({
      filePath: target,
      readFile: async () => {
        throw new Error('ENOENT')
      },
      writeFile: async (path, data) => {
        events.push(`write:${path}`)
        tmpContent = data
      },
      rename: async (from, to) => {
        // The rename must follow the temp write, and the temp must already hold
        // the full payload — never a half-written target.
        events.push(`rename:${from}->${to}`)
        expect(tmpContent).toContain('/proj/atomic')
      },
    })
    await store.load()
    await store.upsertWorkspace({ dir: '/proj/atomic' })

    expect(events).toEqual([`write:${target}.tmp`, `rename:${target}.tmp->${target}`])
  })
})

describe('groupThreadsByWorkspace (pure)', () => {
  it('nests Threads under their Workspace, both most-recent-first, dropping orphans', () => {
    const grouped = groupThreadsByWorkspace({
      workspaces: [
        { id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 100 },
        { id: 'w2', dir: '/b', displayName: 'b', lastOpenedAt: 300 },
      ],
      threads: [
        { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 10 },
        { id: 't2', workspaceId: 'w1', sessionId: 's2', title: 'two', createdAt: 2, lastActiveAt: 50 },
        { id: 't3', workspaceId: 'w2', sessionId: null, title: null, createdAt: 3, lastActiveAt: 20 },
        // Orphan: its Workspace is gone — must be dropped, not crash.
        { id: 't4', workspaceId: 'gone', sessionId: null, title: null, createdAt: 4, lastActiveAt: 99 },
      ],
    })

    expect(grouped.map((w) => w.id)).toEqual(['w2', 'w1']) // workspaces most-recent-first
    const w1 = grouped.find((w) => w.id === 'w1')
    expect(w1?.threads.map((t) => t.id)).toEqual(['t2', 't1']) // threads most-recent-first
    expect(grouped.flatMap((w) => w.threads).map((t) => t.id)).not.toContain('t4')
  })
})
