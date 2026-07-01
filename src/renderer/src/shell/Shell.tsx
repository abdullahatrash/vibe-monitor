import { useState, type JSX, type ReactNode } from 'react'
import {
  Atom,
  Check,
  ChevronDown,
  Clock,
  Ellipsis,
  Folder,
  MoreVertical,
  Plus,
  Search,
  SquarePen,
  Trash2,
} from 'lucide-react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import { backgroundAttention } from './background-attention'
import { isThreadDeletable, type UnifiedThreadRow } from './unified-threads'
import { getSortOrder, setSortOrder, sortWorkspaces, type WorkspaceSortOrder } from './workspace-sort'
import { Badge } from '../ui/badge'
import { IconButton } from '../ui/icon-button'
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/menu'
import { NavItem } from '../ui/nav-item'
import { Spinner } from '../ui/spinner'
import { Logo } from './logo'
import { formatRelativeTime } from './relative-time'
import { visibleRows } from './show-more'

/** A Workspace's rolled-up live status, for its switcher row. */
export interface WorkspaceFlags {
  streaming: boolean
  needsAttention: boolean
}

/** How many thread rows the selected Workspace shows before "Show more" (#113). */
const THREAD_CAP = 5

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
 * each row showing a live/history badge, a streaming indicator, a needs-attention
 * badge, and an inline (safe) delete. Selection is the nav reducer's alone.
 */
export function Shell({
  workspaces,
  sidebarTop,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  canCreateThread,
  outlet,
  opening,
  onOpenProject,
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  /** Persisted Workspaces (cold metadata) for the switcher rows + display names. */
  workspaces: ListMetadataResult
  /** App-owned controls pinned above the list (environment status; the gear). */
  sidebarTop: ReactNode
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
  /** Select a Workspace — App pins it in nav and connect-or-reuses its warm agent. */
  onSelectWorkspace: (workspaceId: string) => void
  /** Select a Thread — App pins it in nav and (if live) remembers it as active. */
  onSelectThread: (workspaceId: string, threadId: string) => void
  /** Mint a New-thread draft on the selected Workspace's live agent. */
  onNewThread: () => void
  /** Delete a Thread (TB6) — main tears down any live session, then the list refreshes. */
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-[338px] flex-none flex-col gap-3 overflow-y-auto border-r border-border bg-sidebar p-3">
        <SidebarHeader />
        {sidebarTop}
        <PrimaryNav canCreateThread={canCreateThread} onNewThread={onNewThread} />
        <WorkspaceNav
          workspaces={workspaces}
          nav={nav}
          workspaceFlags={workspaceFlags}
          rows={rows}
          protectedThreadId={protectedThreadId}
          opening={opening}
          onOpenProject={onOpenProject}
          onSelectWorkspace={onSelectWorkspace}
          onSelectThread={onSelectThread}
          onDeleteThread={onDeleteThread}
        />
        <div className="flex-1" />
        <AccountChip />
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
      <span className="text-[15px] font-semibold tracking-tight text-text-strong">vibe mistro</span>
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
        className="flex w-full items-center gap-2.5 rounded-lg bg-[var(--accent-fill)] px-3 py-2 text-left text-[15.5px] font-semibold text-accent-text outline-none transition-[filter] hover:brightness-[0.98] disabled:pointer-events-none disabled:opacity-50"
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
 * The account chip pinned to the sidebar's bottom — a gradient avatar + a name +
 * a tier. STATIC placeholder chrome (#future): Vibe exposes no account identity
 * (see ADR-0003 / the SignedInBar), so these are fixed strings, not live data.
 */
function AccountChip(): JSX.Element {
  // placeholder — account identity + tier (#future); no live account API exists yet.
  return (
    <button
      type="button"
      className="flex items-center gap-2.5 rounded-[9px] px-2 py-2 text-left outline-none transition-colors hover:bg-accent/10"
    >
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
    </button>
  )
}

/**
 * The sidebar's Projects section (= Workspaces): a **project-switcher dropdown**
 * (#128) over the ACTIVE Workspace's unified Thread list — replacing #113's inline,
 * always-expanded multi-project fold.
 *
 * The switcher TRIGGER shows the active Workspace (folder + name + a chevron); its
 * dropdown (the base-ui `Menu`) lists ALL Workspaces, each with its rolled-up live
 * status (streaming spinner / needs-attention badge) and a check on the current one.
 * Picking one calls `onSelectWorkspace` — the EXISTING selection path (the nav
 * reducer), unchanged; this is a presentation change only.
 *
 * Background-Workspace visibility (the deferred TB2 finding) is preserved TWO ways:
 * (a) each Workspace row IN the dropdown carries its flags, and (b) a rolled-up
 * indicator on the COLLAPSED trigger ({@link backgroundAttention}) fires when ANY
 * non-active Workspace needs you / is streaming — so a wedged background turn is
 * visible without opening the dropdown.
 *
 * Below the switcher, ONLY the active Workspace's unified Thread list (TB3 #48)
 * renders (from `rows`, already scoped to the selection by App), capped to
 * {@link THREAD_CAP} with a "Show more" toggle (renderer-only state — no
 * IPC/persistence) and the selection-aware pin.
 */
function WorkspaceNav({
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  opening,
  onOpenProject,
  onSelectWorkspace,
  onSelectThread,
  onDeleteThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  rows: UnifiedThreadRow[]
  protectedThreadId: string | null
  opening: boolean
  onOpenProject: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const [expandedThreads, setExpandedThreads] = useState(false)
  // The switcher's DISPLAY-ONLY sort order (#129): renderer-only UI state seeded
  // from localStorage (default 'recent'), persisted on change. It reorders the
  // switcher dropdown ONLY — never selection, nav, or the Thread list below.
  const [sortOrder, setSortOrderState] = useState<WorkspaceSortOrder>(() =>
    getSortOrder(window.localStorage),
  )
  function changeSortOrder(order: WorkspaceSortOrder): void {
    setSortOrderState(order)
    setSortOrder(window.localStorage, order)
  }
  // ONE Date.now() per render, injected into the pure formatter at each call site.
  const nowMs = Date.now()

  const activeId = nav.selectedWorkspaceId
  const activeWorkspace = workspaces.find((w) => w.id === activeId) ?? null
  // A sorted COPY for the switcher dropdown — the `workspaces` prop is never mutated
  // and the active/selection logic still keys off ids, so ordering is presentation-only.
  const sortedWorkspaces = sortWorkspaces(workspaces, sortOrder)
  // The roll-up of every NON-active Workspace's status, for the collapsed trigger —
  // so a background Workspace blocked on a permission is visible without opening.
  const background = backgroundAttention(workspaceFlags, activeId)
  // Cap the active Workspace's thread list, PINNING the selected row so opening a
  // thread that sorts below the cap never hides its (highlighted) row (#113 review).
  const capped = visibleRows(
    rows,
    THREAD_CAP,
    expandedThreads,
    (r) => r.thread.id === nav.selectedThreadId,
  )
  // What the toggle can still reveal (0 → nothing hidden → no toggle).
  const hiddenCount = rows.length - capped.length
  // A permission-blocked thread that sorts BELOW the cap would otherwise have no
  // always-visible signal (the active Workspace is excluded from the trigger
  // roll-up), so flag it on the "Show more" control (#128 review).
  const cappedIds = new Set(capped.map((r) => r.thread.id))
  const hiddenNeedsAttention = rows.some((r) => !cappedIds.has(r.thread.id) && r.needsAttention)

  return (
    <nav className="flex flex-col gap-0.5">
      {/* Projects header row (#129): the label on the left, and on the right a
          new-project + (→ the existing openProject) plus an options "…" menu holding
          the switcher's display-only sort order. The + stays available even with zero
          Workspaces, so the first project can still be opened from here. */}
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
        <Menu>
          <MenuTrigger
            title={activeWorkspace?.dir}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-[7px] text-left text-[15px] text-text-body outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 data-[popup-open]:bg-accent/10"
          >
            <Folder className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="flex-1 truncate">
              {activeWorkspace ? activeWorkspace.displayName : 'Select a project'}
            </span>
            {/* (b) rolled-up background status on the collapsed trigger (TB2 finding). */}
            {background.streaming && (
              <Spinner className="size-3.5 text-accent-text" aria-label="A background project is working" />
            )}
            {background.needsAttention && (
              <Badge variant="destructive" title="A background project needs your attention">
                needs you
              </Badge>
            )}
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </MenuTrigger>
          <MenuContent align="start" className="min-w-[290px]">
            {sortedWorkspaces.map((w) => {
              const flags = workspaceFlags[w.id]
              const isActive = w.id === activeId
              return (
                <MenuItem key={w.id} onClick={() => onSelectWorkspace(w.id)} title={w.dir}>
                  <Folder className="size-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate">{w.displayName}</span>
                  {/* (a) each Workspace's own flags, visible in the open dropdown. */}
                  {flags?.streaming && <Spinner className="size-3.5" aria-label="streaming" />}
                  {flags?.needsAttention && (
                    <Badge variant="destructive" title="A thread needs your attention">
                      needs you
                    </Badge>
                  )}
                  {isActive && <Check className="size-4 shrink-0" aria-hidden />}
                </MenuItem>
              )
            })}
          </MenuContent>
        </Menu>
      )}

      {/* Only the ACTIVE Workspace's thread list renders below the switcher; `rows` is
          already scoped to the selection by App. Nothing selected → no list at all. */}
      {activeWorkspace &&
        (rows.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {capped.map((row) => (
              <NavThread
                key={row.thread.id}
                row={row}
                nowMs={nowMs}
                selected={row.thread.id === nav.selectedThreadId}
                // Safe delete (TB6 / #48 / #53), decided by the pure gate: a cold row
                // always; the primary never; any other live row when it is idle.
                deletable={isThreadDeletable(row, protectedThreadId)}
                onOpen={() => onSelectThread(activeWorkspace.id, row.thread.id)}
                onDelete={onDeleteThread}
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
        ) : (
          <div className="px-3 py-1 pl-[42px] text-[13px] text-muted">No threads yet</div>
        ))}
    </nav>
  )
}

/**
 * One unified Thread row: its label, a live (●) vs `history` badge, a streaming
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
}: {
  row: UnifiedThreadRow
  nowMs: number
  selected: boolean
  deletable: boolean
  onOpen: () => void
  onDelete: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const timestamp = formatRelativeTime(row.thread.lastActiveAt, nowMs)
  return (
    <li className="group/thread relative">
      <NavItem active={selected} onClick={onOpen} className="py-[7px] pr-2 pl-[42px] text-[14.5px]">
        <span
          className={
            row.live
              ? 'size-[7px] shrink-0 rounded-full bg-ok'
              : 'size-[7px] shrink-0 rounded-full bg-border'
          }
          aria-hidden
        />
        <span className="flex-1 truncate">{threadLabel(row)}</span>
        {row.streaming && (
          <Spinner className="size-3.5 text-accent-text" aria-label="Streaming" />
        )}
        {!row.live && <Badge variant="accent">history</Badge>}
        {row.needsAttention && (
          <Badge variant="destructive" title="Awaiting your response">
            !
          </Badge>
        )}
        {timestamp && <span className="shrink-0 text-[13px] text-faint">{timestamp}</span>}
      </NavItem>
      {deletable && (
        <Menu>
          <MenuTrigger
            aria-label="Thread actions"
            title="Thread actions"
            className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted opacity-0 outline-none transition-opacity hover:bg-accent/10 hover:text-text focus-visible:opacity-100 group-hover/thread:opacity-100 data-[popup-open]:opacity-100"
          >
            <MoreVertical className="size-3.5" aria-hidden />
          </MenuTrigger>
          <MenuContent>
            <MenuItem className="text-bad" onClick={() => void onDelete(row.thread)}>
              <Trash2 className="size-3.5" aria-hidden />
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
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
