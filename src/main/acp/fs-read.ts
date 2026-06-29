import { readFile } from 'node:fs/promises'

/**
 * Serve the agent's `fs/read_text_file` request (agent → client). Vibe delegates
 * file I/O to us, so a read-only prompt stalls until we reply. We read the file
 * and answer `{content}`; on failure we return a JSON-RPC error result so the
 * agent's turn can fail cleanly rather than hang (docs/acp-capture.md §5).
 *
 * Pure over an injected reader (Seam C): the WorkspaceAgent wires the real
 * `node:fs` reader; tests pass a fake or a temp file.
 */

/** Reads a file's text content. Injectable for testing. */
export type ReadTextFn = (path: string) => Promise<string>

const defaultRead: ReadTextFn = (path) => readFile(path, 'utf8')

/** A JSON-RPC-shaped outcome: either a result or an error, never both. */
export type FsReadOutcome =
  | { result: { content: string } }
  | { error: { code: number; message: string } }

/**
 * Read `params.path` and produce `{content}`. If `params.limit` is a positive
 * number it caps the reply to that many lines (the agent passes a line budget,
 * e.g. `2001` in the capture).
 */
export async function handleFsReadTextFile(
  params: unknown,
  read: ReadTextFn = defaultRead,
): Promise<FsReadOutcome> {
  const path = (params as { path?: unknown } | null)?.path
  if (typeof path !== 'string' || path.length === 0) {
    return { error: { code: -32602, message: 'fs/read_text_file: missing or invalid `path`' } }
  }

  try {
    const content = await read(path)
    const limit = (params as { limit?: unknown }).limit
    return { result: { content: applyLineLimit(content, limit) } }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: -32603, message } }
  }
}

function applyLineLimit(content: string, limit: unknown): string {
  if (typeof limit !== 'number' || limit <= 0) return content
  const lines = content.split('\n')
  if (lines.length <= limit) return content
  return lines.slice(0, limit).join('\n')
}
