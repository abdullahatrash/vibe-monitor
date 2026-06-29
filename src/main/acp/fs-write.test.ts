import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleFsWriteTextFile, isPathWithin, secureWriteWithinRoot, type WriteTextFn } from './fs-write'

/**
 * Seam C: the `fs/write_text_file` handler main uses to serve the agent's
 * write requests after the user approves (docs/acp-capture.md §5, §7). We
 * exercise it over a real temp dir, assert it replies `{}`, and that the TB3
 * Workspace confinement rejects paths that escape the Workspace.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-fs-write-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('handleFsWriteTextFile (Seam C)', () => {
  it('writes the file and returns {} (real fs)', async () => {
    const file = join(dir, 'note.txt')

    const outcome = await handleFsWriteTextFile({
      path: file,
      content: 'vibe-mistro works.\n',
      sessionId: 's1',
    })

    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(file, 'utf8')).toBe('vibe-mistro works.\n')
  })

  it('confines writes to the Workspace dir: rejects an escaping path without writing', async () => {
    let wrote = false
    const write: WriteTextFn = async () => {
      wrote = true
    }
    const outcome = await handleFsWriteTextFile(
      { path: '/etc/passwd', content: 'pwned', sessionId: 's1' },
      { write, workspaceDir: dir },
    )

    expect('error' in outcome).toBe(true)
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(-32602)
      expect(outcome.error.message).toMatch(/escapes the Workspace/)
    }
    expect(wrote).toBe(false)
  })

  it('rejects a traversal path that climbs out of the Workspace', async () => {
    const outcome = await handleFsWriteTextFile(
      { path: join(dir, '..', 'escape.txt'), content: 'x' },
      { workspaceDir: dir },
    )
    expect('error' in outcome).toBe(true)
  })

  it('allows a write inside the Workspace dir', async () => {
    const outcome = await handleFsWriteTextFile(
      { path: join(dir, 'nested', '..', 'inside.txt'), content: 'ok' },
      { workspaceDir: dir },
    )
    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(join(dir, 'inside.txt'), 'utf8')).toBe('ok')
  })

  it('errors (not throws) on a missing path or content param', async () => {
    expect('error' in (await handleFsWriteTextFile({ content: 'x' }))).toBe(true)
    expect('error' in (await handleFsWriteTextFile({ path: '/abs' }))).toBe(true)
  })

  it('returns an error result when the writer throws', async () => {
    const write: WriteTextFn = async () => {
      throw new Error('EACCES: permission denied')
    }
    const outcome = await handleFsWriteTextFile({ path: join(dir, 'x.txt'), content: 'x' }, { write })
    expect('error' in outcome).toBe(true)
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(-32603)
      expect(outcome.error.message).toMatch(/EACCES/)
    }
  })
})

/**
 * Symlink confinement (#8 / ADR-0004): a lexical check trusts symlinks, so a
 * link *inside* the Workspace pointing out is a real write-escape. The check
 * must resolve real paths (realpath of the nearest existing ancestor, since the
 * target file may not exist yet). Exercised against REAL temp dirs + symlinks.
 */
describe('handleFsWriteTextFile — symlink confinement (#8)', () => {
  it('rejects a write through an in-Workspace symlink that escapes, without writing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'vibe-outside-'))
    // A symlink INSIDE the Workspace pointing OUT — lexically `evil/secret.txt`
    // looks contained, but it resolves outside.
    symlinkSync(outside, join(ws, 'evil'))

    let wrote = false
    const write: WriteTextFn = async () => {
      wrote = true
    }
    const outcome = await handleFsWriteTextFile(
      { path: join(ws, 'evil', 'secret.txt'), content: 'pwned' },
      { write, workspaceDir: ws },
    )

    expect('error' in outcome).toBe(true)
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(-32602)
      expect(outcome.error.message).toMatch(/escapes the Workspace/)
    }
    expect(wrote).toBe(false)

    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('rejects a `..` that climbs out THROUGH a symlink (raw uncollapsed path)', async () => {
    // base/{workspace, outside}; workspace/link -> outside.
    const base = mkdtempSync(join(tmpdir(), 'vibe-base-'))
    const ws = join(base, 'workspace')
    const outside = join(base, 'outside')
    mkdirSync(ws)
    mkdirSync(outside)
    symlinkSync(outside, join(ws, 'link'))

    // RAW string concat (NOT path.join/resolve) so the `..` is NOT collapsed at
    // construction — exactly as the agent's JSON-RPC string arrives. The kernel
    // follows link -> outside, THEN applies `..` -> base, landing at base/pwned.txt.
    const attack = ws + '/link/../pwned.txt'

    const outcome = await handleFsWriteTextFile({ path: attack, content: 'pwned' }, { workspaceDir: ws })

    expect('error' in outcome).toBe(true)
    if ('error' in outcome) expect(outcome.error.code).toBe(-32602)
    // Nothing may land outside the Workspace.
    expect(existsSync(join(base, 'pwned.txt'))).toBe(false)
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)

    rmSync(base, { recursive: true, force: true })
  })

  it('allows a `..` that stays within the Workspace (between existing dirs)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    mkdirSync(join(ws, 'a'))
    mkdirSync(join(ws, 'b'))
    // a/../b/note.txt resolves to b/note.txt — inside the Workspace.
    const outcome = await handleFsWriteTextFile(
      { path: ws + '/a/../b/note.txt', content: 'ok' },
      { workspaceDir: ws },
    )
    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(join(ws, 'b', 'note.txt'), 'utf8')).toBe('ok')

    rmSync(ws, { recursive: true, force: true })
  })

  it('allows a not-yet-existing file in an existing in-Workspace subdir', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    mkdirSync(join(ws, 'sub'))

    const outcome = await handleFsWriteTextFile(
      { path: join(ws, 'sub', 'new.txt'), content: 'ok' },
      { workspaceDir: ws },
    )

    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(join(ws, 'sub', 'new.txt'), 'utf8')).toBe('ok')

    rmSync(ws, { recursive: true, force: true })
  })

  it('allows a normal write when the Workspace root itself is reached via a symlink', async () => {
    const realRoot = mkdtempSync(join(tmpdir(), 'vibe-realroot-'))
    const linkRoot = `${realRoot}-link`
    symlinkSync(realRoot, linkRoot) // linkRoot -> realRoot

    // Both the Workspace root and the target are realpath-resolved, so a write
    // inside a symlinked Workspace is NOT falsely rejected.
    const outcome = await handleFsWriteTextFile(
      { path: join(linkRoot, 'file.txt'), content: 'ok' },
      { workspaceDir: linkRoot },
    )

    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(join(realRoot, 'file.txt'), 'utf8')).toBe('ok')

    rmSync(realRoot, { recursive: true, force: true })
    rmSync(linkRoot, { force: true })
  })
})

/**
 * #21 — O_NOFOLLOW write-through-fd hardening. Two write-escape gaps the #8
 * confinement (realpath-then-write-by-path) leaves open, exercised against REAL
 * temp dirs + real symlinks. Attack paths use RAW string concat — never
 * path.join/resolve, which collapse `..` and HIDE the symlink (the #8 lesson).
 */
describe('handleFsWriteTextFile — #21 O_NOFOLLOW write hardening', () => {
  it('refuses a write whose final component is a PRE-EXISTING dangling symlink out of the Workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'vibe-outside-'))
    // Final component `ws/evil.txt` is a symlink to an as-yet-NONEXISTENT target
    // outside the Workspace. realpath throws on a dangling link, so #8's
    // resolveLikeKernel leaves it literal — an in-Workspace-LOOKING path that
    // passes confinement — and a path-based writeFile then FOLLOWS the link and
    // creates the file OUTSIDE the Workspace.
    const outsideTarget = outside + '/evil.txt'
    symlinkSync(outsideTarget, join(ws, 'evil.txt'))

    const outcome = await handleFsWriteTextFile(
      { path: ws + '/evil.txt', content: 'pwned' },
      { workspaceDir: ws },
    )

    expect('error' in outcome).toBe(true)
    expect(existsSync(outsideTarget)).toBe(false)

    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
})

/**
 * Direct unit tests of the through-fd writer. These simulate the TOCTOU outcome
 * by PLANTING the symlink in place of a (would-be) validated component before
 * the write, then asserting O_NOFOLLOW refuses it and nothing lands outside.
 */
describe('secureWriteWithinRoot (#21)', () => {
  it('refuses when an INTERMEDIATE component is a symlink out of the root (ELOOP)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'vibe-outside-'))
    // `ws/sub` is replaced (in place) by a symlink to `outside`. A path-based
    // write to ws/sub/file.txt would follow it; the through-fd walk opens `sub`
    // with O_NOFOLLOW|O_DIRECTORY and fails with ELOOP.
    symlinkSync(outside, join(ws, 'sub'))

    await expect(secureWriteWithinRoot(ws, ws + '/sub/file.txt', 'pwned')).rejects.toThrow()
    expect(existsSync(outside + '/file.txt')).toBe(false)

    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('refuses when the FINAL component is a symlink out of the root (ELOOP)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'vibe-outside-'))
    symlinkSync(outside + '/file.txt', join(ws, 'file.txt'))

    await expect(secureWriteWithinRoot(ws, ws + '/file.txt', 'pwned')).rejects.toThrow()
    expect(existsSync(outside + '/file.txt')).toBe(false)

    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('throws when the target is not within the root', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    const outside = mkdtempSync(join(tmpdir(), 'vibe-outside-'))

    await expect(secureWriteWithinRoot(ws, outside + '/file.txt', 'x')).rejects.toThrow()
    expect(existsSync(outside + '/file.txt')).toBe(false)

    rmSync(ws, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('writes a new file in a nested in-Workspace subdir and overwrites an existing file', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vibe-ws-'))
    mkdirSync(join(ws, 'a'))
    mkdirSync(join(ws, 'a', 'b'))

    await secureWriteWithinRoot(ws, join(ws, 'a', 'b', 'new.txt'), 'first')
    expect(readFileSync(join(ws, 'a', 'b', 'new.txt'), 'utf8')).toBe('first')

    // Overwriting an existing regular file truncates + rewrites.
    await secureWriteWithinRoot(ws, join(ws, 'a', 'b', 'new.txt'), 'second')
    expect(readFileSync(join(ws, 'a', 'b', 'new.txt'), 'utf8')).toBe('second')

    rmSync(ws, { recursive: true, force: true })
  })
})

describe('isPathWithin', () => {
  it('accepts the dir itself and descendants, rejects siblings and parents', () => {
    expect(isPathWithin('/ws', '/ws')).toBe(true)
    expect(isPathWithin('/ws', '/ws/a/b.txt')).toBe(true)
    expect(isPathWithin('/ws', '/ws/../etc/passwd')).toBe(false)
    expect(isPathWithin('/ws', '/wsX/file')).toBe(false)
    expect(isPathWithin('/ws', '/etc/passwd')).toBe(false)
  })
})
