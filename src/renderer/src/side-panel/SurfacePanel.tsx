import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { FileDiff, Files, Globe, SquareTerminal } from 'lucide-react'
import { cn } from '../lib/utils'
import { ChangesPanel } from '../git/ChangesPanel'
import { FilesSurface } from './FilesSurface'
import { surfaceForChord } from './surface-keys'
import { resolveSurfaceChord, type ExpandedSurface, type Surface } from './surface-model'
import { getSurfaceState, setSurfaceState } from './surface-state-store'

/**
 * The right-hand side panel as a Surface stack (#187, ADR-0013 decision 1; CONTEXT.md
 * "Surface"). The PANEL ITSELF is toggled from the window header's PanelRight icon and
 * is CLOSED by default (#187 follow-up — `open`/`onOpenChange` are owned by App next to
 * the sidebar toggle, persisted app-globally). Open, it renders four launcher CARDS —
 * Review (⌃⇧G), Terminal, Browser (⌘T), Files (⌘P) — top-aligned; at most ONE Surface is
 * expanded at a time and the cards show only when NONE is. Review re-homes the existing
 * git Changes panel behavior-identical (#84–#88); Files expands to a slice-2 placeholder;
 * Terminal and Browser are inert "Soon" cards (the sidebar Search/Scheduled/Plugins
 * precedent).
 *
 * The expanded choice persists PER Workspace across restart (localStorage, throw-tolerant
 * injected-storage store). Because App keys each `ConnectedWorkspace` (hence this panel)
 * by `agentId`, every Workspace has its own instance seeding from its own stored entry —
 * so switching Workspace restores that Workspace's Surface with no extra plumbing.
 *
 * Rendered by `ConnectedWorkspace` for the active/connected Workspace only. When the
 * panel is closed it renders NOTHING but stays mounted, so the shortcut listener stays
 * live — ⌘P/⌃⇧G resolve through the pure `resolveSurfaceChord` (closed → open with that
 * Surface; same Surface → close; other → switch). The state machine is the pure
 * `surface-model`; this component is a thin switch over it plus the keyboard handler.
 */
export function SurfacePanel({
  workspaceId,
  workspaceDir,
  isActive,
  busy,
  open,
  onOpenChange,
}: {
  workspaceId: string
  workspaceDir: string
  /** Whether this is the on-screen Workspace (#84) — gates git streaming AND shortcuts. */
  isActive: boolean
  /** Whether a turn is streaming (#86) — threaded to the Review panel's commit guard. */
  busy: boolean
  /** Whether the side panel is showing at all — App owns it (header PanelRight icon). */
  open: boolean
  /** Ask App to open/close the panel (a shortcut resolving across the closed state). */
  onOpenChange: (open: boolean) => void
}): JSX.Element | null {
  const [expanded, setExpanded] = useState<ExpandedSurface>(() =>
    getSurfaceState(window.localStorage, workspaceId),
  )

  // Set + persist together so the per-Workspace choice survives restart (ADR-0013).
  function apply(next: ExpandedSurface): void {
    setExpanded(next)
    setSurfaceState(window.localStorage, workspaceId, next)
  }

  // Renderer-level shortcuts (NO Electron accelerators): ⌘P for Files, ⌃⇧G for Review,
  // resolved against the WHOLE panel state (closed → open+Surface; same → close panel;
  // other → switch). Gated on `isActive` so a backgrounded (mounted-hidden) Workspace
  // never grabs keys; live even while the panel is CLOSED (this component stays mounted
  // rendering null). Both chords carry a modifier, so plain typing never matches — a
  // focused textarea is intentionally NOT exempt (⌘P must open Files even while
  // composing); the composer's own Enter/Esc handling is untouched (those chords aren't
  // ours). We preventDefault the match to stop the browser's ⌘P print dialog.
  useEffect(() => {
    if (!isActive) return
    function onKeyDown(e: KeyboardEvent): void {
      const surface = surfaceForChord(e)
      if (!surface) return
      e.preventDefault()
      const next = resolveSurfaceChord({ open, expanded }, surface)
      setExpanded(next.expanded)
      setSurfaceState(window.localStorage, workspaceId, next.expanded)
      if (next.open !== open) onOpenChange(next.open)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // `expanded` in deps: the listener re-binds on each change (cheap) so the chord
    // always resolves against fresh state without side effects inside an updater.
  }, [isActive, workspaceId, open, expanded, onOpenChange])

  // Closed panel: render nothing, keep the listener (the effect above) alive.
  if (!open) return null

  if (expanded === 'review') {
    // The Review Surface IS the existing Changes panel, behavior-identical (#84–#88). It
    // sizes itself (w-80 list / flex-1 diff); its header collapse returns to the stack.
    return <ChangesPanel workspaceDir={workspaceDir} isActive={isActive} busy={busy} onCollapse={() => apply(null)} />
  }

  if (expanded === 'files') {
    return <FilesSurface onCollapse={() => apply(null)} />
  }

  return <SurfaceStack onOpen={(surface) => apply(surface)} />
}

/** A launcher card's definition. Live cards open a Surface; inert ones are reserved. */
interface CardDef {
  /** The live Surface it opens, or a reserved slot with no expanded state. */
  target: Surface | 'terminal' | 'browser'
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
 * The collapsed card stack: full-width rounded launcher rows on the panel background,
 * top-aligned (leading icon + label, trailing shortcut hint). Live cards open their
 * Surface; the inert Terminal/Browser cards are disabled + `aria-disabled` and tagged
 * "Soon" (the sidebar PlaceholderNav precedent).
 */
function SurfaceStack({ onOpen }: { onOpen: (surface: Surface) => void }): JSX.Element {
  return (
    <aside
      aria-label="Side panel"
      className="flex w-80 shrink-0 flex-col gap-2 self-stretch border-l border-border bg-panel p-3 text-text"
    >
      {CARDS.map((card) => (
        <LauncherCard
          key={card.label}
          card={card}
          onClick={card.live ? () => onOpen(card.target as Surface) : undefined}
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
