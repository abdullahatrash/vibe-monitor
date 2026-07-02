import { useEffect, type JSX, type ReactNode } from 'react'
import { FileDiff, Files, Globe, SquareTerminal, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useMediaQuery } from '../lib/use-media-query'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Sheet,
  SheetPopup,
} from '../ui'
import { ChangesPanel } from '../git/ChangesPanel'
import { FilesSurface } from './FilesSurface'
import { surfaceForChord } from './surface-keys'
import {
  activateWorkspaceSurface,
  closeAllWorkspaceSurfaces,
  closeOtherWorkspaceSurfaces,
  closeWorkspacePanel,
  closeWorkspaceSurface,
  closeWorkspaceSurfacesToRight,
  openWorkspaceSurface,
  toggleWorkspaceSurface,
  useWorkspacePanel,
  type SingletonKind,
  type Surface,
} from './side-panel-store'

/** Windows this narrow present the panel as a slide-over Sheet (t3code's 980px break). */
const NARROW_QUERY = '(max-width: 980px)'

/**
 * The right-hand side panel as a t3code Sheet/tab surface stack (#193, ADR-0013 decision 1;
 * CONTEXT.md "Surface" / "Side panel"). Per-Workspace state (open flag + ordered Surfaces +
 * active id) lives in the shared `side-panel-store`; this component renders it and drives
 * ⌘P/⌃⇧G. Open Surfaces show as a TAB STRIP; with zero open, the panel shows the launcher
 * CARDS (its empty state). Review re-homes the git Changes panel behavior-identical
 * (#84–#88, ADR-0008); Files is the slice-2 placeholder; Terminal/Browser are inert.
 *
 * Presentation is DUAL: inline beside the conversation on wide windows, and inside a Sheet
 * (right-edge slide-over, dimmed/blurred backdrop, Esc/outside-click closes) on narrow ones
 * — the SAME `PanelBody` feeds both. Rendered by `ConnectedWorkspace` for the active/
 * connected Workspace only. Stays MOUNTED even while closed so the ⌘P/⌃⇧G listener stays
 * live (a matched chord toggles the Surface, opening a closed panel).
 */
export function SurfacePanel({
  workspaceId,
  workspaceDir,
  isActive,
  busy,
}: {
  workspaceId: string
  workspaceDir: string
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
    <PanelBody workspaceId={workspaceId} workspaceDir={workspaceDir} isActive={isActive} busy={busy} panel={panel} />
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
 * The panel's content, shared across both presentations: the tab strip + active Surface
 * when ≥1 Surface is open, or the launcher cards (empty state) when none is. A fixed-width
 * (`w-80`) column; the active Surface brings its own header + border/bg (frozen chrome).
 */
function PanelBody({
  workspaceId,
  workspaceDir,
  isActive,
  busy,
  panel,
}: {
  workspaceId: string
  workspaceDir: string
  isActive: boolean
  busy: boolean
  panel: ReturnType<typeof useWorkspacePanel>
}): JSX.Element {
  if (panel.surfaces.length === 0) {
    return <LauncherCards onOpen={(kind) => openWorkspaceSurface(workspaceId, kind)} />
  }

  const active = panel.surfaces.find((s) => s.id === panel.activeSurfaceId) ?? null

  return (
    <div className="flex min-h-0 w-80 shrink-0 flex-col self-stretch">
      <SurfaceTabStrip
        surfaces={panel.surfaces}
        activeSurfaceId={panel.activeSurfaceId}
        onActivate={(id) => activateWorkspaceSurface(workspaceId, id)}
        onClose={(id) => closeWorkspaceSurface(workspaceId, id)}
        onCloseOthers={(id) => closeOtherWorkspaceSurfaces(workspaceId, id)}
        onCloseToRight={(id) => closeWorkspaceSurfacesToRight(workspaceId, id)}
        onCloseAll={() => closeAllWorkspaceSurfaces(workspaceId)}
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
        {active?.kind === 'files' && <FilesSurface onCollapse={() => closeWorkspaceSurface(workspaceId, 'files')} />}
      </div>
    </div>
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
      return { icon: <Files aria-hidden />, label: surface.relativePath.slice(surface.relativePath.lastIndexOf('/') + 1) }
    case 'terminal':
      return { icon: <SquareTerminal aria-hidden />, label: 'Terminal' }
    case 'browser':
      return { icon: <Globe aria-hidden />, label: 'Browser' }
  }
}

/**
 * The tab strip across the panel top (t3code `RightPanelTabs`): one tab per open Surface —
 * kind icon + label + a close ×, the active tab visually distinct. Clicking a tab activates
 * it; right-click opens a context menu (Close / Close others / Close to the right). A
 * `tablist` / `tab` a11y contract with `aria-selected` on the active tab.
 */
function SurfaceTabStrip({
  surfaces,
  activeSurfaceId,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
}: {
  surfaces: Surface[]
  activeSurfaceId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseToRight: (id: string) => void
  onCloseAll: () => void
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Open surfaces"
      className="flex w-80 shrink-0 items-center gap-1 overflow-x-auto border-b border-l border-border bg-panel px-2 py-1.5"
    >
      {surfaces.map((surface, index) => {
        const active = surface.id === activeSurfaceId
        const { icon, label } = surfaceMeta(surface)
        return (
          <ContextMenu key={surface.id}>
            <ContextMenuTrigger
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
    </div>
  )
}

/** A launcher card's definition. Live cards open a Surface; inert ones are reserved. */
interface CardDef {
  /** The live Surface it opens, or a reserved slot with no Surface kind yet. */
  target: SingletonKind | 'terminal' | 'browser'
  label: string
  icon: ReactNode
  /** The keyboard-shortcut hint (aspirational chrome for the inert Browser card). */
  hint?: string
  live: boolean
}

const CARDS: readonly CardDef[] = [
  { target: 'review', label: 'Review', icon: <FileDiff aria-hidden />, hint: '⌃⇧G', live: true },
  { target: 'terminal', label: 'Terminal', icon: <SquareTerminal aria-hidden />, live: false },
  { target: 'browser', label: 'Browser', icon: <Globe aria-hidden />, hint: '⌘T', live: false },
  { target: 'files', label: 'Files', icon: <Files aria-hidden />, hint: '⌘P', live: true },
]

/**
 * The launcher-card EMPTY STATE (panel open, zero Surfaces): full-width rounded launcher
 * rows on the panel background, top-aligned (leading icon + label, trailing shortcut hint).
 * Live cards open their Surface; the inert Terminal/Browser cards are disabled + tagged
 * "Soon" (the sidebar PlaceholderNav precedent). Opening one replaces the cards with the
 * tab strip; closing the last tab returns here.
 */
function LauncherCards({ onOpen }: { onOpen: (kind: SingletonKind) => void }): JSX.Element {
  return (
    <aside
      aria-label="Side panel"
      className="flex w-80 shrink-0 flex-col gap-2 self-stretch border-l border-border bg-panel p-3 text-text"
    >
      {CARDS.map((card) => (
        <LauncherCard
          key={card.label}
          card={card}
          onClick={card.live ? () => onOpen(card.target as SingletonKind) : undefined}
        />
      ))}
    </aside>
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
        'flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 text-left text-[14px] text-text outline-none transition-colors',
        '[&_svg]:size-[18px] [&_svg]:shrink-0 [&_svg]:text-muted',
        inert
          ? 'cursor-default opacity-60'
          : 'hover:bg-accent/10 focus-visible:bg-accent/10 [&_svg]:hover:text-text-strong',
      )}
    >
      {card.icon}
      <span className="min-w-0 flex-1 truncate font-medium">{card.label}</span>
      {card.hint && (
        <kbd className="shrink-0 rounded-md px-1 text-[11px] font-medium tabular-nums text-faint">{card.hint}</kbd>
      )}
      {inert && <span className="shrink-0 text-[11px] font-medium text-faint">Soon</span>}
    </button>
  )
}
