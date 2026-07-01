import { useState, type JSX, type ReactNode } from 'react'
import { Atom, ChevronDown, ChevronRight, Clock, Folder, MoreVertical, Search, SquarePen, Trash2 } from 'lucide-react'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import { isThreadDeletable, type UnifiedThreadRow } from './unified-threads'
import { Badge } from '../ui/badge'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
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
  onSelectWorkspace,
  onSelectThread,
  onNewThread,
  onDeleteThread,
}: {
  /** Persisted Workspaces (cold metadata) for the switcher rows + display names. */
  workspaces: ListMetadataResult
  /** App-owned controls pinned above the list (Open project + environment status). */
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
 * The sidebar's Projects section (= Workspaces): a collapsible header over the
 * Workspace switcher list. The SELECTED Workspace expands to its unified Thread list
 * (TB3 #48), capped to {@link THREAD_CAP} with a "Show more" toggle (renderer-only
 * state — no IPC/persistence). A non-selected Workspace shows only its name + a
 * rolled-up live status (a streaming spinner / a needs-attention badge), so a
 * background Workspace blocked on a permission prompt is visible without expanding.
 */
function WorkspaceNav({
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  onSelectWorkspace,
  onSelectThread,
  onDeleteThread,
}: {
  workspaces: ListMetadataResult
  nav: NavState
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  rows: UnifiedThreadRow[]
  protectedThreadId: string | null
  onSelectWorkspace: (workspaceId: string) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
  onDeleteThread: (thread: ThreadMeta) => Promise<void>
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [expandedThreads, setExpandedThreads] = useState(false)
  // ONE Date.now() per render, injected into the pure formatter at each call site.
  const nowMs = Date.now()

  return (
    <nav className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex items-center gap-1 px-3 py-1.5 text-[13px] font-medium text-faint outline-none"
      >
        {collapsed ? (
          <ChevronRight className="size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden />
        )}
        Projects
      </button>

      {!collapsed &&
        (workspaces.length === 0 ? (
          <p className="px-3 py-1 text-[13px] leading-relaxed text-muted">
            No workspaces yet. Open a project to begin.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {workspaces.map((w) => {
              const isSelected = w.id === nav.selectedWorkspaceId
              const flags = workspaceFlags[w.id]
              // Cap the list, but PIN the selected row so opening a thread that sorts
              // below the cap never hides its (highlighted) sidebar row (#113 review).
              const capped = isSelected
                ? visibleRows(
                    rows,
                    THREAD_CAP,
                    expandedThreads,
                    (r) => r.thread.id === nav.selectedThreadId,
                  )
                : []
              // What the toggle can still reveal (0 → nothing hidden → no toggle).
              const hiddenCount = rows.length - capped.length
              return (
                <li key={w.id}>
                  <NavItem
                    active={isSelected}
                    title={w.dir}
                    onClick={() => onSelectWorkspace(w.id)}
                    className="py-[7px] text-[15px]"
                  >
                    <Folder className="size-4" aria-hidden />
                    <span className="flex-1 truncate">{w.displayName}</span>
                    {flags?.streaming && (
                      <Spinner className="size-3.5 text-accent-text" aria-label="streaming" />
                    )}
                    {flags?.needsAttention && (
                      <Badge variant="destructive" title="A thread needs your attention">
                        needs you
                      </Badge>
                    )}
                  </NavItem>

                  {isSelected &&
                    (rows.length > 0 ? (
                      <ul className="flex flex-col gap-0.5">
                        {capped.map((row) => (
                          <NavThread
                            key={row.thread.id}
                            row={row}
                            nowMs={nowMs}
                            selected={row.thread.id === nav.selectedThreadId}
                            // Safe delete (TB6 / #48 / #53), decided by the pure gate: a cold
                            // row always; the primary never; any other live row when it is idle.
                            deletable={isThreadDeletable(row, protectedThreadId)}
                            onOpen={() => onSelectThread(w.id, row.thread.id)}
                            onDelete={onDeleteThread}
                          />
                        ))}
                        {(expandedThreads || hiddenCount > 0) && (
                          <button
                            type="button"
                            onClick={() => setExpandedThreads((e) => !e)}
                            className="px-3 py-1 pl-[42px] text-left text-[13px] text-accent-text outline-none hover:underline"
                          >
                            {expandedThreads ? 'Show less' : `Show more (${hiddenCount})`}
                          </button>
                        )}
                      </ul>
                    ) : (
                      <div className="px-3 py-1 pl-[42px] text-[13px] text-muted">No threads yet</div>
                    ))}
                </li>
              )
            })}
          </ul>
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
