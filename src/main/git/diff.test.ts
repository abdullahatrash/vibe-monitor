import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { finalizeDiff, readGitDiff } from './diff'
import type { GitRun } from './status'

/**
 * The pure `finalizeDiff` (hash + cap) is the testable seam; `readGitDiff` is the thin
 * impure shell driven by a fake `GitRun` so no test shells real git. The fixtures below
 * are shaped like real `git diff` stdout (a tracked unified diff, an untracked
 * new-file `--no-index` diff). The `--no-index` exit-code-1-is-success behaviour and
 * the swallow-to-empty failure path are the two non-obvious bits worth pinning.
 */

const trackedPatch = `diff --git a/tracked.txt b/tracked.txt
index c0d0fb4..ed51eca 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,2 +1,3 @@
 line1
-line2
+CHANGED
+line3
`

const untrackedPatch = `diff --git a/untracked.txt b/untracked.txt
new file mode 100644
index 0000000..d82766f
--- /dev/null
+++ b/untracked.txt
@@ -0,0 +1,2 @@
+new file
+content
`

describe('finalizeDiff', () => {
  it('hashes the patch with sha256 and reports not-truncated for a small diff', () => {
    const res = finalizeDiff(trackedPatch)
    expect(res.patch).toBe(trackedPatch)
    expect(res.truncated).toBe(false)
    expect(res.diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
  })

  it('is a stable hash: same input → same diffHash', () => {
    expect(finalizeDiff(trackedPatch).diffHash).toBe(finalizeDiff(trackedPatch).diffHash)
  })

  it('different patches hash differently', () => {
    expect(finalizeDiff(trackedPatch).diffHash).not.toBe(finalizeDiff(untrackedPatch).diffHash)
  })

  it('returns the empty result for an empty patch (no diff)', () => {
    expect(finalizeDiff('')).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('caps the patch at the ~120 KB byte limit and flags truncated, hashing the CAPPED text', () => {
    const CAP = 120 * 1024
    const huge = 'x'.repeat(CAP + 5000)
    const res = finalizeDiff(huge)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.patch, 'utf8')).toBe(CAP)
    // The hash is of the CAPPED patch (what the renderer receives), not the full input.
    expect(res.diffHash).toBe(createHash('sha256').update(res.patch).digest('hex'))
    expect(res.diffHash).not.toBe(createHash('sha256').update(huge).digest('hex'))
  })

  it('caps BY BYTES, not chars (a multibyte file cannot smuggle past the cap)', () => {
    const CAP = 120 * 1024
    // '€' is 3 bytes in UTF-8 — a char-length cap would let ~3x the bytes through.
    const huge = '€'.repeat(CAP) // 3 * CAP bytes
    const res = finalizeDiff(huge)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.patch, 'utf8')).toBeLessThanOrEqual(CAP)
  })
})

describe('readGitDiff', () => {
  /** A fake runner that returns one canned response for any invocation, recording args. */
  function fakeRun(response: { stdout: string; code: number }, seen?: string[][]): GitRun {
    return (args) => {
      seen?.push(args)
      return Promise.resolve(response)
    }
  }

  it('reads a tracked file diff (exit 0) and returns the finalized patch', async () => {
    const seen: string[][] = []
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, fakeRun({ stdout: trackedPatch, code: 0 }, seen))
    expect(res.patch).toBe(trackedPatch)
    expect(res.diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    // tracked form: `diff --no-color -- <path>`, no `--no-index`, no `-w`.
    const args = seen[0]
    expect(args).toContain('--no-color')
    expect(args).not.toContain('--no-index')
    expect(args).not.toContain('-w')
    expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false'])
    expect(args.slice(-2)).toEqual(['--', 'tracked.txt'])
  })

  it('treats an untracked --no-index diff (exit 1) as SUCCESS, capturing stdout', async () => {
    const seen: string[][] = []
    const res = await readGitDiff('/repo', 'untracked.txt', true, false, fakeRun({ stdout: untrackedPatch, code: 1 }, seen))
    expect(res.patch).toBe(untrackedPatch)
    expect(res.truncated).toBe(false)
    // untracked form: `diff --no-color --no-index -- /dev/null <path>`.
    const args = seen[0]
    expect(args).toContain('--no-index')
    expect(args.slice(-3)).toEqual(['--', '/dev/null', 'untracked.txt'])
  })

  it('treats an untracked --no-index with NO diff (exit 0) as the empty result', async () => {
    const res = await readGitDiff('/repo', 'untracked.txt', true, false, fakeRun({ stdout: '', code: 0 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('swallows a real --no-index failure (exit > 1) into the empty result', async () => {
    const res = await readGitDiff('/repo', 'gone.txt', true, false, fakeRun({ stdout: 'fatal: bad', code: 128 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('swallows a tracked-diff failure (exit != 0) into the empty result', async () => {
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, fakeRun({ stdout: 'fatal: bad', code: 128 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('adds -w when ignoreWhitespace is set (both tracked and untracked forms)', async () => {
    const seenTracked: string[][] = []
    await readGitDiff('/repo', 'tracked.txt', false, true, fakeRun({ stdout: trackedPatch, code: 0 }, seenTracked))
    expect(seenTracked[0]).toContain('-w')

    const seenUntracked: string[][] = []
    await readGitDiff('/repo', 'untracked.txt', true, true, fakeRun({ stdout: untrackedPatch, code: 1 }, seenUntracked))
    expect(seenUntracked[0]).toContain('-w')
    expect(seenUntracked[0]).toContain('--no-index')
  })

  it('never throws — a runner that rejects degrades to the empty result', async () => {
    const throwingRun: GitRun = () => Promise.reject(new Error('spawn failed'))
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, throwingRun)
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })
})
