import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AcpEvent,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SignInArgs,
  type SignInResult,
  type StartThreadArgs,
  type StartThreadResult,
  type VibeDetectResult,
} from '../shared/ipc'

const api = {
  detectVibe: (): Promise<VibeDetectResult> => ipcRenderer.invoke(IPC.detectVibe),
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.openWorkspaceDialog),
  startThread: (args: StartThreadArgs): Promise<StartThreadResult> =>
    ipcRenderer.invoke(IPC.startThread, args),
  sendPrompt: (args: SendPromptArgs): Promise<SendPromptResult> =>
    ipcRenderer.invoke(IPC.sendPrompt, args),
  respondPermission: (args: RespondPermissionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.respondPermission, args),
  signIn: (args: SignInArgs): Promise<SignInResult> => ipcRenderer.invoke(IPC.signIn, args),
  stopAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(IPC.stopAgent, agentId),
  onAcpEvent: (listener: (event: AcpEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: AcpEvent): void => listener(payload)
    ipcRenderer.on(IPC.acpEvent, handler)
    return () => ipcRenderer.removeListener(IPC.acpEvent, handler)
  },
}

export type VibeMonitorApi = typeof api

contextBridge.exposeInMainWorld('api', api)
