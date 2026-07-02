import { useRef, useState, type JSX } from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Ellipsis,
  Folder,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react'
import type { ListMetadataResult, ThreadMeta } from '../../../../shared/ipc'
import type { NavState } from '../nav-reducer'
import {
  deriveUnifiedThreads,
  isThreadDeletable,
  orderByPin,
  partitionArchived,
  type UnifiedThreadRow,
} from '../unified-threads'
import { getOpenProjects, setOpenProjects } from '../project-open-store'
import { getSortOrder, setSortOrder, sortWorkspaces, type WorkspaceSortOrder } from '../workspace-sort'
import { normalizeRename } from '../rename'
import { formatRelativeTime } from '../relative-time'
import { visibleRows } from '../show-more'
import { LogoSnakeSpinner } from '../logo-snake-spinner'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { cn } from '../../lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog'
import { IconButton } from '../../ui/icon-button'
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../../ui/menu'
import { NavItem } from '../../ui/nav-item'
import { Spinner } from '../../ui/spinner'

/** A Workspace's rolled-up live status, shown on its collapsible project header. */
export interface WorkspaceFlags {
  streaming: boolean
  needsAttention: boolean
}

/** Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive). */
export type SetThreadFlags = (threadId: string, flags: { pinned?: boolean; archived?: boolean }) => void

/** Rename a Thread (inline sidebar edit) — App persists it + syncs vibe-acp if live. */
export type RenameThread = (thread: ThreadMeta, title: string) => void

/**
 * The per-Thread-row action bundle, threaded verbatim from App through WorkspaceNav →
 * ProjectRow → NavThread / ArchivedSection as ONE explicit `actions` prop (no context).
 * These are the callbacks the sidebar's rows invoke: opening / deleting / flagging /
 * renaming a Thread, plus the per-project new-thread and remove-project actions.
 */
export interface ThreadRowActions {
  /** Select a Thread — App pins it in nav and (if live) remembers it as active. */
  selectThread: (workspaceId: string, threadId: string) => void
  /** Start a new thread in a SPECIFIC project (#138 per-project ＋) — connect-if-needed. */
  newThreadInWorkspace: (workspaceId: string) => void
  /** Delete a Thread (TB6) — main tears down any live session, then the list refreshes. */
  deleteThread: (thread: ThreadMeta) => Promise<void>
  /** Remove a Workspace ("Remove project") — main stops its agent + drops our records (no disk delete). */
  removeWorkspace: (workspaceId: string) => void | Promise<void>
  /** Pin/archive a Thread (#132/#133) — a safe metadata toggle on any row. */
  setThreadFlags: SetThreadFlags
  /** Rename a Thread (#) — inline sidebar edit; App persists + syncs vibe-acp if live. */
  renameThread: RenameThread
}

/** How many thread rows each project shows before "Show more" (#113/#138). */
const THREAD_CAP = 5

/** A stable empty live-set for a NON-active project's cold-only derivation (no re-alloc). */
const NO_LIVE_THREAD_IDS: ReadonlySet<string> = new Set()
/** A stable empty status map for a NON-active project — its rollup lives on the header. */
const NO_STATUSES = {} as const

/**
 * The sidebar's Projects section (= Workspaces): an **all-visible collapsible list**
 * (#138, superseding #128's switcher dropdown). Every Workspace stays VISIBLE as a
 * row that independently FOLDS its own Thread list (base-ui `Collapsible`); multiple
 * can be open at once.
 *
 * Folding is **peek-only** — a header row's `CollapsibleTrigger` ONLY toggles the
 * fold; it NEVER selects or connects the project (no agent is spawned). A project
 * goes live only by opening one of its Threads (`actions.selectThread` — the existing
 * live/cold-Continue flow, unchanged) or via its per-project ＋ (`actions.newThreadInWorkspace`).
 *
 * Each header shows the Workspace's rolled-up live status (streaming spinner /
 * needs-you badge from `workspaceFlags`) EVEN WHEN FOLDED, so a background permission
 * prompt is never hidden — which is why the old collapsed-trigger roll-up
 * (`backgroundAttention`) is gone. The panel lists that project's Threads: the ACTIVE
 * project uses App's live unified `rows`; every other project derives cold rows from
 * its own persisted Threads. Each list is capped to {@link THREAD_CAP} with a
 * "Show more" toggle and the selection-aware pin.
 *
 * The #129 header (new-project ＋ + Recent/Name sort) is kept; the sort now orders the
 * project LIST. Per-project open state is renderer-only UI, seeded to include the
 * selected project and persisted best-effort to localStorage (`project-open-store`).
 */
export function WorkspaceNav({
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  opening,
  onOpenProject,
  actions,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  rows: UnifiedThreadRow[]
  protectedThreadId: string | null
  opening: boolean
  onOpenProject: () => void
  actions: ThreadRowActions
}): JSX.Element {
  // The DISPLAY-ONLY sort order (#129): renderer-only UI state seeded from
  // localStorage (default 'recent'), persisted on change. It reorders the project
  // LIST only — never selection, nav, or the Thread lists.
  const [sortOrder, setSortOrderState] = useState<WorkspaceSortOrder>(() =>
    getSortOrder(window.localStorage),
  )
  function changeSortOrder(order: WorkspaceSortOrder): void {
    setSortOrderState(order)
    setSortOrder(window.localStorage, order)
  }
  // Which projects are UNFOLDED (#138): controlled, renderer-only UI state. Seeded
  // from localStorage UNIONED with the currently-selected project so the active one
  // starts expanded; toggling a fold spawns no agent and never changes selection.
  const activeId = nav.selectedWorkspaceId
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set([...getOpenProjects(window.localStorage), ...(activeId ? [activeId] : [])]),
  )
  function toggleOpen(workspaceId: string, open: boolean): void {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (open) next.add(workspaceId)
      else next.delete(workspaceId)
      setOpenProjects(window.localStorage, [...next])
      return next
    })
  }
  // ONE Date.now() per render, injected into the pure formatter at each call site.
  const nowMs = Date.now()

  // A sorted COPY for the list — the `workspaces` prop is never mutated and the
  // active/selection logic still keys off ids, so ordering is presentation-only.
  const sortedWorkspaces = sortWorkspaces(workspaces, sortOrder)

  return (
    <nav className="flex flex-col gap-0.5">
      {/* Projects header row (#129): the label on the left, and on the right a
          new-project + (→ the existing openProject) plus an options "…" menu holding
          the display-only sort order. The + stays available even with zero Workspaces,
          so the first project can still be opened from here. */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[13px] font-medium text-faint">Projects</span>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="icon-xs"
            aria-label="Open project"
            title="Open project"
            disabled={opening}
            onClick={onOpenProject}
          >
            {opening ? (
              <Spinner className="size-3.5" aria-label="Opening project" />
            ) : (
              <Plus className="size-4" aria-hidden />
            )}
          </IconButton>
          <Menu>
            <MenuTrigger
              aria-label="Project list options"
              title="Project list options"
              className="inline-flex size-6 items-center justify-center rounded-sm text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text focus-visible:bg-accent/10 data-[popup-open]:bg-accent/10"
            >
              <Ellipsis className="size-4" aria-hidden />
            </MenuTrigger>
            <MenuContent align="end" className="min-w-[180px]">
              <MenuRadioGroup
                value={sortOrder}
                onValueChange={(value) => changeSortOrder(value as WorkspaceSortOrder)}
              >
                <MenuRadioItem value="recent">Recent</MenuRadioItem>
                <MenuRadioItem value="name">Name (A–Z)</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <p className="px-3 py-1 text-[13px] leading-relaxed text-muted">
          No workspaces yet. Open a project to begin.
        </p>
      ) : (
        sortedWorkspaces.map((w) => {
          const isActive = w.id === activeId
          // The ACTIVE project uses App's live unified rows (cold + live merged); every
          // other project derives COLD rows from its OWN persisted Threads — no agent,
          // no live badges (the header rollup covers its background status).
          const projectRows = isActive
            ? rows
            : deriveUnifiedThreads({
                cold: w.threads,
                live: [],
                liveThreadIds: NO_LIVE_THREAD_IDS,
                statuses: NO_STATUSES,
              })
          return (
            <ProjectRow
              key={w.id}
              workspace={w}
              rows={projectRows}
              isActive={isActive}
              open={openIds.has(w.id)}
              flags={workspaceFlags[w.id]}
              selectedThreadId={nav.selectedThreadId}
              protectedThreadId={protectedThreadId}
              nowMs={nowMs}
              onToggleOpen={toggleOpen}
              actions={actions}
            />
          )
        })
      )}
    </nav>
  )
}

/**
 * One project in the collapsible list (#138): a `Collapsible` whose header is a
 * `CollapsibleTrigger` (folder + name + rolled-up live flags + a chevron that rotates
 * on open) with the per-project ＋ new-thread button as a SIBLING (outside the trigger)
 * so pressing ＋ starts a thread instead of toggling the fold. The panel lists this
 * project's Threads (capped + "Show more"), or "No threads yet" when empty.
 *
 * The header is peek-only: toggling never selects/connects the project. The per-project
 * "Show more" state is local (keyed by this row's identity via the parent's `key`).
 */
function ProjectRow({
  workspace,
  rows,
  isActive,
  open,
  flags,
  selectedThreadId,
  protectedThreadId,
  nowMs,
  onToggleOpen,
  actions,
}: {
  workspace: ListMetadataResult[number]
  rows: UnifiedThreadRow[]
  /** Whether this is the selected/active project (its `rows` carry real live flags). */
  isActive: boolean
  open: boolean
  flags: WorkspaceFlags | undefined
  selectedThreadId: string | null
  protectedThreadId: string | null
  nowMs: number
  onToggleOpen: (workspaceId: string, open: boolean) => void
  actions: ThreadRowActions
}): JSX.Element {
  const [expandedThreads, setExpandedThreads] = useState(false)
  // The "Remove project" confirmation dialog (Codex-style): a destructive, controlled
  // modal opened from this project's ⋯ menu. Confirming calls `actions.removeWorkspace`.
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  // Split archived rows out (#133) then float pinned rows to the top of the active
  // list (#132) — both pure post-processing over the derived rows (deriveUnifiedThreads
  // stays flag-agnostic). Archived rows fold into a collapsible section at the bottom.
  const { active: activeRows, archived: archivedRows } = partitionArchived(rows)
  const mainRows = orderByPin(activeRows)
  // Cap the main list, PINNING the selected row so opening a thread that sorts below
  // the cap never hides its (highlighted) row (#113 review). Only the active project
  // has a selected row in its list (thread ids are globally unique).
  const capped = visibleRows(
    mainRows,
    THREAD_CAP,
    expandedThreads,
    (r) => r.thread.id === selectedThreadId,
  )
  const hiddenCount = mainRows.length - capped.length
  const cappedIds = new Set(capped.map((r) => r.thread.id))
  const hiddenNeedsAttention = mainRows.some((r) => !cappedIds.has(r.thread.id) && r.needsAttention)

  return (
    <Collapsible open={open} onOpenChange={(next) => onToggleOpen(workspace.id, next)}>
      {/* Header row: the fold trigger + a SIBLING ＋ (outside the trigger button, so
          clicking ＋ starts a thread rather than toggling the fold). */}
      <div className="group/proj flex items-center gap-0.5 rounded-md pr-1 transition-colors hover:bg-accent/10">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-[7px] text-left text-[14px] text-text-body outline-none focus-visible:bg-accent/10">
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted transition-transform',
              !open && '-rotate-90',
            )}
            aria-hidden
          />
          <Folder className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="flex-1 truncate" title={workspace.dir}>
            {workspace.displayName}
          </span>
          {/* Rolled-up live status. The needs-attention badge stays visible even when
              FOLDED (a background permission prompt must not be hidden). The streaming
              snake shows ONLY when FOLDED — expanded, the thread rows carry their own,
              so this avoids a redundant project-level + thread-level spinner. */}
          {!open && flags?.streaming && (
            <LogoSnakeSpinner size={15} label="This project is working" />
          )}
          {flags?.needsAttention && (
            <Badge variant="destructive" title="A thread in this project needs your attention">
              needs you
            </Badge>
          )}
        </CollapsibleTrigger>
        <IconButton
          size="icon-xs"
          aria-label={`New thread in ${workspace.displayName}`}
          title="New thread"
          className="opacity-0 focus-visible:opacity-100 group-hover/proj:opacity-100"
          // "Start working here": mint/land the thread AND unfold the project so the
          // new thread is visible in the sidebar (not just in the outlet).
          onClick={() => {
            actions.newThreadInWorkspace(workspace.id)
            onToggleOpen(workspace.id, true)
          }}
        >
          <Plus className="size-4" aria-hidden />
        </IconButton>
        {/* Per-project ⋯ actions menu (a SIBLING of the trigger, so opening it never
            toggles the fold). Hover-revealed like the ＋; holds the destructive
            "Remove project" action, which opens the confirm dialog. */}
        <Menu>
          <MenuTrigger
            aria-label={`${workspace.displayName} project actions`}
            title="Project actions"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted opacity-0 outline-none transition-opacity hover:bg-accent/10 hover:text-text focus-visible:opacity-100 group-hover/proj:opacity-100 data-[popup-open]:opacity-100"
          >
            <MoreVertical className="size-3.5" aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem className="text-bad" onClick={() => setConfirmRemoveOpen(true)}>
              <Trash2 className="size-3.5" aria-hidden />
              Remove project
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {/* Confirm dialog for "Remove project" — controlled, destructive. It removes the
          project from vibe-mistro (our records + its agent), never files on disk. */}
      <Dialog open={confirmRemoveOpen} onOpenChange={setConfirmRemoveOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {workspace.displayName}?</DialogTitle>
            <DialogDescription>
              This removes the project from vibe-mistro. Files on disk will not be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmRemoveOpen(false)
                void actions.removeWorkspace(workspace.id)
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CollapsibleContent>
        {mainRows.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {capped.map((row) => (
              <NavThread
                key={row.thread.id}
                row={row}
                nowMs={nowMs}
                selected={row.thread.id === selectedThreadId}
                // Safe delete (TB6 / #48 / #53): ONLY the active project's rows carry
                // real live flags (others are peek-cold with live=false), so restrict
                // delete to the active project — else a background-connected project's
                // mid-turn thread would look cold-and-deletable and tear its session.
                // Within the active project the pure gate decides (cold always; the
                // primary never; any other live row when idle). Pin/archive are SAFE
                // metadata ops (no session teardown), so the kebab shows on every row.
                deletable={isActive && isThreadDeletable(row, protectedThreadId)}
                workspaceId={workspace.id}
                actions={actions}
              />
            ))}
            {(expandedThreads || hiddenCount > 0) && (
              <button
                type="button"
                onClick={() => setExpandedThreads((e) => !e)}
                className="flex items-center gap-2 px-3 py-1 pl-[42px] text-left text-[13px] text-accent-text outline-none hover:underline"
              >
                <span>{expandedThreads ? 'Show less' : `Show more (${hiddenCount})`}</span>
                {!expandedThreads && hiddenNeedsAttention && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-bad"
                    role="img"
                    aria-label="A hidden thread needs your attention"
                    title="A hidden thread needs your attention"
                  />
                )}
              </button>
            )}
          </ul>
        ) : archivedRows.length === 0 ? (
          <div className="px-3 py-1 pl-[42px] text-[13px] text-muted">No threads yet</div>
        ) : null}

        {/* Archived section (#133): a collapsible "Archived (N)" fold at the BOTTOM,
            default-collapsed, hidden entirely when N=0. Same NavThread rows (open /
            unarchive / delete). */}
        {archivedRows.length > 0 && (
          <ArchivedSection
            rows={archivedRows}
            isActive={isActive}
            protectedThreadId={protectedThreadId}
            selectedThreadId={selectedThreadId}
            nowMs={nowMs}
            workspaceId={workspace.id}
            actions={actions}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The per-project "Archived (N)" collapsible (#133): a nested, default-collapsed fold
 * at the bottom of a project's panel listing its archived Threads. Uses the SAME
 * NavThread row (so archived rows keep open / unarchive / delete), with the same
 * active-project delete gate as the main list.
 */
function ArchivedSection({
  rows,
  isActive,
  protectedThreadId,
  selectedThreadId,
  nowMs,
  workspaceId,
  actions,
}: {
  rows: UnifiedThreadRow[]
  isActive: boolean
  protectedThreadId: string | null
  selectedThreadId: string | null
  nowMs: number
  workspaceId: string
  actions: ThreadRowActions
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-0.5">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1 pl-[26px] text-left text-[13px] text-faint outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10">
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted transition-transform', !open && '-rotate-90')}
          aria-hidden
        />
        <Archive className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="flex-1 truncate">Archived ({rows.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <NavThread
              key={row.thread.id}
              row={row}
              nowMs={nowMs}
              selected={row.thread.id === selectedThreadId}
              deletable={isActive && isThreadDeletable(row, protectedThreadId)}
              workspaceId={workspaceId}
              actions={actions}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One unified Thread row: its label, a live (green) vs idle (grey) dot, a streaming
 * indicator and a needs-attention badge driven by the status registry, a relative
 * timestamp, and a kebab actions menu (base-ui) holding Delete — shown only when
 * `deletable`. Clicking the row selects it → the outlet routes live `Conversation`
 * vs cold `ColdThread`. The Menu is keyboard-accessible (base-ui owns focus +
 * roving), and the delete contract is unchanged: it still calls `actions.deleteThread(row.thread)`.
 */
function NavThread({
  row,
  nowMs,
  selected,
  deletable,
  workspaceId,
  actions,
}: {
  row: UnifiedThreadRow
  nowMs: number
  selected: boolean
  deletable: boolean
  workspaceId: string
  actions: ThreadRowActions
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  // Guards the Enter-then-blur double fire: once a submit/cancel settles, later events
  // on the (unmounting) input no-op. Reset each time a new edit starts.
  const settledRef = useRef(false)

  function startRename(): void {
    settledRef.current = false
    setEditing(true)
  }
  function submitRename(raw: string): void {
    if (settledRef.current) return
    settledRef.current = true
    setEditing(false)
    const next = normalizeRename(raw, row.thread.title)
    if (next !== null) actions.renameThread(row.thread, next)
  }
  function cancelRename(): void {
    if (settledRef.current) return
    settledRef.current = true
    setEditing(false)
  }

  // Inline rename: MIRROR the row's layout (same indent + leading dot) and swap only
  // the label for an autofocused input, so the text stays aligned with sibling rows —
  // the edit box hugs the text (after the dot), never the empty 42px indent. A plain
  // div (not NavItem, a <button>) so typing never selects the row or nests a control
  // in a button. Enter/blur commit, Esc cancels; the label is preselected to replace.
  if (editing) {
    return (
      <li className="relative">
        <div className="flex w-full items-center gap-2.5 py-[7px] pr-2 pl-[42px]">
          <span
            className={
              row.live
                ? 'size-[7px] shrink-0 rounded-full bg-ok'
                : 'size-[7px] shrink-0 rounded-full bg-border'
            }
            aria-hidden
          />
          <input
            autoFocus
            defaultValue={row.thread.title ?? ''}
            aria-label="Rename thread"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename(e.currentTarget.value)
              else if (e.key === 'Escape') cancelRename()
            }}
            onBlur={(e) => submitRename(e.currentTarget.value)}
            className="min-w-0 flex-1 rounded-[3px] bg-transparent px-1 text-[13.5px] text-text outline-none ring-1 ring-accent"
          />
        </div>
      </li>
    )
  }

  const timestamp = formatRelativeTime(row.thread.lastActiveAt, nowMs)
  const pinned = row.thread.pinned === true
  const archived = row.thread.archived === true
  return (
    <li className="group/thread relative">
      <NavItem
        active={selected}
        onClick={() => actions.selectThread(workspaceId, row.thread.id)}
        className="py-[7px] pr-2 pl-[42px] text-[13.5px]"
      >
        <span
          className={
            row.live
              ? 'size-[7px] shrink-0 rounded-full bg-ok'
              : 'size-[7px] shrink-0 rounded-full bg-border'
          }
          aria-hidden
        />
        {pinned && <Pin className="size-3 shrink-0 text-muted" aria-label="Pinned" />}
        <span className="flex-1 truncate">{threadLabel(row)}</span>
        {row.streaming && <LogoSnakeSpinner size={15} label="Streaming" />}
        {row.needsAttention && (
          <Badge variant="destructive" title="Awaiting your response">
            !
          </Badge>
        )}
        {/* Hidden on hover so the kebab (absolute, right-1) takes this spot instead of
            drawing ON TOP of the time; `invisible` keeps the space so nothing reflows. */}
        {timestamp && (
          <span className="shrink-0 text-[13px] text-faint group-hover/thread:invisible">
            {timestamp}
          </span>
        )}
      </NavItem>
      {/* Kebab shows on EVERY row now (#132/#133): pin/archive are SAFE metadata ops
          (no session teardown), so they're always available; only Delete stays gated to
          `deletable` (the #138 active-project safety). */}
      <Menu>
        <MenuTrigger
          aria-label="Thread actions"
          title="Thread actions"
          className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted opacity-0 outline-none transition-opacity hover:bg-accent/10 hover:text-text focus-visible:opacity-100 group-hover/thread:opacity-100 data-[popup-open]:opacity-100"
        >
          <MoreVertical className="size-3.5" aria-hidden />
        </MenuTrigger>
        <MenuContent>
          <MenuItem onClick={startRename}>
            <Pencil className="size-3.5" aria-hidden />
            Rename
          </MenuItem>
          <MenuItem onClick={() => actions.setThreadFlags(row.thread.id, { pinned: !pinned })}>
            {pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
            {pinned ? 'Unpin' : 'Pin'}
          </MenuItem>
          <MenuItem onClick={() => actions.setThreadFlags(row.thread.id, { archived: !archived })}>
            {archived ? (
              <ArchiveRestore className="size-3.5" aria-hidden />
            ) : (
              <Archive className="size-3.5" aria-hidden />
            )}
            {archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          {deletable && (
            <MenuItem className="text-bad" onClick={() => void actions.deleteThread(row.thread)}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
    </li>
  )
}

/** A Thread's list label — its title, a draft placeholder, or a fallback. */
function threadLabel(row: UnifiedThreadRow): string {
  if (row.thread.title) return row.thread.title
  // A live, session-less Thread is a fresh draft awaiting its first prompt.
  if (row.live && row.thread.sessionId === null) return 'New thread (draft)'
  return 'Untitled thread'
}
