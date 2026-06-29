import { writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Serve the agent's `fs/write_text_file` request (agent → client). Like reads,
 * Vibe delegates the actual write to us, so an approved write turn stalls until
 * we reply `{}` (docs/acp-capture.md §5, §7). The write only reaches us *after*
 * the user has approved the `session/request_permission` for the same tool call.
 *
 * Pure over an injected writer (Seam C): the WorkspaceAgent wires the real
 * `node:fs` writer; tests pass a fake or a temp dir.
 *
 * Confinement (TB3, carry-over from #4): now that the agent can write, we reject
 * paths that resolve outside the Workspace directory. Writes are destructive and
 * the user opened *this* Workspace, so honoring an arbitrary absolute path is the
 * wrong default. The check is **lexical** (path.relative on resolved paths) and
 * does NOT resolve symlinks, so a symlink *inside* the Workspace pointing out
 * would still pass. Reads stay unconfined for parity with the `vibe` CLI (see
 * fs-read.ts). The symlink gap and confining reads are tracked in follow-up #8.
 */

/** Writes text to a file. Injectable for testing. */
export type WriteTextFn = (path: string, content: string) => Promise<void>

const defaultWrite: WriteTextFn = (path, content) => writeFile(path, content, 'utf8')

/** A JSON-RPC-shaped outcome: either a result or an error, never both. */
export type FsWriteOutcome =
  | { result: Record<string, never> }
  | { error: { code: number; message: string } }

export interface FsWriteDeps {
  /** Override the writer (testing). */
  write?: WriteTextFn
  /** When set, reject writes that resolve outside this directory. */
  workspaceDir?: string
}

/**
 * Write `params.content` to `params.path` and reply `{}`. Returns an error
 * result (never throws) on a bad request, a path that escapes the Workspace, or
 * a filesystem failure so the agent's turn can fail cleanly rather than hang.
 */
export async function handleFsWriteTextFile(
  params: unknown,
  deps: FsWriteDeps = {},
): Promise<FsWriteOutcome> {
  const write = deps.write ?? defaultWrite
  const path = (params as { path?: unknown } | null)?.path
  const content = (params as { content?: unknown } | null)?.content

  if (typeof path !== 'string' || path.length === 0) {
    return { error: { code: -32602, message: 'fs/write_text_file: missing or invalid `path`' } }
  }
  if (typeof content !== 'string') {
    return { error: { code: -32602, message: 'fs/write_text_file: missing or invalid `content`' } }
  }
  if (deps.workspaceDir && !isPathWithin(deps.workspaceDir, path)) {
    return {
      error: {
        code: -32602,
        message: `fs/write_text_file: path escapes the Workspace directory: ${path}`,
      },
    }
  }

  try {
    await write(path, content)
    return { result: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: -32603, message } }
  }
}

/**
 * True when `target` resolves to `dir` or a descendant of it. Lexical only —
 * does not resolve symlinks, so a symlink inside `dir` pointing out still
 * passes (see #8).
 */
export function isPathWithin(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
