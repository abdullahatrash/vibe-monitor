import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SignInArgs,
  type SignInResult,
  type StartThreadArgs,
  type StartThreadResult,
} from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'

/** Active Workspace agents keyed by a generated agent id. */
const agents = new Map<string, WorkspaceAgent>()
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
    // TODO(#12): a retained not-signed-in agent (below) is NOT deduped by
    // workspaceDir — we always mint a fresh agentId + spawn a new
    // WorkspaceAgent. Not reachable in this slice (the sign-in button is
    // inert), but once #12 makes it actionable a re-Connect to the same
    // workspace would orphan the previous not-signed-in agent (its child
    // lingers). #12 must reuse or stop the existing agent for this workspace.
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

      // Detected not-signed-in: keep the agent (the sign-in flow will drive it)
      // but don't open a Thread — session/new would fail with -32000. The
      // renderer shows the sign-in panel (ADR-0003: detection only here).
      if (agent.authState === 'not-signed-in') {
        agents.set(agentId, agent)
        return {
          ok: false,
          kind: 'not-signed-in',
          agentId,
          workspaceDir: args.workspaceDir,
          authMethods: agent.authMethods,
        }
      }

      const thread = await agent.openThread()
      agents.set(agentId, agent)
      return { ok: true, thread: { agentId, workspaceDir: args.workspaceDir, ...thread } }
    } catch (err) {
      agent.stop()
      // TODO(#12): fallback UX gap. When `_auth/status` returned `unknown` but
      // the user is actually signed out, `session/new` (openThread) fails with
      // -32000 and lands here — we surface it as a generic error alert (still
      // carrying AUTH_HINT) rather than the SignInPanel. Routing this auth-error
      // path to the panel requires keeping the agent alive (not stop()-ing it)
      // so the sign-in flow can drive it, which is coupled to the
      // agent-dedup/lifecycle work in #12.
      if (err instanceof WorkspaceAgentError) {
        return { ok: false, kind: 'error', error: err.message, hint: err.hint }
      }
      return {
        ok: false,
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
        hint: null,
      }
    }
  })

  ipcMain.handle(
    IPC.sendPrompt,
    async (_event, args: SendPromptArgs): Promise<SendPromptResult> => {
      const agent = agents.get(args.agentId)
      if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
      try {
        const result = await agent.prompt(args.sessionId, args.text)
        return { ok: true, result }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
