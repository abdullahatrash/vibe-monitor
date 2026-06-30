import { describe, it, expect } from 'vitest'
import { defaultBranchName, gitBranches, gitCheckout, gitCreateBranch, parseBranches } from './branches'
import type { GitRun } from './status'

/**
 * #87 branch ops. The testable seams are (1) the PURE `parseBranches` over real
 * `for-each-ref` text + a default name (parse, exclude origin/HEAD, dedupe, flags) and
 * (2) the checkout/create COMMAND args + failure mapping over an injected `GitRun` — no
 * test shells real git.
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

describe('parseBranches', () => {
  it('parses local + remote refs, marks the current branch, strips the ref prefixes', () => {
    const text = ['* refs/heads/main', '  refs/heads/feat/x', '  refs/remotes/origin/only-remote'].join('\n')
    expect(parseBranches(text, null)).toEqual([
      { name: 'main', isRemote: false, current: true, isDefault: false },
      { name: 'feat/x', isRemote: false, current: false, isDefault: false },
      { name: 'origin/only-remote', isRemote: true, current: false, isDefault: false },
    ])
  })

  it('drops a remote branch whose trailing name matches a LOCAL head (dedupe)', () => {
    const text = ['* refs/heads/main', '  refs/remotes/origin/main', '  refs/remotes/origin/feature'].join('\n')
    const branches = parseBranches(text, null)
    // origin/main is deduped (local main exists); origin/feature is remote-only -> kept.
    expect(branches.map((b) => b.name)).toEqual(['main', 'origin/feature'])
  })

  it('dedupes a multi-segment branch name too (origin/docs/x vs local docs/x)', () => {
    const text = ['  refs/heads/docs/x', '  refs/remotes/origin/docs/x', '  refs/remotes/origin/docs/y'].join('\n')
    const branches = parseBranches(text, null)
    expect(branches.map((b) => b.name)).toEqual(['docs/x', 'origin/docs/y'])
  })

  it('EXCLUDES the refs/remotes/*/HEAD symbolic pointer (not a branch)', () => {
    const text = ['  refs/remotes/origin/HEAD', '  refs/remotes/origin/foo'].join('\n')
    expect(parseBranches(text, null).map((b) => b.name)).toEqual(['origin/foo'])
  })

  it('marks isDefault for the local branch the default name points at', () => {
    const text = ['* refs/heads/main', '  refs/heads/dev'].join('\n')
    const branches = parseBranches(text, 'main')
    expect(branches.find((b) => b.name === 'main')?.isDefault).toBe(true)
    expect(branches.find((b) => b.name === 'dev')?.isDefault).toBe(false)
  })

  it('marks isDefault for a remote-only default (no local match)', () => {
    const text = ['* refs/heads/dev', '  refs/remotes/origin/main'].join('\n')
    const branches = parseBranches(text, 'main')
    // No local main, so origin/main stays AND is the default (trailing name matches).
    expect(branches.find((b) => b.name === 'origin/main')?.isDefault).toBe(true)
  })

  it('returns [] for empty / blank input', () => {
    expect(parseBranches('', null)).toEqual([])
    expect(parseBranches('\n\n', null)).toEqual([])
  })
})

describe('defaultBranchName', () => {
  it('extracts the trailing name from a symbolic-ref', () => {
    expect(defaultBranchName('refs/remotes/origin/main\n')).toBe('main')
    expect(defaultBranchName('refs/remotes/origin/feat/x\n')).toBe('feat/x')
  })

  it('returns null when unresolved / not a remote ref', () => {
    expect(defaultBranchName('')).toBeNull()
    expect(defaultBranchName('refs/heads/main')).toBeNull()
  })
})

describe('gitBranches', () => {
  it('runs for-each-ref (+ best-effort symbolic-ref) and returns the parsed branches', async () => {
    const seen: string[][] = []
    const run = fakeRun(seen, [
      { stdout: '* refs/heads/main\n  refs/remotes/origin/main\n  refs/remotes/origin/feature\n', code: 0 },
      { stdout: 'refs/remotes/origin/main\n', code: 0 },
    ])
    const result = await gitBranches('/repo', run)
    expect(seen[0]).toEqual([
      '-c',
      'core.quotePath=false',
      'for-each-ref',
      '--format=%(HEAD) %(refname)',
      'refs/heads',
      'refs/remotes',
    ])
    expect(seen[1]).toEqual(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    expect(result).toEqual({
      ok: true,
      branches: [
        { name: 'main', isRemote: false, current: true, isDefault: true },
        { name: 'origin/feature', isRemote: true, current: false, isDefault: false },
      ],
    })
  })

  it('still lists branches when the default-branch probe fails (no origin/HEAD)', async () => {
    const seen: string[][] = []
    const run = fakeRun(seen, [
      { stdout: '* refs/heads/main\n', code: 0 },
      { stderr: 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref', code: 1 },
    ])
    const result = await gitBranches('/repo', run)
    expect(result).toEqual({ ok: true, branches: [{ name: 'main', isRemote: false, current: true, isDefault: false }] })
  })

  it('a failing for-each-ref → {ok:false} carrying git’s reason', async () => {
    const run = fakeRun([], [{ stderr: 'fatal: not a git repository', code: 128 }])
    expect(await gitBranches('/repo', run)).toEqual({ ok: false, error: 'fatal: not a git repository' })
  })
})

describe('gitCheckout', () => {
  it('runs git switch <name> and returns {ok:true}', async () => {
    const seen: string[][] = []
    const result = await gitCheckout('/repo', 'feature', fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen[0]).toEqual(['-c', 'core.quotePath=false', 'switch', 'feature'])
  })

  it('passes the caller’s switch target verbatim (renderer pre-strips a remote prefix)', async () => {
    const seen: string[][] = []
    // The renderer hands the bare trailing name for a remote-only `origin/foo` -> DWIM.
    await gitCheckout('/repo', 'foo', fakeRun(seen))
    expect(seen[0]).toEqual(['-c', 'core.quotePath=false', 'switch', 'foo'])
  })

  it('a dirty-tree refusal → {ok:false} with git’s reason (NO data loss — git protects)', async () => {
    const run = fakeRun(
      [],
      [{ stderr: 'error: Your local changes to the following files would be overwritten by checkout:', code: 1 }],
    )
    expect(await gitCheckout('/repo', 'other', run)).toEqual({
      ok: false,
      error: 'error: Your local changes to the following files would be overwritten by checkout:',
    })
  })
})

describe('gitCreateBranch', () => {
  it('runs git switch -c <name> and returns {ok:true}', async () => {
    const seen: string[][] = []
    const result = await gitCreateBranch('/repo', 'feat/new', fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen[0]).toEqual(['-c', 'core.quotePath=false', 'switch', '-c', 'feat/new'])
  })

  it('a name collision → {ok:false} with git’s reason', async () => {
    const run = fakeRun([], [{ stderr: "fatal: a branch named 'dev' already exists", code: 128 }])
    expect(await gitCreateBranch('/repo', 'dev', run)).toEqual({
      ok: false,
      error: "fatal: a branch named 'dev' already exists",
    })
  })
})
