import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AcpEvent,
  type AcpStartArgs,
  type AcpStartResult,
  type VibeDetectResult,
} from '../shared/ipc'

const api = {
  detectVibe: (): Promise<VibeDetectResult> => ipcRenderer.invoke(IPC.detectVibe),
  acpStart: (args: AcpStartArgs): Promise<AcpStartResult> => ipcRenderer.invoke(IPC.acpStart, args),
  acpStop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.acpStop, sessionId),
  onAcpEvent: (listener: (event: AcpEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: AcpEvent): void => listener(payload)
    ipcRenderer.on(IPC.acpEvent, handler)
    return () => ipcRenderer.removeListener(IPC.acpEvent, handler)
  },
}

export type VibeMonitorApi = typeof api

contextBridge.exposeInMainWorld('api', api)
