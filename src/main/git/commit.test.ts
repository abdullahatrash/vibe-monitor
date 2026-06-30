import { describe, it, expect } from 'vitest'
import { gitCommit } from './commit'
import type { GitRun } from './status'

/**
 * `gitCommit` is the first git WRITE (#86). Its testable seam is the COMMAND SEQUENCE +
 * args over an injected `GitRun` — no test shells real git. We assert the exact staging
 * calls (subset vs all) and the failure mapping (git's reason, not a collapsed message).
 */

/** A fake runner: records every `args` and returns a per-call canned `{stdout,stderr,code}`. */
function fakeRun(
  seen: string[][],
  responses: { stdout?: string; stderr?: string; code: number }[] = [],
): GitRun {
  let i = 0
  return (args) => {
    seen.push(args)
    const r = responses[i++] ?? { code: 0 }
    return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code })
  }
}

describe('gitCommit', () => {
  it('subset: status (rename scan) → reset -q → add -- <paths> → commit -m, then {ok:true}', async () => {
    const seen: string[][] = []
    const result = await gitCommit('/repo', 'msg', ['a.txt', 'b.txt'], fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['-c', 'core.quotePath=false', 'status', '--porcelain=2'],
      ['reset', '-q'],
      ['add', '--', 'a.txt', 'b.txt'],
      ['-c', 'core.quotePath=false', 'commit', '-m', 'msg'],
    ])
  })

  it('subset with a selected staged RENAME stages BOTH the new path and its deleted origin', async () => {
    const seen: string[][] = []
    // porcelain-2 `2` rename entry: 9 leading fields then `<new>\t<orig>`.
    const porcelain = '2 R. N... 100644 100644 100644 1111111 2222222 R100 moved.txt\torig.txt\n'
    const result = await gitCommit('/repo', 'msg', ['moved.txt'], fakeRun(seen, [{ stdout: porcelain, code: 0 }]))
    expect(result).toEqual({ ok: true })
    // The add stages the new name AND the rename's deleted source — not just the add half.
    expect(seen).toContainEqual(['add', '--', 'moved.txt', 'orig.txt'])
  })

  it('all (empty paths): add -A → commit -m (NO reset / NO status scan), then {ok:true}', async () => {
    const seen: string[][] = []
    const result = await gitCommit('/repo', 'msg', [], fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['add', '-A'],
      ['-c', 'core.quotePath=false', 'commit', '-m', 'msg'],
    ])
  })

  it('passes a path containing spaces as a SINGLE argv element', async () => {
    const seen: string[][] = []
    await gitCommit('/repo', 'msg', ['my file.txt'], fakeRun(seen))
    // [0]=status scan, [1]=reset, [2]=add.
    expect(seen[2]).toEqual(['add', '--', 'my file.txt'])
  })

  it('failing commit → {ok:false} carrying git’s reason (from stdout)', async () => {
    const seen: string[][] = []
    const result = await gitCommit(
      '/repo',
      'msg',
      [],
      // add ok, commit fails with "nothing to commit" on STDOUT (git puts it there).
      fakeRun(seen, [{ code: 0 }, { stdout: 'nothing to commit, working tree clean', code: 1 }]),
    )
    expect(result).toEqual({ ok: false, error: 'nothing to commit, working tree clean' })
  })

  it('failing commit → surfaces a STDERR reason (e.g. a failed pre-commit hook)', async () => {
    const seen: string[][] = []
    const result = await gitCommit(
      '/repo',
      'msg',
      ['a.txt'],
      // status ok (no renames), reset ok, add ok, commit fails with a hook error on STDERR.
      fakeRun(seen, [{ code: 0 }, { code: 0 }, { code: 0 }, { stderr: 'pre-commit hook failed', code: 1 }]),
    )
    expect(result).toEqual({ ok: false, error: 'pre-commit hook failed' })
  })

  it('a failing stage step short-circuits (no commit) and reports the reason', async () => {
    const seen: string[][] = []
    const result = await gitCommit(
      '/repo',
      'msg',
      ['a.txt'],
      // status ok (rename scan), then reset fails — never reaches add / commit.
      fakeRun(seen, [{ code: 0 }, { stderr: 'fatal: could not reset', code: 128 }]),
    )
    expect(result).toEqual({ ok: false, error: 'fatal: could not reset' })
    expect(seen).toEqual([['-c', 'core.quotePath=false', 'status', '--porcelain=2'], ['reset', '-q']])
  })
})
