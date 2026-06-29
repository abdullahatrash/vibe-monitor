import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type OpenThreadArgs,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadConnection,
  type ThreadInfo,
} from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'

/** Active Workspace agents keyed by a generated agent id. */
const agents = new Map<string, WorkspaceAgent>()

/** Build the renderer-facing connection (carries the sign-out gate + methods). */
function connectionFor(agentId: string, agent: WorkspaceAgent, thread: ThreadInfo): ThreadConnection {
  return {
    agentId,
    workspaceDir: agent.workspaceDir,
    ...thread,
    signOutAvailable: agent.signOutAvailable,
    authMethods: agent.authMethods,
  }
}

/**
 * Map a thread-open failure to a result. An auth-classified error (a -32000
 * mid-session/expiry) keeps the agent ALIVE and routes to the sign-in panel;
 * any other failure stops + disposes the agent.
 */
function threadFailureResult(agentId: string, agent: WorkspaceAgent, err: unknown): StartThreadResult {
  if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
    // Keep the agent alive AND registered so the renderer's follow-up
    // signIn({agentId}) finds it. Idempotent: startThread already registers on a
    // successful start(), but a -32000 thrown from start() itself reaches here
    // before that, so without this the child would leak + the button would dead-end.
    agents.set(agentId, agent)
    return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: agent.workspaceDir, authMethods: agent.authMethods }
  }
  agent.stop()
  agents.delete(agentId)
  if (err instanceof WorkspaceAgentError) return { ok: false, kind: 'error', error: err.message, hint: err.hint }
  return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err), hint: null }
}

/** Stop + drop any live agent bound to this workspace (dedup before re-spawn). */
function disposeAgentsForWorkspace(workspaceDir: string): void {
  for (const [id, agent] of agents) {
    if (agent.workspaceDir !== workspaceDir) continue
    agent.stop()
    agents.delete(id)
  }
}
let agentCounterSeed = 0

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.detectVibe, () => detectVibe())

  ipcMain.handle(IPC.openWorkspaceDialog, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.startThread, async (event, args: StartThreadArgs): Promise<StartThreadResult> => {
    // Dedup: dispose any existing agent for this workspace before spawning, so a
    // re-Connect (e.g. after a not-signed-in panel) can't orphan the previous child.
    disposeAgentsForWorkspace(args.workspaceDir)

    const agentId = `a${++agentCounterSeed}`
    const agent = new WorkspaceAgent({
      workspaceDir: args.workspaceDir,
      env: getShellEnv(),
      // Delegated sign-in (#12): open the returned signInUrl in the system browser.
      openUrl: (url) => void shell.openExternal(url),
    })

    agent.on('event', (payload: unknown) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.acpEvent, { agentId, payload })
      }
    })

    try {
      await agent.start()
      agents.set(agentId, agent)

      // Detected not-signed-in: keep the agent (the sign-in flow drives it) but
      // don't open a Thread — session/new would fail with -32000. The renderer
      // shows the sign-in panel and re-tries openThread after sign-in.
      if (agent.authState === 'not-signed-in') {
        return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: args.workspaceDir, authMethods: agent.authMethods }
      }

      const thread = await agent.openThread()
      return { ok: true, thread: connectionFor(agentId, agent, thread) }
    } catch (err) {
      return threadFailureResult(agentId, agent, err)
    }
  })

  ipcMain.handle(IPC.openThread, async (_event, args: OpenThreadArgs): Promise<StartThreadResult> => {
    // Open a Thread on an agent already started + signed in (after sign-in or an
    // in-place re-auth). Reuses the retained agent — no re-spawn.
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.`, hint: null }
    try {
      const thread = await agent.openThread()
      return { ok: true, thread: connectionFor(args.agentId, agent, thread) }
    } catch (err) {
      return threadFailureResult(args.agentId, agent, err)
    }
  })

  ipcMain.handle(
    IPC.sendPrompt,
    async (_event, args: SendPromptArgs): Promise<SendPromptResult> => {
      const agent = agents.get(args.agentId)
      if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.` }
      try {
        const result = await agent.prompt(args.sessionId, args.text)
        return { ok: true, result }
      } catch (err) {
        // Mid-session expiry (-32000): keep the agent alive so the renderer can
        // re-auth in place on the same agent; don't stop it.
        if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
          return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
        }
        return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(IPC.respondPermission, (_event, args: RespondPermissionArgs) => {
    // Main only relays the user's choice back to the agent by request id; the
    // approve/deny decision lives in the renderer (ADR-0001).
    const agent = agents.get(args.agentId)
    agent?.respondPermission(args.requestId, args.optionId)
  })

  ipcMain.handle(IPC.signIn, async (_event, args: SignInArgs): Promise<SignInResult> => {
    // Drive Vibe's browser sign-in on the agent retained from startThread; main
    // orchestrates + relays the resulting AuthState, the renderer owns the view
    // state (ADR-0001). Credentials never touch us — Vibe owns the keyring (ADR-0003).
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    try {
      const authState = await agent.signIn(args.methodId)
      return { ok: true, authState }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.signOut, async (_event, args: SignOutArgs): Promise<SignOutResult> => {
    // Sign out via Vibe's keyring removal and relay the new state; the agent
    // stays alive so the user can sign a different account back in (ADR-0003).
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    try {
      const authState = await agent.signOut()
      return { ok: true, authState, authMethods: agent.authMethods }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.stopAgent, (_event, agentId: string) => {
    const agent = agents.get(agentId)
    agent?.stop()
    agents.delete(agentId)
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // The agents Map is process-global, which is fine for single-window TB1.
  // A future multi-window slice should track + dispose agents per window.
  for (const agent of agents.values()) agent.stop()
  agents.clear()
  if (process.platform !== 'darwin') app.quit()
})
