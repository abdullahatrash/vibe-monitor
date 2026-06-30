import { describe, it, expect } from 'vitest'
import { parseGitStatus, readGitStatus, type GitRun } from './status'

/**
 * The parser is the pure seam — fixtures are VERBATIM from real `git status
 * --porcelain=2 --branch` / `git diff --numstat` on a dirty repo (the mix below was
 * captured from an actual rename + binary + staged + untracked working tree).
 * `readGitStatus` is driven by a fake `GitRun` so no test shells real git.
 */

// A clean repo: branch headers only, no entries (no upstream → no branch.ab).
const cleanPorcelain = `# branch.oid a1288794444eca02ae7d00d2ae055d42b3c1d8ef
# branch.head main
`

// modified-unstaged binary + staged-rename-then-modified + staged-add + untracked.
const mixPorcelain = `# branch.oid a1288794444eca02ae7d00d2ae055d42b3c1d8ef
# branch.head main
1 .M N... 100644 100644 100644 13122a653aac3d3777f545403322976a77cc5b53 13122a653aac3d3777f545403322976a77cc5b53 image.bin
2 RM N... 100644 100644 100644 83db48f84ec878fbfb30b46d16630e944e34f205 83db48f84ec878fbfb30b46d16630e944e34f205 R100 renamed.txt\ttracked.txt
1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 393d6dd7190959cece20cd7d77278332fa592633 staged_new.txt
? untracked.txt
`
const mixNumstat = `-\t-\timage.bin
2\t1\trenamed.txt
`
const mixCachedNumstat = `0\t0\ttracked.txt => renamed.txt
1\t0\tstaged_new.txt
`

describe('parseGitStatus', () => {
  it('parses a clean repo: branch set, no files, no upstream', () => {
    const status = parseGitStatus(cleanPorcelain, '', '')
    expect(status).toEqual({
      isRepo: true,
      branch: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
    })
  })

  it('parses a modified + staged + untracked + renamed mix with merged numstat', () => {
    const status = parseGitStatus(mixPorcelain, mixNumstat, mixCachedNumstat)
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    const byPath = Object.fromEntries(status.files.map((f) => [f.path, f]))

    // Worktree-modified binary: X='.', unstaged, churn 0/0 (binary `-` numstat).
    expect(byPath['image.bin']).toEqual({
      path: 'image.bin',
      status: '.M',
      insertions: 0,
      deletions: 0,
      staged: false,
      untracked: false,
    })
    // Staged rename, further worktree-modified: X='R' => staged; churn sums the
    // unstaged (2/1) + cached (0/0) numstat under the NEW path.
    expect(byPath['renamed.txt']).toEqual({
      path: 'renamed.txt',
      status: 'RM',
      insertions: 2,
      deletions: 1,
      staged: true,
      untracked: false,
    })
    // Staged add: X='A' => staged; churn from cached numstat (1/0).
    expect(byPath['staged_new.txt']).toEqual({
      path: 'staged_new.txt',
      status: 'A.',
      insertions: 1,
      deletions: 0,
      staged: true,
      untracked: false,
    })
    // Untracked: '?' line.
    expect(byPath['untracked.txt']).toEqual({
      path: 'untracked.txt',
      status: '?',
      insertions: 0,
      deletions: 0,
      staged: false,
      untracked: true,
    })
  })

  it('parses ahead/behind from branch.ab when an upstream is set', () => {
    const porcelain = `# branch.head main
# branch.upstream origin/main
# branch.ab +2 -3
`
    const status = parseGitStatus(porcelain, '', '')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
  })

  it('reports a null branch when HEAD is detached', () => {
    const status = parseGitStatus('# branch.head (detached)\n', '', '')
    expect(status.branch).toBeNull()
  })

  it('handles a path containing spaces (porcelain=2 leaves it unquoted)', () => {
    const porcelain = '1 .M N... 100644 100644 100644 00 00 my file.txt\n'
    const status = parseGitStatus(porcelain, '5\t2\tmy file.txt\n', '')
    expect(status.files[0]).toMatchObject({ path: 'my file.txt', insertions: 5, deletions: 2 })
  })
})

describe('readGitStatus', () => {
  // A fake runner keyed off the git SUBCOMMAND — skips leading `-c <value>` config
  // pairs (e.g. `-c core.quotePath=false`) so the key is `status`/`diff`, not `-c`.
  function fakeRun(
    responses: Record<string, { stdout: string; code: number }>,
    seen?: string[][],
  ): GitRun {
    return (args) => {
      seen?.push(args)
      let i = 0
      while (args[i] === '-c') i += 2
      const sub = args[i]
      const key = sub === 'diff' && args.includes('--cached') ? 'diff:cached' : sub
      return Promise.resolve(responses[key] ?? { stdout: '', code: 0 })
    }
  }

  it('passes -c core.quotePath=false to the path-emitting commands (non-ASCII names)', async () => {
    const seen: string[][] = []
    await readGitStatus(
      '/repo',
      fakeRun(
        {
          'rev-parse': { stdout: 'true\n', code: 0 },
          status: { stdout: mixPorcelain, code: 0 },
          diff: { stdout: mixNumstat, code: 0 },
          'diff:cached': { stdout: mixCachedNumstat, code: 0 },
        },
        seen,
      ),
    )
    const pathCmds = seen.filter((a) => a.includes('status') || a.includes('diff'))
    expect(pathCmds.length).toBe(3)
    for (const a of pathCmds) {
      expect(a.slice(0, 2)).toEqual(['-c', 'core.quotePath=false'])
    }
  })

  it('returns isRepo:false when rev-parse is non-zero (not a repo / no git)', async () => {
    const status = await readGitStatus('/nope', fakeRun({ 'rev-parse': { stdout: '', code: 128 } }))
    expect(status).toEqual({ isRepo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] })
  })

  it('reads + parses a repo via the injected runner', async () => {
    const status = await readGitStatus(
      '/repo',
      fakeRun({
        'rev-parse': { stdout: 'true\n', code: 0 },
        status: { stdout: mixPorcelain, code: 0 },
        diff: { stdout: mixNumstat, code: 0 },
        'diff:cached': { stdout: mixCachedNumstat, code: 0 },
      }),
    )
    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.files).toHaveLength(4)
  })

  it('swallows a non-zero status command into isRepo:false (never throws)', async () => {
    const status = await readGitStatus(
      '/repo',
      fakeRun({
        'rev-parse': { stdout: 'true\n', code: 0 },
        status: { stdout: '', code: 1 },
      }),
    )
    expect(status.isRepo).toBe(false)
  })
})
