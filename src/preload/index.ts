import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AcpEvent,
  type AgentEvictedEvent,
  type CancelTurnArgs,
  type DeleteThreadResult,
  type GitBranchesArgs,
  type GitBranchesResult,
  type GitBranchOpArgs,
  type GitCommitArgs,
  type GitCommitResult,
  type GitDiffArgs,
  type GitDiffResult,
  type GitOpResult,
  type GhCreatePrArgs,
  type GhCreateResult,
  type GhCurrentPrArgs,
  type GhPrResult,
  type RevealPathArgs,
  type FilesListArgs,
  type FilesListResult,
  type FilesReadArgs,
  type FilesReadResult,
  type GitStatusEvent,
  type GitStatusSubscriptionArgs,
  type ListMetadataResult,
  type ReadTranscriptResult,
  type RemoveWorkspaceResult,
  type RespondPermissionArgs,
  type OpenThreadArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type CheckAuthStatusArgs,
  type CheckAuthStatusResult,
  type SetThreadConfigArgs,
  type SetThreadConfigResult,
  type SetThreadFlagsArgs,
  type SetThreadFlagsResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type SetThreadTitleArgs,
  type SetThreadTitleResult,
  type ThreadBoundEvent,
  type ThreadStatusEvent,
  type ThreadTitleEvent,
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
  cancelTurn: (args: CancelTurnArgs): Promise<void> => ipcRenderer.invoke(IPC.cancelTurn, args),
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
  removeWorkspace: (workspaceId: string): Promise<RemoveWorkspaceResult> =>
    ipcRenderer.invoke(IPC.removeWorkspace, workspaceId),
  getThreadStatuses: (): Promise<ThreadStatusEvent[]> => ipcRenderer.invoke(IPC.getThreadStatuses),
  setThreadConfig: (args: SetThreadConfigArgs): Promise<SetThreadConfigResult> =>
    ipcRenderer.invoke(IPC.setThreadConfig, args),
  setThreadFlags: (args: SetThreadFlagsArgs): Promise<SetThreadFlagsResult> =>
    ipcRenderer.invoke(IPC.setThreadFlags, args),
  setThreadTitle: (args: SetThreadTitleArgs): Promise<SetThreadTitleResult> =>
    ipcRenderer.invoke(IPC.setThreadTitle, args),
  readTranscript: (threadId: string): Promise<ReadTranscriptResult> =>
    ipcRenderer.invoke(IPC.readTranscript, threadId),
  gitSubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitSubscribeStatus, args),
  gitUnsubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitUnsubscribeStatus, args),
  gitDiff: (args: GitDiffArgs): Promise<GitDiffResult> => ipcRenderer.invoke(IPC.gitDiff, args),
  gitCommit: (args: GitCommitArgs): Promise<GitCommitResult> => ipcRenderer.invoke(IPC.gitCommit, args),
  gitBranches: (args: GitBranchesArgs): Promise<GitBranchesResult> =>
    ipcRenderer.invoke(IPC.gitBranches, args),
  gitCheckout: (args: GitBranchOpArgs): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.gitCheckout, args),
  gitCreateBranch: (args: GitBranchOpArgs): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.gitCreateBranch, args),
  ghCurrentPr: (args: GhCurrentPrArgs): Promise<GhPrResult> =>
    ipcRenderer.invoke(IPC.ghCurrentPr, args),
  ghCreatePr: (args: GhCreatePrArgs): Promise<GhCreateResult> =>
    ipcRenderer.invoke(IPC.ghCreatePr, args),
  revealPath: (args: RevealPathArgs): Promise<void> => ipcRenderer.invoke(IPC.revealPath, args),
  filesList: (args: FilesListArgs): Promise<FilesListResult> => ipcRenderer.invoke(IPC.filesList, args),
  filesRead: (args: FilesReadArgs): Promise<FilesReadResult> => ipcRenderer.invoke(IPC.filesRead, args),
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
  onThreadTitle: (listener: (event: ThreadTitleEvent) => void): (() => void) => {
    const handler = (_e: unknown, payload: ThreadTitleEvent): void => listener(payload)
    ipcRenderer.on(IPC.threadTitle, handler)
    return () => ipcRenderer.removeListener(IPC.threadTitle, handler)
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
