import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleFsReadTextFile, type ReadTextFn } from './fs-read'

/**
 * Seam C: the `fs/read_text_file` handler that main uses to serve the agent's
 * read requests so read-only prompts don't stall (docs/acp-capture.md §5).
 * We exercise it over a real temp file and over an injected failing reader.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-fs-read-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('handleFsReadTextFile (Seam C)', () => {
  it('returns {content} for a readable path (real fs)', async () => {
    const file = join(dir, 'note.txt')
    writeFileSync(file, 'vibe-mistro works.\n')

    const outcome = await handleFsReadTextFile({
      path: file,
      limit: 2001,
      sessionId: 's1',
    })

    expect(outcome).toEqual({ result: { content: 'vibe-mistro works.\n' } })
  })

  it('returns an error result for an unreadable path', async () => {
    const outcome = await handleFsReadTextFile({ path: join(dir, 'does-not-exist.txt') })

    expect('error' in outcome).toBe(true)
    if ('error' in outcome) {
      expect(outcome.error.code).toBe(-32603)
      expect(outcome.error.message).toMatch(/ENOENT|no such file/i)
    }
  })

  it('errors (not throws) on a missing path param', async () => {
    const outcome = await handleFsReadTextFile({ sessionId: 's1' })
    expect('error' in outcome).toBe(true)
    if ('error' in outcome) expect(outcome.error.code).toBe(-32602)
  })

  it('applies a line limit when provided (injected reader)', async () => {
    const reader: ReadTextFn = async () => 'l1\nl2\nl3\nl4\nl5'
    const outcome = await handleFsReadTextFile({ path: '/abs', limit: 2 }, reader)
    expect(outcome).toEqual({ result: { content: 'l1\nl2' } })
  })
})
