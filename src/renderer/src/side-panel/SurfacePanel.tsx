import { useEffect, useRef, useState, type JSX, type PointerEvent, type ReactNode } from 'react'
import { FileDiff, FileText, Files, Globe, Plus, SquareTerminal, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useMediaQuery } from '../lib/use-media-query'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Sheet,
  SheetPopup,
} from '../ui'
import { ChangesPanel } from '../git/ChangesPanel'
import { FilesSurface } from './FilesSurface'
import { FilePreview } from './FilePreview'
import { surfaceForChord } from './surface-keys'
import { basename } from '../lib/paths'
import {
  activateWorkspaceSurface,
  closeAllWorkspaceSurfaces,
  closeOtherWorkspaceSurfaces,
  closeWorkspacePanel,
  closeWorkspaceSurface,
  closeWorkspaceSurfacesToRight,
  openWorkspaceFileSurface,
  openWorkspaceSurface,
  toggleWorkspaceSurface,
  useWorkspacePanel,
  type SingletonKind,
  type Surface,
} from './side-panel-store'
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  getPanelWidth,
  setPanelWidth,
} from './panel-width-store'

/** Windows this narrow present the panel as a slide-over Sheet (t3code's 980px break). */
const NARROW_QUERY = '(max-width: 980px)'

/**
 * The right-hand side panel as a t3code Sheet/tab surface stack (#193, ADR-0013 decision 1;
 * CONTEXT.md "Surface" / "Side panel"). Per-Workspace state (open flag + ordered Surfaces +
 * active id) lives in the shared `side-panel-store`; this component renders it and drives
 * ⌘P/⌃⇧G. Open Surfaces show as a TAB STRIP; with zero open, the panel shows the launcher
 * CARDS (its empty state). Review re-homes the git Changes panel behavior-identical
 * (#84–#88, ADR-0008); Files is the searchable tree (#188); Terminal/Browser are inert.
 *
 * Presentation is DUAL: inline beside the conversation on wide windows — a full-height,
 * flush, `border-l`-separated column (t3code's editor-panel chrome) whose width is
 * DRAG-RESIZABLE on its left edge (`panel-width-store`: default 540, min 360, max 70% of
 * the viewport, persisted per-window) — and inside a Sheet (right-edge slide-over, dimmed/
 * blurred backdrop, Esc/outside-click closes) on narrow ones; the SAME `PanelBody` feeds
 * both. Rendered by `ConnectedWorkspace` for the active/connected Workspace only. Stays
 * MOUNTED even while closed so the ⌘P/⌃⇧G listener stays live (a matched chord toggles
 * the Surface, opening a closed panel).
 */
export function SurfacePanel({
  workspaceId,
  workspaceDir,
  agentId,
  activeThreadId,
  isActive,
  busy,
}: {
  workspaceId: string
  workspaceDir: string
  /** The warm agent handle — Files addresses `files:list`/`files:read` by this (confinement, #188 F3). */
  agentId: string
  /** The live Thread whose composer a file preview's Insert-@path targets (#189); null when none. */
  activeThreadId: string | null
  /** Whether this is the on-screen Workspace (#84) — gates git streaming AND shortcuts. */
  isActive: boolean
  /** Whether a turn is streaming (#86) — threaded to the Review panel's commit guard. */
  busy: boolean
}): JSX.Element | null {
  const panel = useWorkspacePanel(workspaceId)
  const narrow = useMediaQuery(NARROW_QUERY)

  // Renderer-level shortcuts (NO Electron accelerators): ⌘P for Files, ⌃⇧G for Review.
  // Gated on `isActive` so a backgrounded (mounted-hidden) Workspace never grabs keys;
  // live even while the panel is CLOSED (this component stays mounted). The store's pure
  // `toggleSurface` op resolves the closed-panel / active-tab / other-tab cases. Both
  // chords carry a modifier, so a focused textarea is intentionally NOT exempt (⌘P must
  // open Files while composing). We preventDefault the match to stop the ⌘P print dialog.
  useEffect(() => {
    if (!isActive) return
    function onKeyDown(e: KeyboardEvent): void {
      const kind = surfaceForChord(e)
      if (!kind) return
      e.preventDefault()
      toggleWorkspaceSurface(workspaceId, kind)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive, workspaceId])

  // A BACKGROUND Workspace renders nothing (#193 review MUST-FIX): App keeps it mounted
  // inside a `hidden` wrapper, but base-ui's Dialog PORTALS to document.body — a
  // backgrounded Workspace's left-open Sheet would escape the wrapper and paint a modal
  // backdrop over the active Workspace (stacking per background Workspace). The keydown
  // effect above already no-ops when inactive, so returning null here only drops DOM —
  // the per-Workspace panel STATE survives in the store for its next activation. (Also
  // skips mounting a hidden inline PanelBody — needless DOM.) AFTER the hooks: hook order.
  if (!isActive) return null

  // Content mounts ONLY while open: this keeps the Review Surface's git subscription
  // (gated on `isActive` inside ChangesPanel) from running behind a closed panel, so the
  // git behaviour stays frozen (#84/ADR-0008). A closed wide panel renders nothing; a
  // closed narrow Sheet renders its empty shell.
  const body = panel.isOpen ? (
    <PanelBody
      mode={narrow ? 'sheet' : 'inline'}
      workspaceId={workspaceId}
      workspaceDir={workspaceDir}
      agentId={agentId}
      activeThreadId={activeThreadId}
      isActive={isActive}
      busy={busy}
      panel={panel}
    />
  ) : null

  if (narrow) {
    return (
      <Sheet
        open={panel.isOpen}
        onOpenChange={(open) => {
          if (!open) closeWorkspacePanel(workspaceId)
        }}
      >
        <SheetPopup keepMounted aria-label="Side panel">
          {body}
        </SheetPopup>
      </Sheet>
    )
  }

  return body
}

/**
 * The panel's content, shared across both presentations: the full-height SHELL (t3code's
 * `PreviewPanelShell`) holding either the tab strip + active Surface (≥1 Surface open) or
 * the centered launcher grid (zero open). Inline, the shell is a flush `border-l` column
 * at the drag-resizable width (left-edge handle: pointer-captured drag, clamp to the
 * viewport-relative range, persist on release, double-click resets — the sidebar's
 * #drag-to-resize pattern mirrored). In a Sheet the popup owns width + chrome, so the
 * shell just fills it (no handle, no border).
 */
function PanelBody({
  mode,
  workspaceId,
  workspaceDir,
  agentId,
  activeThreadId,
  isActive,
  busy,
  panel,
}: {
  mode: 'inline' | 'sheet'
  workspaceId: string
  workspaceDir: string
  agentId: string
  activeThreadId: string | null
  isActive: boolean
  busy: boolean
  panel: ReturnType<typeof useWorkspacePanel>
}): JSX.Element {
  const inline = mode === 'inline'
  const [width, setWidth] = useState(() => getPanelWidth(window.localStorage, window.innerWidth))
  const [dragging, setDragging] = useState(false)
  const dragOrigin = useRef<{ x: number; width: number } | null>(null)

  function onHandlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    dragOrigin.current = { x: e.clientX, width }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHandlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    const origin = dragOrigin.current
    if (!origin) return
    // The handle rides the panel's LEFT edge: dragging left (negative clientX delta)
    // grows the panel. Clamped live so the drag can never overshoot the range.
    setWidth(clampPanelWidth(origin.width + (origin.x - e.clientX), window.innerWidth))
  }
  function endDrag(e: PointerEvent<HTMLDivElement>): void {
    if (!dragOrigin.current) return
    dragOrigin.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Persist the settled width (best-effort). Read from state via the setter to avoid
    // a stale closure — setWidth's identity update returns the current value.
    setWidth((current) => {
      setPanelWidth(window.localStorage, current, window.innerWidth)
      return current
    })
  }
  function resetWidth(): void {
    const fallback = clampPanelWidth(DEFAULT_PANEL_WIDTH, window.innerWidth)
    setWidth(fallback)
    setPanelWidth(window.localStorage, fallback, window.innerWidth)
  }

  const active = panel.surfaces.find((s) => s.id === panel.activeSurfaceId) ?? null

  return (
    <aside
      aria-label="Side panel"
      style={inline ? { width } : undefined}
      className={cn(
        'relative flex h-full min-h-0 flex-col bg-panel text-text',
        inline ? 'shrink-0 self-stretch border-l border-border' : 'w-full',
        dragging && 'select-none',
      )}
    >
      {/* Resize handle (inline only): an 8px invisible hit strip straddling the left
          border, its visible affordance a 1px seam that lights on hover/drag. */}
      {inline && (
        <div
          aria-hidden
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetWidth}
          className={cn(
            'absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none [-webkit-app-region:no-drag]',
            'after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors after:content-[""] hover:after:bg-accent/40',
            dragging && 'after:bg-accent/60',
          )}
        />
      )}
      {panel.surfaces.length === 0 ? (
        <LauncherGrid onOpen={(kind) => openWorkspaceSurface(workspaceId, kind)} />
      ) : (
        <>
          <SurfaceTabStrip
            surfaces={panel.surfaces}
            activeSurfaceId={panel.activeSurfaceId}
            onActivate={(id) => activateWorkspaceSurface(workspaceId, id)}
            onClose={(id) => closeWorkspaceSurface(workspaceId, id)}
            onCloseOthers={(id) => closeOtherWorkspaceSurfaces(workspaceId, id)}
            onCloseToRight={(id) => closeWorkspaceSurfacesToRight(workspaceId, id)}
            onCloseAll={() => closeAllWorkspaceSurfaces(workspaceId)}
            onOpen={(kind) => openWorkspaceSurface(workspaceId, kind)}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {active?.kind === 'review' && (
              <ChangesPanel
                workspaceDir={workspaceDir}
                isActive={isActive}
                busy={busy}
                onCollapse={() => closeWorkspaceSurface(workspaceId, 'review')}
              />
            )}
            {active?.kind === 'files' && (
              // The Files Surface tree (#188). It only mounts here — when `files` is the ACTIVE
              // tab and the panel is open — and focuses its own search on mount, so ⌘P (which
              // opens/activates Files via the store) and a Files card/tab click both land in a
              // search-focused tree (ADR-0013 decision 1), with no per-trigger plumbing.
              // Selecting a file opens a panel-level `file:` Surface (a preview tab) via the
              // store — dedupes on the path, so re-selecting an open file just re-activates it.
              <FilesSurface
                onCollapse={() => closeWorkspaceSurface(workspaceId, 'files')}
                agentId={agentId}
                onOpenFile={(relativePath) => openWorkspaceFileSurface(workspaceId, relativePath)}
              />
            )}
            {active?.kind === 'file' && (
              // A read-only file preview tab (#189): fetches the confined `files:read` and renders
              // the highlighted content (or a binary/too-large/error notice), keyed by the path so a
              // tab switch remounts a fresh fetch.
              <FilePreview
                key={active.id}
                agentId={agentId}
                relativePath={active.relativePath}
                activeThreadId={activeThreadId}
              />
            )}
          </div>
        </>
      )}
    </aside>
  )
}

/** A Surface's tab-strip presentation: its kind icon + a short human label. */
function surfaceMeta(surface: Surface): { icon: ReactNode; label: string } {
  switch (surface.kind) {
    case 'review':
      return { icon: <FileDiff aria-hidden />, label: 'Review' }
    case 'files':
      return { icon: <Files aria-hidden />, label: 'Files' }
    case 'file':
      return { icon: <FileText aria-hidden />, label: basename(surface.relativePath) }
    case 'terminal':
      return { icon: <SquareTerminal aria-hidden />, label: 'Terminal' }
    case 'browser':
      return { icon: <Globe aria-hidden />, label: 'Browser' }
  }
}

/**
 * The tab strip across the panel top (t3code `RightPanelTabs`): one tab per open Surface —
 * kind icon + label + a close ×, the active tab visually distinct. Clicking a tab activates
 * it; MIDDLE-click closes it (t3code's aux-click); right-click opens a context menu (Close /
 * Close others / Close to the right / Close all). A trailing "+" menu (t3code's add-surface
 * button) opens another Surface without going back through the launcher. A `tablist` /
 * `tab` a11y contract with `aria-selected` on the active tab.
 */
function SurfaceTabStrip({
  surfaces,
  activeSurfaceId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onOpen,
}: {
  surfaces: Surface[]
  activeSurfaceId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseToRight: (id: string) => void
  onCloseAll: () => void
  onOpen: (kind: SingletonKind) => void
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Open surfaces"
      className="flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-panel px-2 py-1.5"
    >
      {surfaces.map((surface, index) => {
        const active = surface.id === activeSurfaceId
        const { icon, label } = surfaceMeta(surface)
        return (
          <ContextMenu key={surface.id}>
            <ContextMenuTrigger
              onAuxClick={(e) => {
                // Middle-click closes the tab (t3code parity); right-click is the menu's.
                if (e.button === 1) onClose(surface.id)
              }}
              className={cn(
                'group flex h-7 min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px] transition-colors',
                '[&_svg]:size-3.5 [&_svg]:shrink-0',
                active
                  ? 'bg-accent/15 text-text-strong'
                  : 'text-muted hover:bg-accent/10 hover:text-text',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onActivate(surface.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
              >
                {icon}
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              </button>
              <button
                type="button"
                onClick={() => onClose(surface.id)}
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded outline-none hover:bg-accent/20',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onClose(surface.id)}>Close</ContextMenuItem>
              <ContextMenuItem onClick={() => onCloseOthers(surface.id)} disabled={surfaces.length <= 1}>
                Close others
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onCloseToRight(surface.id)}
                disabled={index >= surfaces.length - 1}
              >
                Close to the right
              </ContextMenuItem>
              <ContextMenuItem onClick={onCloseAll}>Close all</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
      {/* Add-surface "+" (t3code): opens/activates a Surface directly from the strip.
          The store dedupes singletons, so picking an already-open kind just activates it. */}
      <Menu>
        <MenuTrigger
          aria-label="Open a surface"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10"
        >
          <Plus className="size-4" aria-hidden />
        </MenuTrigger>
        <MenuContent align="start">
          {CARDS.map((card) => (
            <MenuItem
              key={card.label}
              disabled={!card.live}
              onClick={card.live ? () => onOpen(card.target as SingletonKind) : undefined}
            >
              <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted">
                {card.icon}
                {card.label}
                {!card.live && <span className="text-[11px] font-medium text-faint">Soon</span>}
              </span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  )
}

/** A launcher card's definition. Live cards open a Surface; inert ones are reserved. */
interface CardDef {
  /** The live Surface it opens, or a reserved slot with no Surface kind yet. */
  target: SingletonKind | 'terminal' | 'browser'
  label: string
  description: string
  icon: ReactNode
  /** The keyboard-shortcut hint (aspirational chrome for the inert Browser card). */
  hint?: string
  live: boolean
}

const CARDS: readonly CardDef[] = [
  {
    target: 'review',
    label: 'Review',
    description: 'Inspect and commit working-tree changes.',
    icon: <FileDiff aria-hidden />,
    hint: '⌃⇧G',
    live: true,
  },
  {
    target: 'terminal',
    label: 'Terminal',
    description: 'Run commands in the Workspace.',
    icon: <SquareTerminal aria-hidden />,
    live: false,
  },
  {
    target: 'browser',
    label: 'Browser',
    description: 'Preview a local dev server.',
    icon: <Globe aria-hidden />,
    hint: '⌘T',
    live: false,
  },
  {
    target: 'files',
    label: 'Files',
    description: 'Browse and preview Workspace files.',
    icon: <Files aria-hidden />,
    hint: '⌘P',
    live: true,
  },
]

/**
 * The launcher EMPTY STATE (panel open, zero Surfaces) — t3code's `RightPanelEmptyState`:
 * a centered "Open a surface" heading over a 2-column grid of cards (leading icon, label +
 * shortcut hint, a short description). Live cards open their Surface; the inert Terminal/
 * Browser cards are disabled + tagged "Soon" (the sidebar PlaceholderNav precedent).
 * Opening one replaces the grid with the tab strip; closing the last tab returns here.
 */
function LauncherGrid({ onOpen }: { onOpen: (kind: SingletonKind) => void }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-text-strong">Open a surface</h3>
          <p className="mt-1 text-xs text-muted">Choose what to show in the side panel.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CARDS.map((card) => (
            <LauncherCard
              key={card.label}
              card={card}
              onClick={card.live ? () => onOpen(card.target as SingletonKind) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One launcher card. A live card is a real button opening its Surface; an inert card is
 * disabled + `aria-disabled` with a muted "Soon" tag, so it reads as intentionally
 * reserved rather than broken. Shortcut hints render as small muted keycaps either way.
 */
function LauncherCard({ card, onClick }: { card: CardDef; onClick?: () => void }): JSX.Element {
  const inert = onClick === undefined
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inert}
      aria-disabled={inert || undefined}
      title={inert ? 'Coming soon' : card.label}
      className={cn(
        'flex min-h-28 w-full flex-col items-start rounded-lg border border-border bg-surface p-4 text-left outline-none transition-colors',
        '[&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted',
        inert
          ? 'cursor-default opacity-50'
          : 'hover:bg-accent/10 focus-visible:bg-accent/10 [&_svg]:hover:text-text-strong',
      )}
    >
      <span className="mb-3">{card.icon}</span>
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{card.label}</span>
        {card.hint && (
          <kbd className="shrink-0 rounded-md text-[11px] font-medium tabular-nums text-faint">{card.hint}</kbd>
        )}
        {inert && <span className="shrink-0 text-[11px] font-medium text-faint">Soon</span>}
      </span>
      <span className="mt-1 text-xs leading-relaxed text-muted">{card.description}</span>
    </button>
  )
}
