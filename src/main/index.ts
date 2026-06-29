import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type AcpStartArgs, type AcpStartResult } from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { AcpClient } from './acp/client'

/** Active ACP sessions keyed by a generated session id. */
const sessions = new Map<string, AcpClient>()
let sessionCounterSeed = 0

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

  ipcMain.handle(IPC.acpStart, (event, args: AcpStartArgs): AcpStartResult => {
    const sessionId = `s${++sessionCounterSeed}`
    const client = new AcpClient({ cwd: args.workspaceDir, env: getShellEnv() })

    const forward = (payload: unknown): void => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.acpEvent, { sessionId, payload })
      }
    }
    client.on('notification', forward)
    client.on('serverRequest', forward)
    client.on('stderr', (text: string) => forward({ type: 'stderr', text }))
    client.on('exit', (info) => forward({ type: 'exit', ...(info as object) }))
    client.on('error', (err: Error) => forward({ type: 'error', message: err.message }))

    client.start()
    sessions.set(sessionId, client)
    return { sessionId }
  })

  ipcMain.handle(IPC.acpStop, (_event, sessionId: string) => {
    const client = sessions.get(sessionId)
    client?.stop()
    sessions.delete(sessionId)
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
  for (const client of sessions.values()) client.stop()
  sessions.clear()
  if (process.platform !== 'darwin') app.quit()
})
