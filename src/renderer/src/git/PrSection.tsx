import { useEffect, useState, type JSX } from 'react'
import { GitPullRequest } from 'lucide-react'
import type { GhPr, GhPrResult } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { Button, Input, Textarea } from '../ui'

/**
 * The PR chip / Create-PR affordance (#88, slice 4) below the branch header. On a branch
 * change (and a manual refresh, via `refreshKey`) it fetches the current branch's GitHub
 * PR through `gh` (`ghCurrentPr` — a NETWORK call, so NOT tied to every status tick):
 *  - a PR exists → a compact, state-tinted chip rendered as an EXTERNAL anchor
 *    (`target="_blank"`): clicking it routes through main's `setWindowOpenHandler` ->
 *    `shell.openExternal`, opening the PR in the system browser (no new IPC).
 *  - no PR (and the branch is sensible — not detached, not the repo's default) → a
 *    "Create PR" affordance: a small title+body form -> `ghCreatePr`. GATED on the branch
 *    having an upstream (`hasUpstream`): `gh pr create` non-interactively can't prompt to
 *    push, so without an upstream we show "Push your branch first" instead of failing. The
 *    form is DISABLED while `busy` (a turn streams) — the same guard as commit/branch ops.
 *  - gh missing / not authed (`{ok:false}`) → a subtle muted hint, never a crash.
 * The default-branch check is a best-effort `gitBranches` probe (local, no network); when
 * it can't resolve a default, we simply allow Create-PR (gh would surface any real error).
 */
export function PrSection({
  workspaceDir,
  branch,
  detached,
  hasUpstream,
  busy,
  refreshKey,
}: {
  workspaceDir: string
  branch: string
  detached: boolean
  hasUpstream: boolean
  busy: boolean
  refreshKey: number
}): JSX.Element | null {
  // `'loading'` before the first fetch resolves; then the `GhPrResult`. Null only while
  // detached (no PR surface). The created-PR chip lands via a re-fetch after a create.
  const [result, setResult] = useState<GhPrResult | 'loading' | null>('loading')
  const [isDefault, setIsDefault] = useState(false)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (detached) {
      setResult(null)
      return
    }
    let cancelled = false
    setResult('loading')
    setCreating(false)
    setCreateError(null)
    void window.api.ghCurrentPr({ workspaceDir }).then((res) => {
      if (!cancelled) setResult(res)
    })
    // Best-effort default-branch probe (local git, no network): suppress Create-PR on the
    // repo's default branch. A failed/unresolved probe leaves `isDefault:false` (allow).
    void window.api.gitBranches({ workspaceDir }).then((res) => {
      if (cancelled) return
      setIsDefault(res.ok ? (res.branches.find((b) => b.current)?.isDefault ?? false) : false)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceDir, branch, detached, refreshKey])

  async function createPr(): Promise<void> {
    const t = title.trim()
    if (!t || busy || submitting) return
    setSubmitting(true)
    setCreateError(null)
    try {
      const res = await window.api.ghCreatePr({ workspaceDir, title: t, body: body.trim() })
      if (res.ok) {
        // Re-fetch so the freshly-created PR renders as the real chip (number/title/state);
        // the form closes. gh already printed the URL — the chip's anchor opens it.
        setCreating(false)
        setResult('loading')
        void window.api.ghCurrentPr({ workspaceDir }).then(setResult)
      } else {
        setCreateError(res.error)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Detached HEAD / before the first fetch: render nothing (no PR surface).
  if (detached || result === null) return null
  if (result === 'loading') {
    return <p className="border-b border-border-muted px-3 py-1.5 text-[11px] text-muted">Checking pull request…</p>
  }
  // gh missing / not authed / an unexpected gh failure: a subtle hint, not a crash.
  if (!result.ok) {
    return (
      <p className="border-b border-border-muted px-3 py-1.5 text-[11px] text-muted" title={result.error}>
        {result.error}
      </p>
    )
  }
  // A PR exists → the state-tinted chip, opened externally via target="_blank".
  if (result.pr) return <PrChip pr={result.pr} />

  // No PR: offer Create-PR only on a sensible branch (not the default). On the default
  // branch there's nothing to render.
  if (isDefault) return null

  return (
    <div className="border-b border-border-muted px-3 py-2">
      {!hasUpstream ? (
        // The push gate: `gh pr create` non-interactively can't prompt to push an
        // unpushed branch, and we never push on the user's behalf — so guide them first.
        <p className="text-[11px] text-muted">Push your branch to GitHub to open a pull request.</p>
      ) : !creating ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            // Prefill the title from the branch name — the common, editable starting point.
            setTitle(branch)
            setBody('')
            setCreateError(null)
            setCreating(true)
          }}
          disabled={busy}
          title={busy ? 'Agent is working…' : 'Create a pull request for this branch'}
          className="-mx-2 text-muted hover:text-accent-text"
        >
          <GitPullRequest className="size-3.5" aria-hidden />
          Create PR
        </Button>
      ) : (
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            aria-label="Pull request title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="PR title"
            disabled={busy || submitting}
            className="h-8 text-[13px]"
          />
          <Textarea
            aria-label="Pull request body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            disabled={busy || submitting}
            className="min-h-16 resize-y text-[13px]"
          />
          {createError && (
            <p className="text-[11px] text-bad" role="alert">
              {createError}
            </p>
          )}
          {busy && <p className="text-[11px] text-muted">Agent is working…</p>}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void createPr()}
              disabled={busy || submitting || title.trim().length === 0}
            >
              {submitting ? 'Creating…' : 'Create PR'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCreating(false)
                setCreateError(null)
              }}
              disabled={submitting}
              className="text-muted hover:text-accent-text"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A PR's chip accent by gh state — open reads positive, merged accent, closed negative. */
function prStateClass(state: string): string {
  const s = state.toUpperCase()
  if (s === 'MERGED') return 'text-accent-text'
  if (s === 'CLOSED') return 'text-bad'
  return 'text-ok' // OPEN (and any unknown) reads as live.
}

/**
 * The compact PR chip: `#<number> · <title>`, state-tinted, as an EXTERNAL anchor. The
 * `target="_blank"` + `rel="noreferrer"` makes Electron route the click through main's
 * `setWindowOpenHandler` -> `shell.openExternal`, opening the PR in the system browser
 * (no new IPC). `href` is the gh-provided PR URL.
 */
function PrChip({ pr }: { pr: GhPr }): JSX.Element {
  return (
    <div className="border-b border-border-muted px-3 py-2">
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        title={`#${pr.number} · ${pr.title} (${pr.state})`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-accent/10"
      >
        <GitPullRequest className={cn('size-3.5 shrink-0', prStateClass(pr.state))} aria-hidden />
        <span className={cn('shrink-0 font-medium tabular-nums', prStateClass(pr.state))}>#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate text-text">{pr.title}</span>
      </a>
    </div>
  )
}
