import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import {
  IPC,
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
    const agentId = `a${++agentCounterSeed}`
    const agent = new WorkspaceAgent({ workspaceDir: args.workspaceDir, env: getShellEnv() })

    agent.on('event', (payload: unknown) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.acpEvent, { agentId, payload })
      }
    })

    try {
      await agent.start()
      const thread = await agent.openThread()
      agents.set(agentId, agent)
      return { ok: true, thread: { agentId, workspaceDir: args.workspaceDir, ...thread } }
    } catch (err) {
      agent.stop()
      if (err instanceof WorkspaceAgentError) {
        return { ok: false, error: err.message, hint: err.hint }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err), hint: null }
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
  for (const agent of agents.values()) agent.stop()
  agents.clear()
  if (process.platform !== 'darwin') app.quit()
})
