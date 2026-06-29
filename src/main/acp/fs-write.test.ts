import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleFsWriteTextFile, isPathWithin, type WriteTextFn } from './fs-write'

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
      content: 'vibe-monitor works.\n',
      sessionId: 's1',
    })

    expect(outcome).toEqual({ result: {} })
    expect(readFileSync(file, 'utf8')).toBe('vibe-monitor works.\n')
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

describe('isPathWithin', () => {
  it('accepts the dir itself and descendants, rejects siblings and parents', () => {
    expect(isPathWithin('/ws', '/ws')).toBe(true)
    expect(isPathWithin('/ws', '/ws/a/b.txt')).toBe(true)
    expect(isPathWithin('/ws', '/ws/../etc/passwd')).toBe(false)
    expect(isPathWithin('/ws', '/wsX/file')).toBe(false)
    expect(isPathWithin('/ws', '/etc/passwd')).toBe(false)
  })
})
