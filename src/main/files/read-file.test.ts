import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkspaceFile } from './read-file'

/**
 * The reader runs against REAL tmpdir fixtures (prior art: `list-files.test.ts`, the fs-write
 * suites) so the CONFINEMENT behavior — real symlinks, real out-of-tree targets — is exercised
 * against the actual `realpath` + `isWithinDir` machinery, not mocked. Every fixture dir is
 * tracked and removed after each test.
 */
const created: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, rel: string, content: string | Buffer = ''): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

describe('readWorkspaceFile — classify (cap, binary sniff, text)', () => {
  it('reads a utf8 text file as { kind: text }', async () => {
    const root = tmp('vibe-read-')
    write(root, 'src/app.ts', 'const x: number = 1\n')
    const result = await readWorkspaceFile(root, 'src/app.ts')
    expect(result).toEqual({ kind: 'text', content: 'const x: number = 1\n' })
  })

  it('preserves multibyte utf8 content exactly', async () => {
    const root = tmp('vibe-read-')
    write(root, 'note.md', '# héllo — café 🚀\n')
    const result = await readWorkspaceFile(root, 'note.md')
    expect(result).toEqual({ kind: 'text', content: '# héllo — café 🚀\n' })
  })

  it('classifies a file with a NUL byte in the first chunk as { kind: binary }', async () => {
    const root = tmp('vibe-read-')
    write(root, 'blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))
    const result = await readWorkspaceFile(root, 'blob.bin')
    expect(result).toEqual({ kind: 'binary' })
  })

  it('flags a file larger than the cap as { kind: tooLarge } (via stat, not by reading it)', async () => {
    const root = tmp('vibe-read-')
    write(root, 'big.txt', 'x'.repeat(2_048))
    const result = await readWorkspaceFile(root, 'big.txt', { maxBytes: 1_024 })
    expect(result).toEqual({ kind: 'tooLarge' })
  })

  it('reads a file exactly at the cap', async () => {
    const root = tmp('vibe-read-')
    write(root, 'edge.txt', 'y'.repeat(16))
    const result = await readWorkspaceFile(root, 'edge.txt', { maxBytes: 16 })
    expect(result).toEqual({ kind: 'text', content: 'y'.repeat(16) })
  })

  // #189 security review (size-cap TOCTOU): the BOUNDED read is authoritative, not stat. A file
  // that lies about its size (grew after stat, or a stat that under-reports) still can't exceed the
  // cap — the read stops at maxBytes+1 and reports tooLarge. Injected fs proves the read path alone
  // enforces it, independent of stat.size.
  it('caps by the bounded read even when stat under-reports the size (TOCTOU)', async () => {
    const realRoot = '/ws'
    const fs = {
      realpath: async (p: string) => p,
      // stat lies: reports 4 bytes (under the cap) though the file is really larger.
      stat: async () => ({ isFile: () => true, size: 4 }),
      // the actual file is 2048 bytes; a bounded read of limit returns exactly `limit` bytes.
      readBounded: async (_p: string, limit: number) => Buffer.alloc(Math.min(2_048, limit), 0x78),
    }
    const result = await readWorkspaceFile(realRoot, 'grew.txt', { maxBytes: 16, fs })
    expect(result).toEqual({ kind: 'tooLarge' })
  })

  it('reads an empty file as empty text', async () => {
    const root = tmp('vibe-read-')
    write(root, 'empty.txt', '')
    const result = await readWorkspaceFile(root, 'empty.txt')
    expect(result).toEqual({ kind: 'text', content: '' })
  })

  it('errors for a missing file', async () => {
    const root = tmp('vibe-read-')
    expect(await readWorkspaceFile(root, 'nope.txt')).toEqual({ kind: 'error' })
  })

  it('errors for a directory (must be a regular file)', async () => {
    const root = tmp('vibe-read-')
    write(root, 'dir/child.ts', '')
    expect(await readWorkspaceFile(root, 'dir')).toEqual({ kind: 'error' })
  })

  it('errors for an unreadable / missing Workspace root', async () => {
    expect(await readWorkspaceFile(join(tmpdir(), 'vibe-no-such-root-xyz'), 'a.txt')).toEqual({
      kind: 'error',
    })
  })
})

describe('readWorkspaceFile — confinement (out-of-tree refused, read-only)', () => {
  it('refuses a `..` traversal that escapes the Workspace root', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(outside, 'secret.txt', 'do not read')
    // The tree-relative path can never legitimately contain `..`, but a crafted one must be refused.
    expect(await readWorkspaceFile(root, '../' + join(outside).split('/').pop() + '/secret.txt')).toEqual({
      kind: 'error',
    })
  })

  it('refuses an absolute path pointing outside the Workspace', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(outside, 'secret.txt', 'do not read')
    expect(await readWorkspaceFile(root, join(outside, 'secret.txt'))).toEqual({ kind: 'error' })
  })

  it('refuses a symlink that escapes the Workspace root (never reads the outside target)', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(outside, 'secret.txt', 'TOP SECRET')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt')) // in-tree link pointing OUT
    const result = await readWorkspaceFile(root, 'escape.txt')
    expect(result).toEqual({ kind: 'error' })
    // Belt-and-suspenders: the outside content must never surface, whatever the kind.
    expect(JSON.stringify(result)).not.toContain('TOP SECRET')
  })

  it('reads a file reached through an IN-tree symlink (resolves within the root)', async () => {
    const root = tmp('vibe-ws-')
    write(root, 'real/data.txt', 'inside')
    symlinkSync(join(root, 'real', 'data.txt'), join(root, 'link.txt')) // link stays inside
    expect(await readWorkspaceFile(root, 'link.txt')).toEqual({ kind: 'text', content: 'inside' })
  })
})
