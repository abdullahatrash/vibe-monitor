import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { groupThreadsByWorkspace, METADATA_SCHEMA_VERSION, MetadataStore } from './metadata-store'

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

  it('setThreadTitle renames in place: sets title, holds position, does NOT bump lastActiveAt', async () => {
    let clock = 1000
    const store = new MetadataStore({ filePath: join(dir, 'set-title.json'), now: () => clock })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/rename' })
    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2', pinned: true })

    // Rename the OLDER thread; time advances but a title change is not activity.
    clock = 9999
    const changed = await store.setThreadTitle(t1.id, 'Renamed thread')
    expect(changed).toBe(true)

    const t1After = store.snapshot().threads.find((t) => t.id === t1.id)
    expect(t1After?.title).toBe('Renamed thread')
    expect(t1After?.lastActiveAt).toBe(1100) // NOT bumped to 9999 — no reorder
    expect(t1After?.sessionId).toBe('s1') // preserved
    // Order unchanged: t2 (1200) still ahead of t1 (1100); t2's pin flag intact.
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t2.id, t1.id])
    expect(store.snapshot().threads.find((t) => t.id === t2.id)?.pinned).toBe(true)
  })

  it('setThreadTitle is a no-op (returns false, no write) for an unknown id or unchanged title', async () => {
    const writes: string[] = []
    const store = new MetadataStore({
      filePath: join(dir, 'set-title-noop.json'),
      writeFile: async (_p, data) => {
        writes.push(data)
      },
      rename: async () => {},
    })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/noop' })
    const t = await store.upsertThread({ workspaceId: ws.id, title: 'Same' })
    const writesAfterSetup = writes.length

    expect(await store.setThreadTitle('no-such-thread', 'X')).toBe(false)
    expect(await store.setThreadTitle(t.id, 'Same')).toBe(false) // unchanged → absorbs the echo
    expect(writes.length).toBe(writesAfterSetup) // neither no-op wrote to disk
  })

  it('sets a Thread title by id (auto-title capture) preserving session + createdAt', async () => {
    // The `session_info_update` path (main's recordThreadTitle) upserts { id, workspaceId,
    // title } onto an existing bound Thread — the title must land WITHOUT dropping its
    // sessionId (resume cursor) or resetting createdAt.
    let clock = 500
    const store = new MetadataStore({ filePath: join(dir, 'title-set.json'), now: () => clock })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/title' })
    clock = 600
    const t = await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-x' })
    expect(t.title).toBeNull() // untitled until the first prompt's auto-title arrives

    clock = 700
    const titled = await store.upsertThread({ id: t.id, workspaceId: ws.id, title: 'Fix @auth.py bug' })

    expect(titled.id).toBe(t.id)
    expect(titled.title).toBe('Fix @auth.py bug')
    expect(titled.sessionId).toBe('sess-x') // resume cursor NOT clobbered by the title upsert
    expect(titled.createdAt).toBe(600) // creation time preserved
    // Durable across a reopen.
    const reopened = new MetadataStore({ filePath: join(dir, 'title-set.json') })
    await reopened.load()
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.title).toBe('Fix @auth.py bug')
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

describe('MetadataStore schema versioning (ADR-0005 hardening)', () => {
  it('persists a versioned envelope: { schemaVersion, workspaces, threads }', async () => {
    const file = join(dir, 'envelope.json')
    const store = new MetadataStore({ filePath: file })
    await store.load()
    await store.upsertWorkspace({ dir: '/proj/env' })

    const raw = JSON.parse(readFileSync(file, 'utf8'))
    expect(raw.schemaVersion).toBe(METADATA_SCHEMA_VERSION)
    expect(raw.workspaces).toHaveLength(1)
    expect(Array.isArray(raw.threads)).toBe(true)
  })

  it('reads a legacy header-less file (no schemaVersion) as the current version', async () => {
    // Files written before the envelope carry no schemaVersion — they ARE v1.
    const file = join(dir, 'legacy.json')
    writeFileSync(
      file,
      JSON.stringify({
        workspaces: [{ id: 'w1', dir: '/legacy', displayName: 'L', lastOpenedAt: 5 }],
        threads: [
          { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 2 },
        ],
      }),
    )
    const store = new MetadataStore({ filePath: file })
    await store.load()

    expect(store.isLocked()).toBe(false)
    expect(store.snapshot().workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t1'])
  })

  it('FAILS CLOSED on a newer schemaVersion: loads empty, locks, and never overwrites the file', async () => {
    // The crux safety property: an older build must not atomically wipe history
    // written by a newer one (which the pre-versioning degrade-to-empty would).
    const file = join(dir, 'future.json')
    const future = JSON.stringify({
      schemaVersion: METADATA_SCHEMA_VERSION + 99,
      workspaces: [{ id: 'wFuture', dir: '/future', displayName: 'F', lastOpenedAt: 9, brandNew: true }],
      threads: [],
    })
    writeFileSync(file, future)
    const store = new MetadataStore({ filePath: file })
    await store.load()

    // Refused to load the unknown-future shape — but LOCKED, not silently empty.
    expect(store.isLocked()).toBe(true)
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })

    // A subsequent write is a NO-OP: the newer on-disk file is preserved byte-for-byte.
    await store.upsertWorkspace({ dir: '/proj/should-not-persist' })
    expect(readFileSync(file, 'utf8')).toBe(future)
  })
})

describe('MetadataStore.deleteThread (TB6 #35)', () => {
  it('removes a Thread record so it no longer lists, leaving siblings intact', async () => {
    const file = 'delete-thread.json'
    const store = storeAt(file)
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/del' })
    const keep = await store.upsertThread({ workspaceId: ws.id, sessionId: 'keep' })
    const drop = await store.upsertThread({ workspaceId: ws.id, sessionId: 'drop' })

    await store.deleteThread(drop.id)

    const ids = store.snapshot().threads.map((t) => t.id)
    expect(ids).toEqual([keep.id]) // only the dropped Thread is gone

    // Durable: a fresh instance over the SAME file must not see the deleted record.
    const reopened = storeAt(file)
    await reopened.load()
    expect(reopened.snapshot().threads.map((t) => t.id)).toEqual([keep.id])
  })

  it('is a no-op for an unknown id (idempotent, no throw)', async () => {
    const store = storeAt('delete-unknown.json')
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/del-unknown' })
    const t = await store.upsertThread({ workspaceId: ws.id })

    await expect(store.deleteThread('no-such-thread')).resolves.toBeUndefined()
    // Deleting the same Thread twice is also safe (idempotent).
    await store.deleteThread(t.id)
    await expect(store.deleteThread(t.id)).resolves.toBeUndefined()
    expect(store.snapshot().threads).toEqual([])
  })
})

describe('MetadataStore.setThreadFlags (#132 pin / #133 archive)', () => {
  it('patches only the passed flag, leaving the other untouched, and round-trips', async () => {
    const file = 'flags-roundtrip.json'
    const store = storeAt(file)
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/flags' })
    const t = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })

    // Pin only: archived stays absent (undefined = false).
    await store.setThreadFlags(t.id, { pinned: true })
    let rec = store.snapshot().threads.find((x) => x.id === t.id)
    expect(rec?.pinned).toBe(true)
    expect(rec?.archived).toBeUndefined()

    // Archive only: pin is preserved (only the passed field changes).
    await store.setThreadFlags(t.id, { archived: true })
    rec = store.snapshot().threads.find((x) => x.id === t.id)
    expect(rec?.pinned).toBe(true)
    expect(rec?.archived).toBe(true)

    // Durable across a fresh instance over the SAME file (survives reopen/eviction).
    const reopened = storeAt(file)
    await reopened.load()
    const back = reopened.snapshot().threads.find((x) => x.id === t.id)
    expect(back?.pinned).toBe(true)
    expect(back?.archived).toBe(true)

    // Unpin clears just that flag.
    await reopened.setThreadFlags(t.id, { pinned: false })
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.pinned).toBe(false)
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.archived).toBe(true)
  })

  it('holds the record list POSITION (a flag toggle is not activity)', async () => {
    let clock = 1000
    const store = new MetadataStore({ filePath: join(dir, 'flags-order.json'), now: () => clock })
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/flags-order' })
    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id })

    // t2 leads (most recent). Pinning t1 must NOT re-order the stored list.
    await store.setThreadFlags(t1.id, { pinned: true })
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t2.id, t1.id])
  })

  it('is a no-op for an unknown id (no throw, no write)', async () => {
    const events: string[] = []
    const store = new MetadataStore({
      filePath: join(dir, 'flags-unknown.json'),
      readFile: async () => {
        throw new Error('ENOENT')
      },
      writeFile: async (path) => {
        events.push(`write:${path}`)
      },
      rename: async () => {},
    })
    await store.load()
    await expect(store.setThreadFlags('no-such-thread', { pinned: true })).resolves.toBeUndefined()
    expect(events).toEqual([]) // no disk write for an unknown id
  })

  it('upsertThread PRESERVES pinned/archived across a routine activity re-target', async () => {
    const store = storeAt('flags-preserve.json')
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/flags-preserve' })
    const t = await store.upsertThread({ workspaceId: ws.id })
    await store.setThreadFlags(t.id, { pinned: true, archived: true })

    // A normal activity-upsert (new turn: same id, fresh sessionId) must NOT clear them.
    const again = await store.upsertThread({ id: t.id, workspaceId: ws.id, sessionId: 's-new' })
    expect(again.pinned).toBe(true)
    expect(again.archived).toBe(true)
  })

  it('coerces a stored non-boolean flag to undefined on load (defensive)', async () => {
    const file = join(dir, 'flags-coerce.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: METADATA_SCHEMA_VERSION,
        workspaces: [{ id: 'w1', dir: '/c', displayName: 'c', lastOpenedAt: 1 }],
        threads: [
          // pinned is a truthy STRING, archived is a real boolean — only the boolean survives.
          { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 1, pinned: 'yes', archived: true },
        ],
      }),
    )
    const store = new MetadataStore({ filePath: file })
    await store.load()
    const rec = store.snapshot().threads.find((t) => t.id === 't1')
    expect(rec?.pinned).toBeUndefined() // non-boolean coerced away (not truthy-pinned)
    expect(rec?.archived).toBe(true)
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

describe('findThreadIdBySessionId (transcript routing)', () => {
  it('resolves the minted Thread id from its bound ACP sessionId, else null', async () => {
    const store = storeAt('session-lookup.json')
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/route' })
    const bound = await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-route' })
    // A Thread with no session yet must not match a null/absent lookup.
    await store.upsertThread({ workspaceId: ws.id })

    expect(store.findThreadIdBySessionId('sess-route')).toBe(bound.id)
    expect(store.findThreadIdBySessionId('no-such-session')).toBeNull()
    expect(store.findThreadIdBySessionId(null)).toBeNull()
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
