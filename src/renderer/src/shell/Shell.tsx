import { useEffect, useRef, useState, type JSX, type PointerEvent, type ReactNode } from 'react'
import { Atom, ChevronDown, Clock, Search, Settings, SquarePen } from 'lucide-react'
import type { ListMetadataResult } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import type { UnifiedThreadRow } from './unified-threads'
import { WorkspaceNav, type ThreadRowActions, type WorkspaceFlags } from './workspace-nav'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  getSidebarWidth,
  setSidebarWidth,
} from './sidebar-width-store'
import { cn } from '../lib/utils'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { NavItem } from '../ui/nav-item'
import { Logo } from './logo'

export type { WorkspaceFlags } from './workspace-nav'

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Navigation
 * (the pure nav reducer, decision 2) and the per-Workspace connection registry
 * (decision 3) live in App; Shell is the presentational layout — now restyled onto
 * the design-system tokens + primitives (#113): a warm `--sidebar` surface, a logo +
 * wordmark header, a primary nav (New chat + placeholder Search/Scheduled/Plugins),
 * a collapsible Projects list (= Workspaces, the {@link WorkspaceNav} subtree) with
 * thread rows + relative timestamps + a "Show more" cap, and a placeholder account chip.
 * Behavior is unchanged: the same selection/New-thread/delete handlers, the same
 * live/streaming/needs-attention indicators, the same empty states — only the JSX +
 * styling moved.
 *
 * The per-Thread-row handlers are bundled into ONE {@link ThreadRowActions} `actions`
 * prop threaded explicitly to `WorkspaceNav`; the layout, resize, and top-level nav
 * sections stay here.
 */
export function Shell({
  collapsed,
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  outlet,
  opening,
  onOpenProject,
  onNewThread,
  actions,
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
  /** The fully-computed conversation outlet (connection views / cold replay). */
  outlet: ReactNode
  /** Whether an Open-project connect is in flight — busies the header's new-project +. */
  opening: boolean
  /** Open a project via the OS dialog (the existing `openProject`), from the Projects header +. */
  onOpenProject: () => void
  /** Mint a New-thread draft on the selected Workspace's live agent. */
  onNewThread: () => void
  /** The bundled per-Thread-row actions (select / new / delete / remove / flags / rename). */
  actions: ThreadRowActions
  /** Open the routed Settings page (#130) — from the account chip's menu. */
  onOpenSettings: () => void
}): JSX.Element {
  // The sidebar's EXPANDED width (#drag-to-resize): renderer-only UI state, seeded from
  // localStorage (clamped) and persisted on drag-release. `dragging` disables the
  // collapse width-transition so the aside tracks the pointer 1:1 with no lag, and
  // suppresses text selection while the pointer is captured.
  const [width, setWidth] = useState(() => getSidebarWidth(window.localStorage))
  const [dragging, setDragging] = useState(false)
  // The drag origin, captured on pointer-down so the move handler reads no stale state.
  const dragOrigin = useRef({ startX: 0, startWidth: DEFAULT_SIDEBAR_WIDTH })

  function onHandlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    dragOrigin.current = { startX: e.clientX, startWidth: width }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHandlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (!dragging) return
    const { startX, startWidth } = dragOrigin.current
    setWidth(clampSidebarWidth(startWidth + (e.clientX - startX)))
  }
  function endDrag(e: PointerEvent<HTMLDivElement>): void {
    if (!dragging) return
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Persist the settled EXPANDED width (best-effort). Read from state via the setter to
    // avoid a stale closure — setWidth's identity update returns the current value.
    setWidth((current) => {
      setSidebarWidth(window.localStorage, current)
      return current
    })
  }
  function resetWidth(): void {
    setWidth(DEFAULT_SIDEBAR_WIDTH)
    setSidebarWidth(window.localStorage, DEFAULT_SIDEBAR_WIDTH)
  }
  // Collapsing unmounts the handle, so a drag in flight would never get its pointerup
  // (→ `dragging` stuck true: stuck `select-none`, suppressed transition, and — worst —
  // the re-expanded handle resizing on mere hover off a stale origin). Clear it on collapse.
  useEffect(() => {
    if (collapsed) setDragging(false)
  }, [collapsed])

  return (
    <div className={cn('flex min-h-0 flex-1', dragging && 'select-none')}>
      {/* The sidebar stays MOUNTED when collapsed (#127) — its state (open projects,
          scroll, the #138 fold list) survives, so re-expanding is instant. The OUTER
          <aside> animates only its width (0 ↔ the resized width) and clips
          (`overflow-hidden`); the INNER holds a FIXED (resized) width so the content
          SLIDES under the clip cleanly instead of squishing as the container shrinks.
          `aria-hidden`/`inert` take the now-hidden controls out of the tab order + a11y
          tree while collapsed. The <main> outlet is `flex-1`, so it reclaims the freed
          space automatically. The width is inline (dynamic #drag-to-resize); the
          transition is disabled WHILE DRAGGING so the aside tracks the pointer with no
          lag, but kept for the collapse animation. */}
      <aside
        aria-hidden={collapsed || undefined}
        inert={collapsed || undefined}
        style={{ width: collapsed ? 0 : width }}
        className={cn(
          'flex flex-none overflow-hidden border-border bg-sidebar transition-[width] duration-200',
          collapsed ? 'border-r-0' : 'border-r',
          dragging && 'transition-none',
        )}
      >
        {/* Three-band sidebar: a PINNED top (logo + primary nav) and a PINNED bottom
            (account) sandwich the ONLY scroll region — the Projects list — so the nav
            and account stay put while just the projects scroll. The INNER holds the
            resized width (not shrinking) so content slides under the clip on collapse. */}
        <div className="flex h-full flex-none flex-col gap-3 p-3" style={{ width }}>
          <div className="flex flex-none flex-col gap-3">
            <SidebarHeader />
            <PrimaryNav busy={opening} onNewThread={onNewThread} />
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
              actions={actions}
            />
          </div>
          <AccountChip onOpenSettings={onOpenSettings} />
        </div>
      </aside>

      {/* Resize handle (#drag-to-resize): a SIBLING of the <aside> (so it lives OUTSIDE
          the aside's `overflow-hidden`/collapse clip) rendered only when expanded — a
          collapsed sidebar can't be resized. A 0-width relative wrapper on the border
          carries a WIDER (8px) invisible hit strip (`absolute -left-1 w-2`) with a thin
          visible line on hover/drag, so the grab target is forgiving but the affordance
          is a 1px seam. Pointer-capture keeps the drag tracking outside the strip and
          auto-cleans (no leaked window listener). Double-click resets to the default. */}
      {!collapsed && (
        <div className="relative z-10 w-0 flex-none">
          <div
            aria-hidden
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetWidth}
            className={cn(
              'absolute -left-1 top-0 h-full w-2 cursor-col-resize [-webkit-app-region:no-drag]',
              'after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors after:content-[""] hover:after:bg-accent/40',
              dragging && 'after:bg-accent/60',
            )}
          />
        </div>
      )}

      {/* Full-bleed (t3code): the side panel must reach the window edges, so the
          padding lives in each outlet view (the chat column / the p-6 wrappers in
          App's outlet), not here. */}
      <main className="min-w-0 flex-1 overflow-y-auto">{outlet}</main>
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
 * `--accent-fill`). It's ALWAYS actionable now — `onNewThread` (App's `startNewChat`)
 * targets the selected/most-recent project (connect-if-needed) or opens the picker when
 * there are none — so it's only disabled while a connect is in flight (`busy`). Below it,
 * Search / Scheduled / Plugins are net-new features (ADR-0010) shown as disabled "Soon"
 * rows until their own epics land, so they read as intentional rather than broken.
 */
function PrimaryNav({
  busy,
  onNewThread,
}: {
  busy: boolean
  onNewThread: () => void
}): JSX.Element {
  return (
    <nav className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onNewThread}
        disabled={busy}
        className="flex w-full items-center gap-2.5 rounded-lg bg-[var(--accent-fill)] px-3 py-2 text-left text-[14px] font-semibold text-accent-text outline-none transition-[filter] hover:brightness-[0.98] disabled:pointer-events-none disabled:opacity-50"
      >
        <SquarePen className="size-[18px]" aria-hidden />
        New chat
      </button>
      <PlaceholderNav icon={<Search className="size-[18px]" aria-hidden />}>Search</PlaceholderNav>
      <PlaceholderNav icon={<Clock className="size-[18px]" aria-hidden />}>Scheduled</PlaceholderNav>
      <PlaceholderNav icon={<Atom className="size-[18px]" aria-hidden />}>Plugins</PlaceholderNav>
    </nav>
  )
}

/**
 * A not-yet-built primary-nav entry (Search / Scheduled / Plugins — each its own future
 * epic, ADR-0010): a disabled `NavItem` with a muted "Soon" tag, so it reads as
 * intentionally-coming rather than a broken no-op.
 */
function PlaceholderNav({ icon, children }: { icon: JSX.Element; children: ReactNode }): JSX.Element {
  return (
    <NavItem disabled title="Coming soon" className="cursor-default opacity-60">
      {icon}
      <span className="flex-1">{children}</span>
      <span className="text-[11px] font-medium text-faint">Soon</span>
    </NavItem>
  )
}

/**
 * The account chip pinned to the sidebar's bottom — a gradient avatar + a name + a
 * tier, now the TRIGGER of an account dropdown (#130). The chip's chrome stays a
 * STATIC placeholder (#future): Vibe exposes no account identity (see ADR-0003 / the
 * Settings Account section), so the avatar/name/tier are fixed strings, not live data. The menu
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
