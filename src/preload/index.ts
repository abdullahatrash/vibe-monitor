import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AcpEvent,
  type CreateDraftArgs,
  type CreateDraftResult,
  type ListMetadataResult,
  type ReadTranscriptResult,
  type RespondPermissionArgs,
  type OpenThreadArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadBoundEvent,
  type VibeDetectResult,
} from '../shared/ipc'

const api = {
  detectVibe: (): Promise<VibeDetectResult> => ipcRenderer.invoke(IPC.detectVibe),
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.openWorkspaceDialog),
  startThread: (args: StartThreadArgs): Promise<StartThreadResult> =>
    ipcRenderer.invoke(IPC.startThread, args),
  openThread: (args: OpenThreadArgs): Promise<StartThreadResult> =>
    ipcRenderer.invoke(IPC.openThread, args),
  sendPrompt: (args: SendPromptArgs): Promise<SendPromptResult> =>
    ipcRenderer.invoke(IPC.sendPrompt, args),
  respondPermission: (args: RespondPermissionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.respondPermission, args),
  signIn: (args: SignInArgs): Promise<SignInResult> => ipcRenderer.invoke(IPC.signIn, args),
  signOut: (args: SignOutArgs): Promise<SignOutResult> => ipcRenderer.invoke(IPC.signOut, args),
  stopAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(IPC.stopAgent, agentId),
  listMetadata: (): Promise<ListMetadataResult> => ipcRenderer.invoke(IPC.listMetadata),
  createDraft: (args: CreateDraftArgs): Promise<CreateDraftResult> =>
    ipcRenderer.invoke(IPC.createDraft, args),
  readTranscript: (threadId: string): Promise<ReadTranscriptResult> =>
    ipcRenderer.invoke(IPC.readTranscript, threadId),
  onAcpEvent: (listener: (event: AcpEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: AcpEvent): void => listener(payload)
    ipcRenderer.on(IPC.acpEvent, handler)
    return () => ipcRenderer.removeListener(IPC.acpEvent, handler)
  },
  onThreadBound: (listener: (event: ThreadBoundEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ThreadBoundEvent): void => listener(payload)
    ipcRenderer.on(IPC.threadBound, handler)
    return () => ipcRenderer.removeListener(IPC.threadBound, handler)
  },
}

export type VibeMistroApi = typeof api

contextBridge.exposeInMainWorld('api', api)
