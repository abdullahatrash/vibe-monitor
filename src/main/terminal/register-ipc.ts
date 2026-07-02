import { BrowserWindow, ipcMain } from 'electron'
import { spawn } from 'node-pty'
import {
  IPC,
  type TerminalClearArgs,
  type TerminalCloseArgs,
  type TerminalEvent,
  type TerminalOpenArgs,
  type TerminalOpenResult,
  type TerminalResizeArgs,
  type TerminalRestartArgs,
  type TerminalWriteArgs,
} from '../../shared/ipc'
import type { AgentPool } from '../agent-pool'
import { getShellEnv } from '../shell-env'
import { TerminalManager } from './terminal-manager'

/**
 * The Workspace-terminal IPC handlers (ADR-0014), registered next to the manager
 * they pass through to. The shell's cwd is the warm agent's OWN `workspaceDir` —
 * resolved via `pool.get`, NOT a renderer-supplied path (the #188 F3 addressing
 * model) — so the renderer can only open a shell in a CONNECTED Workspace. The
 * shell itself is deliberately UNCONFINED (a full user shell, ADR-0014). Not
 * agent activity: no `pool.touch` — an open terminal never keeps a warm agent
 * alive (the SESSION's lifetime is already independent of the agent's).
 *
 * node-pty lives HERE (and only here): the manager takes it through the
 * `spawnPty` seam, keeping the native module out of the unit-test import graph.
 */

/**
 * The production manager: node-pty spawns (`xterm-256color`), env from the
 * login-shell probe (`getShellEnv` — PATH survives Finder/Dock launches), and
 * events broadcast to every window (single-window app; the renderer filters by
 * `workspaceId`, the `acp:event` pattern).
 */
export function createTerminalManager(): TerminalManager {
  return new TerminalManager({
    spawnPty: ({ file, args, cwd, env, cols, rows }) =>
      spawn(file, args, { name: 'xterm-256color', cwd, env, cols, rows }),
    env: getShellEnv(),
    emit: (event: TerminalEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.webContents.isDestroyed()) win.webContents.send(IPC.terminalEvent, event)
      }
    },
  })
}

export function registerTerminalIpc(deps: { pool: AgentPool; manager: TerminalManager }): void {
  ipcMain.handle(IPC.terminalOpen, (_event, args: TerminalOpenArgs): TerminalOpenResult => {
    // OPEN-or-REATTACH the Workspace's shell (ADR-0014). A live session replies
    // with its scrollback snapshot (the Surface remounted after a tab switch /
    // panel close); an exited or absent one spawns fresh. The cwd comes from the
    // pool — an unknown/cold agent refuses, so a stale renderer handle can't
    // spawn a shell with no Workspace behind it.
    const agent = deps.pool.get(args.agentId)
    if (!agent) return { ok: false, error: 'Workspace agent is not connected.' }
    return deps.manager.openOrAttach(args.workspaceId, {
      cwd: agent.workspaceDir,
      cols: args.cols,
      rows: args.rows,
    })
  })

  // Input/resize/close address the SESSION (workspaceId): they can only reach a
  // session a prior agent-addressed `open` created. Each is a bounded no-op on an
  // unknown session — never a throw into the renderer's fire-and-forget calls.
  ipcMain.handle(IPC.terminalWrite, (_event, args: TerminalWriteArgs): void => {
    deps.manager.write(args.workspaceId, args.data)
  })

  ipcMain.handle(IPC.terminalResize, (_event, args: TerminalResizeArgs): void => {
    deps.manager.resize(args.workspaceId, args.cols, args.rows)
  })

  ipcMain.handle(IPC.terminalClose, (_event, args: TerminalCloseArgs): void => {
    deps.manager.close(args.workspaceId)
  })

  ipcMain.handle(IPC.terminalClear, (_event, args: TerminalClearArgs): void => {
    // Reset the retained scrollback so a later reattach starts blank — the shell
    // keeps running; the renderer clears its own xterm view.
    deps.manager.clear(args.workspaceId)
  })

  ipcMain.handle(IPC.terminalRestart, (_event, args: TerminalRestartArgs): TerminalOpenResult => {
    // Kill + respawn the session's shell in its OWN cwd (stored at open) — no agent
    // needed, so restart works even after the warm agent was evicted. Replies with
    // the fresh session handle (snapshot empty) or a spawn error for the overlay.
    return deps.manager.restart(args.workspaceId, args.cols, args.rows)
  })
}
