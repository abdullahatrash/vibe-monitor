import { createContext, useContext } from 'react'
import type { FileLink } from './file-link'

/**
 * Handler that opens the file behind a clickable file-path chip (#116). Provided at
 * the `Conversation` level (with the Thread's `agentId` closed over) and consumed by
 * the deeply-nested `FileChip` — which streamdown renders inside its `a` override, far
 * below the conversation — WITHOUT prop-drilling through `Response`/`Streamdown`.
 *
 * `null` (the default) means "no opener wired": the chip then renders as the original
 * non-navigating `<span>` (#114), so `FileChip`/`Response` stay usable outside a
 * Conversation. Main does the relative→absolute resolution + confinement + `shell.showItemInFolder` (reveal).
 */
export type OpenFileHandler = ((link: FileLink) => void) | null

const FileOpenContext = createContext<OpenFileHandler>(null)

export const FileOpenProvider = FileOpenContext.Provider

/** The current chip opener, or `null` when no Conversation provides one. */
export function useOpenFile(): OpenFileHandler {
  return useContext(FileOpenContext)
}
