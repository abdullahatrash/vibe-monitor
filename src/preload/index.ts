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
  type TerminalClearArgs,
  type TerminalCloseArgs,
  type TerminalEvent,
  type TerminalOpenArgs,
  type TerminalOpenResult,
  type TerminalResizeArgs,
  type TerminalRestartArgs,
  type TerminalWriteArgs,
  type GitStatusEvent,
  type GitStatusSubscriptionArgs,
  type ListMetadataResult,
  type ReadTranscriptResult,
  type ReadThreadAttachmentsResult,
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

/**
 * One streaming-subscription bridge: wrap `ipcRenderer.on(channel)` as an
 * add-listener that returns its own unsubscribe (the `on`+unsubscribe IPC shape).
 * Every `on*` below is this helper at a specific channel + payload type — identical
 * plumbing, so it lives once here.
 */
function subscribe<T>(channel: string): (listener: (event: T) => void) => () => void {
  return (listener) => {
    const handler = (_e: unknown, payload: T): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

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
  readThreadAttachments: (threadId: string): Promise<ReadThreadAttachmentsResult> =>
    ipcRenderer.invoke(IPC.readThreadAttachments, threadId),
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
  terminalOpen: (args: TerminalOpenArgs): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC.terminalOpen, args),
  terminalWrite: (args: TerminalWriteArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalWrite, args),
  terminalResize: (args: TerminalResizeArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalResize, args),
  terminalClose: (args: TerminalCloseArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalClose, args),
  terminalClear: (args: TerminalClearArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalClear, args),
  terminalRestart: (args: TerminalRestartArgs): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC.terminalRestart, args),
  onAcpEvent: subscribe<AcpEvent>(IPC.acpEvent),
  onTerminalEvent: subscribe<TerminalEvent>(IPC.terminalEvent),
  onThreadBound: subscribe<ThreadBoundEvent>(IPC.threadBound),
  onThreadStatus: subscribe<ThreadStatusEvent>(IPC.threadStatus),
  onThreadTitle: subscribe<ThreadTitleEvent>(IPC.threadTitle),
  onAgentEvicted: subscribe<AgentEvictedEvent>(IPC.agentEvicted),
  onGitStatus: subscribe<GitStatusEvent>(IPC.gitStatus),
}

export type VibeMistroApi = typeof api

contextBridge.exposeInMainWorld('api', api)
