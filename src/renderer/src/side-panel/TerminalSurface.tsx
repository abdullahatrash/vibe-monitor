import { useEffect, useRef, useState, type JSX } from 'react'
import { Eraser, RotateCcw } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { cn } from '../lib/utils'

/**
 * The Terminal Surface (ADR-0014): an xterm.js view over the Workspace's shell
 * session hosted in MAIN. The view is DISPOSABLE — the PTY and its scrollback
 * live behind the `terminal:*` IPC, so mounting is open-OR-REATTACH (the reply's
 * snapshot replays the buffer) and unmounting (tab switch / panel close) leaves
 * the shell running. Only the tab's explicit close × kills it (SurfacePanel
 * invokes `terminalClose` alongside the store op).
 *
 * A thin toolbar carries the Clear and Restart affordances (slice 2): Clear wipes
 * the view + main's retained scrollback (shell keeps running); Restart kills and
 * respawns the shell in the same cwd (works even after the agent was evicted —
 * the cwd is the session's own).
 *
 * t3code parity choices (their ThreadTerminalDrawer): FitAddon only (no webgl/
 * search), 12px mono, 5k scrollback, theme read off our design tokens via
 * computed style at mount (live re-theme is slice 4), fit-then-resize on mount
 * and container resize.
 */
export function TerminalSurface({
  workspaceId,
  agentId,
}: {
  workspaceId: string
  /** The warm agent whose Workspace dir becomes the shell's cwd (#188 F3 addressing). */
  agentId: string
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // True once the shell has exited — gates input and re-enabled by a restart. A ref
  // so the toolbar handlers (outside the mount effect) share the mount effect's view.
  const exitedRef = useRef(false)
  // A spawn failure (no usable shell / cold agent) renders as a notice instead of a dead grid.
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const styles = getComputedStyle(container)
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: '"SF Mono", Monaco, Menlo, Consolas, "Liberation Mono", monospace',
      scrollback: 5_000,
      theme: {
        background: styles.backgroundColor,
        foreground: styles.color,
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    fit.fit()
    terminalRef.current = terminal
    fitRef.current = fit
    exitedRef.current = false

    let disposed = false

    // Subscribe BEFORE the open resolves so no output slips between the snapshot
    // and the live tail; filter to THIS Workspace's session (the acp:event pattern).
    const unsubscribe = window.api.onTerminalEvent((e) => {
      if (e.workspaceId !== workspaceId) return
      if (e.event.type === 'output') {
        terminal.write(e.event.data)
        return
      }
      // exited: banner + stop accepting input (the session's scrollback is
      // retained main-side; reopening the tab respawns a fresh shell).
      exitedRef.current = true
      terminal.write(`\r\n[2m[terminal] Process exited (code ${e.event.exitCode})[0m\r\n`)
    })

    void window.api
      .terminalOpen({ agentId, workspaceId, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) return
        if (!result.ok) {
          setOpenError(result.error)
          return
        }
        if (result.snapshot.length > 0) terminal.write(result.snapshot)
        // A reattach can land with a stale size (the panel was resized while the
        // view was unmounted) — refit and tell the PTY.
        fit.fit()
        void window.api.terminalResize({ workspaceId, cols: terminal.cols, rows: terminal.rows })
      })

    const dataDisposable = terminal.onData((data) => {
      if (exitedRef.current) return
      void window.api.terminalWrite({ workspaceId, data })
    })

    // Follow the panel's drag-resize / window resize: refit the grid, then push
    // the new dimensions to the PTY so full-screen programs reflow.
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return
      fit.fit()
      void window.api.terminalResize({ workspaceId, cols: terminal.cols, rows: terminal.rows })
    })
    resizeObserver.observe(container)

    terminal.focus()

    return () => {
      // View teardown ONLY — the session keeps running for the next reattach.
      disposed = true
      resizeObserver.disconnect()
      dataDisposable.dispose()
      unsubscribe()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [workspaceId, agentId])

  // Clear: wipe main's retained scrollback (so a reattach starts blank) and the
  // visible view. The shell keeps running — the next prompt is still live.
  function onClear(): void {
    void window.api.terminalClear({ workspaceId })
    terminalRef.current?.clear()
    terminalRef.current?.focus()
  }

  // Restart: respawn the shell in the same cwd. Reset the view up front, then on
  // the fresh session re-enable input and refit; a spawn failure shows the overlay.
  function onRestart(): void {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit) return
    fit.fit()
    void window.api
      .terminalRestart({ workspaceId, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (terminalRef.current !== terminal) return // unmounted mid-flight
        if (!result.ok) {
          setOpenError(result.error)
          return
        }
        terminal.reset()
        exitedRef.current = false
        terminal.focus()
      })
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1">
        <TerminalAction label="Clear" onClick={onClear}>
          <Eraser aria-hidden />
        </TerminalAction>
        <TerminalAction label="Restart" onClick={onRestart}>
          <RotateCcw aria-hidden />
        </TerminalAction>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1.5" />
      {openError && (
        <div className="absolute inset-0 flex items-center justify-center bg-panel p-6">
          <p className="max-w-sm text-center text-xs leading-relaxed text-muted">{openError}</p>
        </div>
      )}
    </div>
  )
}

/** A terminal toolbar icon button — muted, lights on hover (the panel's affordance idiom). */
function TerminalAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 items-center justify-center rounded text-muted outline-none transition-colors',
        'hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
      )}
    >
      {children}
    </button>
  )
}
