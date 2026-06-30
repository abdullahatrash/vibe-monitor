import { describe, it, expect } from 'vitest'
import {
  classifyGhError,
  ghCreatePr,
  ghCurrentPr,
  GH_NOT_AUTHED_MESSAGE,
  GH_NOT_FOUND,
  GH_NOT_FOUND_MESSAGE,
  GH_PUSH_FIRST_MESSAGE,
  mapCreate,
  mapPrView,
  parsePrJson,
  type GhRun,
} from './github'

/**
 * #88 gh PR surfacing. The testable seams are the PURE pieces — `parsePrJson` (the real
 * `gh pr view --json` shape), `classifyGhError` (the stderr -> category mapping verified
 * against real gh 2.74 output), and `mapPrView` / `mapCreate` (the outcome mapping) — plus
 * the `ghCurrentPr` / `ghCreatePr` COMMAND args + result over an injected `GhRun`. NO test
 * shells real gh, and NO test creates a real PR (the whole point of the fake runner).
 */

/** A fake gh runner: records every `args` and returns a per-call canned `{stdout,stderr,code}`. */
function fakeRun(seen: string[][], responses: { stdout?: string; stderr?: string; code: number }[] = []): GhRun {
  let i = 0
  return (args) => {
    seen.push(args)
    const r = responses[i++] ?? { code: 0 }
    return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code })
  }
}

describe('parsePrJson', () => {
  it('parses a real gh pr view --json object', () => {
    const json = JSON.stringify({ number: 42, state: 'OPEN', title: 'Add the thing', url: 'https://github.com/o/r/pull/42' })
    expect(parsePrJson(json)).toEqual({
      number: 42,
      title: 'Add the thing',
      url: 'https://github.com/o/r/pull/42',
      state: 'OPEN',
    })
  })

  it('returns null for empty / malformed / partial JSON (degrade, never throw)', () => {
    expect(parsePrJson('')).toBeNull()
    expect(parsePrJson('   ')).toBeNull()
    expect(parsePrJson('not json')).toBeNull()
    // Missing the required `url` field.
    expect(parsePrJson(JSON.stringify({ number: 1, title: 't', state: 'OPEN' }))).toBeNull()
  })
})

describe('classifyGhError', () => {
  it('classifies the no-PR stderr (the common case)', () => {
    expect(classifyGhError('no pull requests found for branch "feat/x"')).toBe('no-pr')
    expect(classifyGhError('no open pull requests found')).toBe('no-pr')
  })

  it('classifies an auth failure', () => {
    expect(classifyGhError('To get started with GitHub CLI, please run: gh auth login')).toBe('auth')
    expect(classifyGhError('You are not logged in to any GitHub hosts')).toBe('auth')
  })

  it('classifies a no-remote / non-GitHub repo', () => {
    expect(classifyGhError('no git remotes found')).toBe('no-remote')
    expect(classifyGhError('none of the git remotes configured for this repository point to a known GitHub host')).toBe(
      'no-remote',
    )
  })

  it('classifies an unpushed-branch error', () => {
    expect(classifyGhError('aborted: you must first push the current branch to a remote')).toBe('push')
  })

  it('does NOT mislabel a permission/other error as push (narrowed match)', () => {
    // A permission error mentions "push the branch" but isn't an unpushed-branch case —
    // must surface verbatim, not the "push first" hint (review fold).
    expect(classifyGhError('you do not have permission to push the branch to this repository')).toBe('other')
    expect(classifyGhError('aborted: operation cancelled by hook')).toBe('other')
  })

  it('falls back to other for an unrecognised reason', () => {
    expect(classifyGhError('GraphQL: Something exploded')).toBe('other')
  })
})

describe('mapPrView', () => {
  it('exit 0 -> the parsed PR', () => {
    const json = JSON.stringify({ number: 7, state: 'OPEN', title: 'T', url: 'https://github.com/o/r/pull/7' })
    expect(mapPrView(json, '', 0)).toEqual({ ok: true, pr: { number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', state: 'OPEN' } })
  })

  it('no-PR stderr -> {ok:true, pr:null} (NOT an error)', () => {
    expect(mapPrView('', 'no pull requests found for branch "feat/x"', 1)).toEqual({ ok: true, pr: null })
  })

  it('no-remote / non-GitHub -> {ok:true, pr:null}', () => {
    expect(mapPrView('', 'no git remotes found', 1)).toEqual({ ok: true, pr: null })
  })

  it('gh-not-found sentinel -> the install hint', () => {
    expect(mapPrView('', '', GH_NOT_FOUND)).toEqual({ ok: false, error: GH_NOT_FOUND_MESSAGE })
  })

  it('auth stderr -> the login hint', () => {
    expect(mapPrView('', 'gh auth login', 1)).toEqual({ ok: false, error: GH_NOT_AUTHED_MESSAGE })
  })

  it('any other failure -> gh stderr verbatim', () => {
    expect(mapPrView('', 'GraphQL: rate limited', 1)).toEqual({ ok: false, error: 'GraphQL: rate limited' })
  })
})

describe('mapCreate', () => {
  it('exit 0 -> the new PR URL (last url line, trimmed)', () => {
    const stdout = 'Creating pull request for feat/x into main\n\nhttps://github.com/o/r/pull/99\n'
    expect(mapCreate(stdout, '', 0)).toEqual({ ok: true, url: 'https://github.com/o/r/pull/99' })
  })

  it('gh-not-found sentinel -> the install hint', () => {
    expect(mapCreate('', '', GH_NOT_FOUND)).toEqual({ ok: false, error: GH_NOT_FOUND_MESSAGE })
  })

  it('auth failure -> the login hint', () => {
    expect(mapCreate('', 'gh auth login', 1)).toEqual({ ok: false, error: GH_NOT_AUTHED_MESSAGE })
  })

  it('unpushed branch -> the push-first hint', () => {
    expect(mapCreate('', 'aborted: you must first push the current branch', 1)).toEqual({
      ok: false,
      error: GH_PUSH_FIRST_MESSAGE,
    })
  })

  it('any other failure -> gh stderr verbatim', () => {
    expect(mapCreate('', 'pull request already exists', 1)).toEqual({ ok: false, error: 'pull request already exists' })
  })
})

describe('ghCurrentPr', () => {
  it('runs `pr view --json number,title,url,state` and maps the open PR', async () => {
    const seen: string[][] = []
    const json = JSON.stringify({ number: 5, state: 'OPEN', title: 'T', url: 'https://github.com/o/r/pull/5' })
    const res = await ghCurrentPr('/repo', fakeRun(seen, [{ stdout: json, code: 0 }]))
    expect(seen).toEqual([['pr', 'view', '--json', 'number,title,url,state']])
    expect(res).toEqual({ ok: true, pr: { number: 5, title: 'T', url: 'https://github.com/o/r/pull/5', state: 'OPEN' } })
  })

  it('maps the no-PR exit to {ok:true, pr:null}', async () => {
    const res = await ghCurrentPr('/repo', fakeRun([], [{ stderr: 'no pull requests found for branch "x"', code: 1 }]))
    expect(res).toEqual({ ok: true, pr: null })
  })

  it('never throws when the runner rejects', async () => {
    const rejecting: GhRun = () => Promise.reject(new Error('boom'))
    const res = await ghCurrentPr('/repo', rejecting)
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})

describe('ghCreatePr', () => {
  it('runs `pr create --title <t> --body <b>` (each value its own argv) and returns the URL', async () => {
    const seen: string[][] = []
    const res = await ghCreatePr(
      '/repo',
      { title: 'My title', body: 'My body' },
      fakeRun(seen, [{ stdout: 'https://github.com/o/r/pull/12\n', code: 0 }]),
    )
    expect(seen).toEqual([['pr', 'create', '--title', 'My title', '--body', 'My body']])
    expect(res).toEqual({ ok: true, url: 'https://github.com/o/r/pull/12' })
  })

  it('maps an unpushed-branch failure to the push-first hint', async () => {
    const res = await ghCreatePr(
      '/repo',
      { title: 't', body: '' },
      fakeRun([], [{ stderr: 'aborted: you must first push the current branch', code: 1 }]),
    )
    expect(res).toEqual({ ok: false, error: GH_PUSH_FIRST_MESSAGE })
  })

  it('never throws when the runner rejects', async () => {
    const rejecting: GhRun = () => Promise.reject(new Error('spawn fail'))
    const res = await ghCreatePr('/repo', { title: 't', body: 'b' }, rejecting)
    expect(res).toEqual({ ok: false, error: 'spawn fail' })
  })
})
