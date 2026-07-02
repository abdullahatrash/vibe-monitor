import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachment-store'

/**
 * The per-Thread prompt-image attachment files (ADR-0005 sibling of the JSONL
 * transcript). Exercised over a REAL temp dir via the injectable fs seam,
 * mirroring transcript.test.ts — no `userData`, no Electron.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-attachments-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A 1x1 PNG's bytes, as the bare base64 our IPC carries. */
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

function storeAt(): AttachmentStore {
  return new AttachmentStore({ dir })
}

describe('AttachmentStore saveAll', () => {
  it('writes <threadId>/<uuid>.<ext> and roundtrips through readAll as a data URL', async () => {
    const store = storeAt()
    const refs = await store.saveAll('thread-rt', [
      { data: PNG_B64, mimeType: 'image/png' },
      { data: PNG_B64, mimeType: 'image/jpeg' },
    ])

    expect(refs).toHaveLength(2)
    expect(refs[0].file).toMatch(/^[0-9a-f-]{36}\.png$/)
    expect(refs[0].mimeType).toBe('image/png')
    expect(refs[1].file).toMatch(/^[0-9a-f-]{36}\.jpg$/) // image/jpeg maps to .jpg
    expect(readdirSync(join(dir, 'thread-rt')).sort()).toEqual([refs[0].file, refs[1].file].sort())

    const all = await store.readAll('thread-rt')
    expect(all[refs[0].file]).toBe(`data:image/png;base64,${PNG_B64}`)
    expect(all[refs[1].file]).toBe(`data:image/jpeg;base64,${PNG_B64}`)
  })

  it('skips an unknown mime type and still persists the rest', async () => {
    const store = storeAt()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refs = await store.saveAll('thread-mime', [
      { data: PNG_B64, mimeType: 'image/tiff' },
      { data: PNG_B64, mimeType: 'image/png' },
    ])
    errSpy.mockRestore()

    expect(refs).toHaveLength(1)
    expect(refs[0].mimeType).toBe('image/png')
  })

  it('skips an image over the per-image cap and still persists the rest', async () => {
    const store = storeAt()
    const oversized = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refs = await store.saveAll('thread-cap', [
      { data: oversized, mimeType: 'image/png' },
      { data: PNG_B64, mimeType: 'image/png' },
    ])
    errSpy.mockRestore()

    expect(refs).toHaveLength(1)
    expect(readdirSync(join(dir, 'thread-cap'))).toEqual([refs[0].file])
  })

  it('a failing write skips ONLY that image and never rejects', async () => {
    let calls = 0
    const store = new AttachmentStore({
      dir,
      writeFile: async (path, data) => {
        calls += 1
        if (calls === 1) throw new Error('disk full')
        writeFileSync(path, data)
      },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refs = await store.saveAll('thread-fail', [
      { data: PNG_B64, mimeType: 'image/png' },
      { data: PNG_B64, mimeType: 'image/webp' },
    ])
    errSpy.mockRestore()

    expect(refs).toHaveLength(1)
    expect(refs[0].mimeType).toBe('image/webp')
  })

  it('refuses a malformed threadId with no fs writes', async () => {
    const writeFn = vi.fn()
    const store = new AttachmentStore({ dir, writeFile: writeFn, mkdir: vi.fn() })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const refs = await store.saveAll('../escape', [{ data: PNG_B64, mimeType: 'image/png' }])
    errSpy.mockRestore()

    expect(refs).toEqual([])
    expect(writeFn).not.toHaveBeenCalled()
  })
})

describe('AttachmentStore readAll', () => {
  it('a Thread with no attachments dir reads back {}', async () => {
    expect(await storeAt().readAll('thread-none')).toEqual({})
  })

  it('ignores foreign file names in the Thread dir', async () => {
    const store = storeAt()
    const refs = await store.saveAll('thread-foreign', [{ data: PNG_B64, mimeType: 'image/png' }])
    writeFileSync(join(dir, 'thread-foreign', 'evil.sh'), '#!/bin/sh')
    writeFileSync(join(dir, 'thread-foreign', 'notes.txt'), 'hi')

    const all = await store.readAll('thread-foreign')
    expect(Object.keys(all)).toEqual([refs[0].file])
  })

  it('omits an unreadable file but serves the rest', async () => {
    mkdirSync(join(dir, 'thread-torn'), { recursive: true })
    writeFileSync(join(dir, 'thread-torn', 'aaaa.png'), Buffer.from(PNG_B64, 'base64'))
    writeFileSync(join(dir, 'thread-torn', 'bbbb.png'), Buffer.from(PNG_B64, 'base64'))
    const store = new AttachmentStore({
      dir,
      readFile: async (path) => {
        if (path.endsWith('aaaa.png')) throw new Error('EIO')
        return Buffer.from(PNG_B64, 'base64')
      },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const all = await store.readAll('thread-torn')
    errSpy.mockRestore()

    expect(Object.keys(all)).toEqual(['bbbb.png'])
  })

  it('refuses a malformed threadId', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await storeAt().readAll('../../etc')).toEqual({})
    errSpy.mockRestore()
  })
})

describe('AttachmentStore delete', () => {
  it('removes the whole Thread dir; a missing dir is a no-op', async () => {
    const store = storeAt()
    await store.saveAll('thread-del', [{ data: PNG_B64, mimeType: 'image/png' }])
    expect(existsSync(join(dir, 'thread-del'))).toBe(true)

    await store.delete('thread-del')
    expect(existsSync(join(dir, 'thread-del'))).toBe(false)

    await expect(store.delete('thread-del')).resolves.toBeUndefined() // idempotent
  })

  it('a failing rm is swallowed (teardown never throws)', async () => {
    const store = new AttachmentStore({
      dir,
      rm: async () => {
        throw new Error('EPERM')
      },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(store.delete('thread-eperm')).resolves.toBeUndefined()
    errSpy.mockRestore()
  })
})
