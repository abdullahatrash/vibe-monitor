import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AcpEvent,
  type AgentEvictedEvent,
  type DeleteThreadResult,
  type GitDiffArgs,
  type GitDiffResult,
  type GitStatusEvent,
  type GitStatusSubscriptionArgs,
  type ListMetadataResult,
  type ReadTranscriptResult,
  type RespondPermissionArgs,
  type OpenThreadArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type CheckAuthStatusArgs,
  type CheckAuthStatusResult,
  type SetThreadConfigArgs,
  type SetThreadConfigResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadBoundEvent,
  type ThreadStatusEvent,
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
  checkAuthStatus: (args: CheckAuthStatusArgs): Promise<CheckAuthStatusResult> =>
    ipcRenderer.invoke(IPC.checkAuthStatus, args),
  stopAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(IPC.stopAgent, agentId),
  setActiveAgent: (agentId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.setActiveAgent, agentId),
  listMetadata: (): Promise<ListMetadataResult> => ipcRenderer.invoke(IPC.listMetadata),
  deleteThread: (threadId: string): Promise<DeleteThreadResult> =>
    ipcRenderer.invoke(IPC.deleteThread, threadId),
  getThreadStatuses: (): Promise<ThreadStatusEvent[]> => ipcRenderer.invoke(IPC.getThreadStatuses),
  setThreadConfig: (args: SetThreadConfigArgs): Promise<SetThreadConfigResult> =>
    ipcRenderer.invoke(IPC.setThreadConfig, args),
  readTranscript: (threadId: string): Promise<ReadTranscriptResult> =>
    ipcRenderer.invoke(IPC.readTranscript, threadId),
  gitSubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitSubscribeStatus, args),
  gitUnsubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitUnsubscribeStatus, args),
  gitDiff: (args: GitDiffArgs): Promise<GitDiffResult> => ipcRenderer.invoke(IPC.gitDiff, args),
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
  onThreadStatus: (listener: (event: ThreadStatusEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ThreadStatusEvent): void => listener(payload)
    ipcRenderer.on(IPC.threadStatus, handler)
    return () => ipcRenderer.removeListener(IPC.threadStatus, handler)
  },
  onAgentEvicted: (listener: (event: AgentEvictedEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: AgentEvictedEvent): void => listener(payload)
    ipcRenderer.on(IPC.agentEvicted, handler)
    return () => ipcRenderer.removeListener(IPC.agentEvicted, handler)
  },
  onGitStatus: (listener: (event: GitStatusEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: GitStatusEvent): void => listener(payload)
    ipcRenderer.on(IPC.gitStatus, handler)
    return () => ipcRenderer.removeListener(IPC.gitStatus, handler)
  },
}

export type VibeMistroApi = typeof api

contextBridge.exposeInMainWorld('api', api)
