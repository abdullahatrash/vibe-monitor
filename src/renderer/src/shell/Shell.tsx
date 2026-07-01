import { useRef, useState, type JSX, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  Atom,
  ChevronDown,
  Clock,
  Ellipsis,
  Folder,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import {
  deriveUnifiedThreads,
  isThreadDeletable,
  orderByPin,
  partitionArchived,
  type UnifiedThreadRow,
} from './unified-threads'
import { getOpenProjects, setOpenProjects } from './project-open-store'
import { getSortOrder, setSortOrder, sortWorkspaces, type WorkspaceSortOrder } from './workspace-sort'
import { Badge } from '../ui/badge'
import { cn } from '../lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { IconButton } from '../ui/icon-button'
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/menu'
import { NavItem } from '../ui/nav-item'
import { Spinner } from '../ui/spinner'
import { Logo } from './logo'
import { LogoSnakeSpinner } from './logo-snake-spinner'
import { normalizeRename } from './rename'
import { formatRelativeTime } from './relative-time'
import { visibleRows } from './show-more'

/** A Workspace's rolled-up live status, shown on its collapsible project header. */
export interface WorkspaceFlags {
  streaming: boolean
  needsAttention: boolean
}

/** Toggle a Thread's persisted per-Thread flags (#132 pin / #133 archive). */
type SetThreadFlags = (threadId: string, flags: { pinned?: boolean; archived?: boolean }) => void

/** Rename a Thread (inline sidebar edit) — App persists it + syncs vibe-acp if live. */
type RenameThread = (thread: ThreadMeta, title: string) => void

/** How many thread rows each project shows before "Show more" (#113/#138). */
const THREAD_CAP = 5

/** A stable empty live-set for a NON-active project's cold-only derivation (no re-alloc). */
const NO_LIVE_THREAD_IDS: ReadonlySet<string> = new Set()
/** A stable empty status map for a NON-active project — its rollup lives on the header. */
const NO_STATUSES = {} as const

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Navigation
 * (the pure nav reducer, decision 2) and the per-Workspace connection registry
 * (decision 3) live in App; Shell is the presentational layout — now restyled onto
 * the design-system tokens + primitives (#113): a warm `--sidebar` surface, a logo +
 * wordmark header, a primary nav (New chat + placeholder Search/Scheduled/Plugins),
 * a collapsible Projects list (= Workspaces) with thread rows + relative timestamps +
 * a "Show more" cap, and a placeholder account chip. Behavior is unchanged: the same
 * selection/New-thread/delete handlers, the same live/streaming/needs-attention
 * indicators, the same empty states — only the JSX + styling moved.
 *
 * TB3 (#48) collapses the two competing Thread lists into ONE unified list per
 * Workspace; the SELECTED Workspace expands to its unified rows (cold + live merged),
 * each row showing a live/idle dot, a streaming indicator, a needs-attention
 * badge, and an inline (safe) delete. Selection is the nav reducer's alone.
 */
export function Shell({
  collapsed,
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  canCreateThread,
  outlet,
  opening,
  onOpenProject,
  onSelectThread,
  onNewThread,
  onNewThreadInWorkspace,
  onDeleteThread,
  onSetThreadFlags,
  onRenameThread,
  onOpenSettings,
}: {
  /** Whether the left sidebar is collapsed (#127) — animate its width to 0 (still mounted). */
  collapsed: boolean
  /** Persisted Workspaces (cold metadata) for the switcher rows + display names. */
  workspaces: ListMetadataResult
  /** The current navigation selection (controlled by App). */
  nav: NavState
  /** Per-Workspace rolled-up live status, keyed by Workspace id (switcher badges). */
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  /** The unified rows (cold + live) for the SELECTED Workspace. */
  rows: UnifiedThreadRow[]
  /** The connection's primary Thread (never deletable mid-connection), or null. */
  protectedThreadId: string | null
  /** Whether New-thread is available (the selected Workspace is connected). */
  canCreateThread: boolean
  /** The fully-computed conversation outlet (connection views / cold replay). */
  outlet: ReactNode
  /** Whether an Open-project connect is in flight — busies the header's new-project +. */
  opening: boolean
  /** Open a project via the OS dialog (the existing `openProject`), from the Projects header +. */
  onOpenProject: () => void
  /** Select a Thread — App pins it in nav and (if live) remembers it as active. */
  onSelectThread: (workspaceId: string, threadId: string) => void
  /** Mint a New-thread draft on the selected Workspace's live agent. */
  onNewThread: () => void
  /** Start a new thread in a SPECIFIC project (#138 per-project ＋) — connect-if-needed. */
  onNewThreadInWorkspace: (workspaceId: string) => void
  /** Delete a Thread (TB6) — main tears down any live session, then the list refreshes. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
  /** Pin/archive a Thread (#132/#133) — a safe metadata toggle on any row. */
  onSetThreadFlags: SetThreadFlags
  /** Rename a Thread (#) — inline sidebar edit; App persists + syncs vibe-acp if live. */
  onRenameThread: RenameThread
  /** Open the routed Settings page (#130) — from the account chip's menu. */
  onOpenSettings: () => void
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1">
      {/* The sidebar stays MOUNTED when collapsed (#127) — its state (open projects,
          scroll, the #138 fold list) survives, so re-expanding is instant. The OUTER
          <aside> animates only its width (0 ↔ 338px) and clips (`overflow-hidden`); the
          INNER holds a FIXED 338px width so the content SLIDES under the clip cleanly
          instead of squishing as the container shrinks. `aria-hidden`/`inert` take the
          now-hidden controls out of the tab order + a11y tree while collapsed. The
          <main> outlet is `flex-1`, so it reclaims the freed space automatically. */}
      <aside
        aria-hidden={collapsed || undefined}
        inert={collapsed || undefined}
        className={cn(
          'flex flex-none overflow-hidden border-border bg-sidebar transition-[width] duration-200',
          collapsed ? 'w-0 border-r-0' : 'w-[338px] border-r',
        )}
      >
        {/* Three-band sidebar: a PINNED top (logo + primary nav) and a PINNED bottom
            (account) sandwich the ONLY scroll region — the Projects list — so the nav
            and account stay put while just the projects scroll. */}
        <div className="flex h-full w-[338px] flex-none flex-col gap-3 p-3">
          <div className="flex flex-none flex-col gap-3">
            <SidebarHeader />
            <PrimaryNav canCreateThread={canCreateThread} onNewThread={onNewThread} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspaceNav
              workspaces={workspaces}
              nav={nav}
              workspaceFlags={workspaceFlags}
              rows={rows}
              protectedThreadId={protectedThreadId}
              opening={opening}
              onOpenProject={onOpenProject}
              onSelectThread={onSelectThread}
              onNewThreadInWorkspace={onNewThreadInWorkspace}
              onDeleteThread={onDeleteThread}
              onSetThreadFlags={onSetThreadFlags}
              onRenameThread={onRenameThread}
            />
          </div>
          <AccountChip onOpenSettings={onOpenSettings} />
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-6">{outlet}</main>
    </div>
  )
}

/** Logo + wordmark, pinned at the sidebar's top. */
function SidebarHeader(): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1">
      <Logo size={30} />
      <span className="text-[14.5px] font-semibold tracking-tight text-text-strong">vibe mistro</span>
    </div>
  )
}

/**
 * The primary nav: the peach-tinted "New chat" pill (the ONE filled tint,
 * `--accent-fill`) which mints a draft on the selected connected Workspace
 * (`onNewThread`, gated by `canCreateThread` — behavior unchanged from the old
 * "+ New thread"), plus static placeholder rows for Search / Scheduled / Plugins.
 */
function PrimaryNav({
  canCreateThread,
  onNewThread,
}: {
  canCreateThread: boolean
  onNewThread: () => void
}): JSX.Element {
  return (
    <nav className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onNewThread}
        disabled={!canCreateThread}
        className="flex w-full items-center gap-2.5 rounded-lg bg-[var(--accent-fill)] px-3 py-2 text-left text-[14px] font-semibold text-accent-text outline-none transition-[filter] hover:brightness-[0.98] disabled:pointer-events-none disabled:opacity-50"
      >
        <SquarePen className="size-[18px]" aria-hidden />
        New chat
      </button>
      {/* placeholder — Search (#future) */}
      <NavItem>
        <Search className="size-[18px]" aria-hidden />
        Search
      </NavItem>
      {/* placeholder — Scheduled (#future) */}
      <NavItem>
        <Clock className="size-[18px]" aria-hidden />
        Scheduled
      </NavItem>
      {/* placeholder — Plugins (#future) */}
      <NavItem>
        <Atom className="size-[18px]" aria-hidden />
        Plugins
      </NavItem>
    </nav>
  )
}

/**
 * The account chip pinned to the sidebar's bottom — a gradient avatar + a name + a
 * tier, now the TRIGGER of an account dropdown (#130). The chip's chrome stays a
 * STATIC placeholder (#future): Vibe exposes no account identity (see ADR-0003 / the
 * SignedInBar), so the avatar/name/tier are fixed strings, not live data. The menu
 * holds a real "Settings" item (→ the routed Settings page that now hosts the env/CLI
 * status the sidebar gear used to toggle) plus room for future account actions.
 */
function AccountChip({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  return (
    <Menu>
      <MenuTrigger className="flex items-center gap-2.5 rounded-[9px] px-2 py-2 text-left outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 data-[popup-open]:bg-accent/10">
        {/* placeholder — account identity + tier (#future); no live account API exists yet. */}
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white"
          style={{ backgroundImage: 'var(--accent-grad-avatar)' }}
        >
          V
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-semibold text-text-strong">Your account</span>
          <span className="truncate text-[12px] text-faint">Mistral Vibe</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </MenuTrigger>
      <MenuContent align="start" className="min-w-[200px]">
        <MenuItem onClick={onOpenSettings}>
          <Settings className="size-3.5" aria-hidden />
          Settings
        </MenuItem>
        {/* room for future account actions (profile, sign-out, tier) — #future;
            no live account API exists yet (ADR-0003). */}
      </MenuContent>
    </Menu>
  )
}

/**
 * The sidebar's Projects section (= Workspaces): an **all-visible collapsible list**
 * (#138, superseding #128's switcher dropdown). Every Workspace stays VISIBLE as a
 * row that independently FOLDS its own Thread list (base-ui `Collapsible`); multiple
 * can be open at once.
 *
 * Folding is **peek-only** — a header row's `CollapsibleTrigger` ONLY toggles the
 * fold; it NEVER selects or connects the project (no agent is spawned). A project
 * goes live only by opening one of its Threads (`onSelectThread` — the existing
 * live/cold-Continue flow, unchanged) or via its per-project ＋ (`onNewThreadInWorkspace`).
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
function WorkspaceNav({
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  opening,
  onOpenProject,
  onSelectThread,
  onNewThreadInWorkspace,
  onDeleteThread,
  onSetThreadFlags,
  onRenameThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  rows: UnifiedThreadRow[]
  protectedThreadId: string | null
  opening: boolean
  onOpenProject: () => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThreadInWorkspace: (workspaceId: string) => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
  onSetThreadFlags: SetThreadFlags
  onRenameThread: RenameThread
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
              onNewThread={onNewThreadInWorkspace}
              onSelectThread={onSelectThread}
              onDeleteThread={onDeleteThread}
              onSetThreadFlags={onSetThreadFlags}
              onRenameThread={onRenameThread}
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
  onNewThread,
  onSelectThread,
  onDeleteThread,
  onSetThreadFlags,
  onRenameThread,
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
  onNewThread: (workspaceId: string) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
  onSetThreadFlags: SetThreadFlags
  onRenameThread: RenameThread
}): JSX.Element {
  const [expandedThreads, setExpandedThreads] = useState(false)
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
            onNewThread(workspace.id)
            onToggleOpen(workspace.id, true)
          }}
        >
          <Plus className="size-4" aria-hidden />
        </IconButton>
      </div>

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
                onOpen={() => onSelectThread(workspace.id, row.thread.id)}
                onDelete={onDeleteThread}
                onSetThreadFlags={onSetThreadFlags}
                onRename={onRenameThread}
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
            onSelectThread={onSelectThread}
            onDeleteThread={onDeleteThread}
            onSetThreadFlags={onSetThreadFlags}
            onRenameThread={onRenameThread}
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
  onSelectThread,
  onDeleteThread,
  onSetThreadFlags,
  onRenameThread,
}: {
  rows: UnifiedThreadRow[]
  isActive: boolean
  protectedThreadId: string | null
  selectedThreadId: string | null
  nowMs: number
  workspaceId: string
  onSelectThread: (workspaceId: string, threadId: string) => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
  onSetThreadFlags: SetThreadFlags
  onRenameThread: RenameThread
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
              onOpen={() => onSelectThread(workspaceId, row.thread.id)}
              onDelete={onDeleteThread}
              onSetThreadFlags={onSetThreadFlags}
              onRename={onRenameThread}
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
 * roving), and the delete contract is unchanged: it still calls `onDelete(row.thread)`.
 */
function NavThread({
  row,
  nowMs,
  selected,
  deletable,
  onOpen,
  onDelete,
  onSetThreadFlags,
  onRename,
}: {
  row: UnifiedThreadRow
  nowMs: number
  selected: boolean
  deletable: boolean
  onOpen: () => void
  onDelete: (thread: ThreadMeta) => Promise<void>
  onSetThreadFlags: SetThreadFlags
  onRename: RenameThread
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
    if (next !== null) onRename(row.thread, next)
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
      <NavItem active={selected} onClick={onOpen} className="py-[7px] pr-2 pl-[42px] text-[13.5px]">
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
          <MenuItem onClick={() => onSetThreadFlags(row.thread.id, { pinned: !pinned })}>
            {pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
            {pinned ? 'Unpin' : 'Pin'}
          </MenuItem>
          <MenuItem onClick={() => onSetThreadFlags(row.thread.id, { archived: !archived })}>
            {archived ? (
              <ArchiveRestore className="size-3.5" aria-hidden />
            ) : (
              <Archive className="size-3.5" aria-hidden />
            )}
            {archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          {deletable && (
            <MenuItem className="text-bad" onClick={() => void onDelete(row.thread)}>
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
