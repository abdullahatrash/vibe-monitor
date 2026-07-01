import { isAbsolute, join, resolve } from 'node:path'

/**
 * Resolve a (possibly relative) file path from an agent's markdown into an absolute
 * CANDIDATE path (#116, clickable file links). The renderer has no fs, so this runs in
 * MAIN against the agent's Workspace cwd. Pure — the OS-touching realpath/confinement +
 * `shell.showItemInFolder` (reveal) stay in the handler; homeDir is injected so this
 * stays testable. This only RESOLVES; the handler CONFINES the result to the Workspace
 * (an absolute or `~` path may resolve outside — the handler rejects that).
 *
 * Rules: an absolute path passes through; a `~` / `~/…` path expands against `homeDir`;
 * anything else resolves against `workspaceDir` (the agent's cwd). Any `:line:col`
 * position has already been stripped by `parseFileLink` before the path reaches us —
 * reveal can't deep-link a line anyway, so clicking just reveals the file.
 */
export function resolveWorkspacePath(
  workspaceDir: string,
  inputPath: string,
  homeDir: string,
): string {
  const trimmed = inputPath.trim()
  if (trimmed === '~') return homeDir
  if (trimmed.startsWith('~/')) return join(homeDir, trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  return resolve(workspaceDir, trimmed)
}
