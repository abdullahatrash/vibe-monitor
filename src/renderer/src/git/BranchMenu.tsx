import { useState, type JSX } from 'react'
import { Check, ChevronDown, GitBranch } from 'lucide-react'
import type { GitBranch as GitBranchInfo } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { Button, Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui'

/**
 * The branch header dropdown (#87): the current branch name as a base-ui Menu trigger
 * that, ON OPEN, fetches the Workspace's branches (`gitBranches`) and lists them for a
 * one-click checkout (`gitCheckout`); a "Create branch…" item reveals an inline input
 * (`gitCreateBranch`). The ahead/behind indicator stays beside the trigger (unchanged).
 *
 * Disabled while `busy` (a turn streams) — the same guard as commit: we don't switch
 * branches under the agent mid-turn (a switch rewrites the working tree). A checkout /
 * create error surfaces inline + recoverable (the common one is git's dirty-tree
 * refusal — NO data loss, git protects). The status STREAM updates the header on a
 * successful switch (main re-reads after the op), so this holds no branch-name state.
 */
export function BranchMenu({
  workspaceDir,
  branch,
  ahead,
  behind,
  busy,
}: {
  workspaceDir: string
  branch: string
  ahead: number
  behind: number
  busy: boolean
}): JSX.Element {
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // The recoverable error from a checkout / create (dirty-tree refusal, name collision).
  const [opError, setOpError] = useState<string | null>(null)
  // The inline "Create branch…" affordance: revealed by the menu item, below the header.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busyOp, setBusyOp] = useState(false)

  // Fetch the branch list each time the menu opens, so it reflects branches created out
  // of band (a terminal `git branch`, the agent) without a panel-wide subscription.
  async function loadBranches(): Promise<void> {
    setLoading(true)
    setListError(null)
    try {
      const result = await window.api.gitBranches({ workspaceDir })
      if (result.ok) setBranches(result.branches)
      else {
        setBranches([])
        setListError(result.error)
      }
    } finally {
      setLoading(false)
    }
  }

  async function checkout(name: string): Promise<void> {
    if (busy || busyOp) return
    setBusyOp(true)
    setOpError(null)
    try {
      // Pass the branch's FULL name + `track`: a remote-only `<remote>/<branch>` goes
      // through `git switch --track` (an unambiguous tracking-local create — robust even
      // with two remotes sharing a trailing name); a local name (which may contain `/`,
      // e.g. `feat/x`) switches verbatim. `info.isRemote` decides.
      const info = branches?.find((b) => b.name === name)
      const result = await window.api.gitCheckout({ workspaceDir, name, track: info?.isRemote ?? false })
      // On success the streamed status refresh updates the header to the new branch.
      if (!result.ok) setOpError(result.error)
    } finally {
      setBusyOp(false)
    }
  }

  async function createBranch(): Promise<void> {
    const name = newName.trim()
    if (!name || busy || busyOp) return
    setBusyOp(true)
    setOpError(null)
    try {
      const result = await window.api.gitCreateBranch({ workspaceDir, name })
      if (result.ok) {
        // The header updates via the streamed status refresh; clear + close the input.
        setNewName('')
        setCreating(false)
      } else {
        setOpError(result.error)
      }
    } finally {
      setBusyOp(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1.5 border-b border-border-muted px-3 py-2 text-[13px] text-muted">
        <Menu
          onOpenChange={(open) => {
            if (open) void loadBranches()
          }}
        >
          <MenuTrigger
            disabled={busy}
            title={busy ? 'Agent is working…' : branch}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
              'hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
            )}
          >
            <GitBranch size={14} aria-hidden className="shrink-0" />
            <span className="min-w-0 flex-1 truncate font-medium text-text">{branch}</span>
            <ChevronDown size={13} aria-hidden className="shrink-0" />
          </MenuTrigger>
          <MenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-1.5 text-sm text-muted">Loading…</div>
            ) : listError ? (
              <div className="px-3 py-1.5 text-sm text-bad">{listError}</div>
            ) : branches && branches.length > 0 ? (
              branches.map((b) => (
                <MenuItem key={b.name} onClick={() => void checkout(b.name)} disabled={b.current}>
                  <Check size={13} aria-hidden className={cn('shrink-0', b.current ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.isRemote && <span className="shrink-0 text-[10px] uppercase text-muted">remote</span>}
                </MenuItem>
              ))
            ) : (
              <div className="px-3 py-1.5 text-sm text-muted">No branches.</div>
            )}
            <MenuSeparator className="my-1 h-px bg-border-muted" />
            <MenuItem onClick={() => setCreating(true)}>
              <span className="w-3 shrink-0" aria-hidden />
              Create branch…
            </MenuItem>
          </MenuContent>
        </Menu>
        {(ahead > 0 || behind > 0) && (
          <span className="shrink-0 tabular-nums" title={`${ahead} ahead, ${behind} behind`}>
            {ahead > 0 && <>↑{ahead}</>}
            {ahead > 0 && behind > 0 && ' '}
            {behind > 0 && <>↓{behind}</>}
          </span>
        )}
      </div>

      {creating && (
        <div className="flex items-center gap-1.5 border-b border-border-muted px-3 py-2">
          <Input
            autoFocus
            aria-label="New branch name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New branch name"
            disabled={busy || busyOp}
            className="h-8 min-w-0 flex-1 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void createBranch()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setCreating(false)
                setNewName('')
                setOpError(null)
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void createBranch()}
            disabled={busy || busyOp || newName.trim().length === 0}
          >
            Create
          </Button>
        </div>
      )}

      {opError && (
        <p className="border-b border-border-muted px-3 py-2 text-[11px] text-bad" role="alert">
          {opError}
        </p>
      )}
    </>
  )
}
