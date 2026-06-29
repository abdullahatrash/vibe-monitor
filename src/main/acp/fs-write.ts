import { realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

/**
 * Serve the agent's `fs/write_text_file` request (agent → client). Like reads,
 * Vibe delegates the actual write to us, so an approved write turn stalls until
 * we reply `{}` (docs/acp-capture.md §5, §7). The write only reaches us *after*
 * the user has approved the `session/request_permission` for the same tool call.
 *
 * Pure over an injected writer (Seam C): the WorkspaceAgent wires the real
 * `node:fs` writer; tests pass a fake or a temp dir.
 *
 * Confinement (ADR-0004): writes are confined to the Workspace — the user opened
 * *this* Workspace and approved a write they believe lands in it, so honoring an
 * arbitrary path is the wrong default. The check is **symlink-resolved**: it
 * compares the real path of the nearest existing ancestor of the target (the
 * file itself may not exist yet) against the real path of the Workspace root, so
 * a symlink *inside* the Workspace pointing out cannot escape, and a symlinked
 * Workspace root isn't falsely rejected. Reads stay UNCONFINED for parity with
 * the `vibe` CLI — see fs-read.ts and ADR-0004.
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
  // Confine to the Workspace. We resolve the target the way the KERNEL will at
  // write time and write back that same canonical path, so the path we validated
  // is the path we write (a residual realpath→write TOCTOU race remains — fully
  // closing it needs openat/O_NOFOLLOW, out of scope here).
  let writeTarget = path
  if (deps.workspaceDir) {
    const confined = await confinedWriteTarget(deps.workspaceDir, path)
    if (!confined) {
      return {
        error: {
          code: -32602,
          message: `fs/write_text_file: path escapes the Workspace directory: ${path}`,
        },
      }
    }
    writeTarget = confined
  }

  try {
    await write(writeTarget, content)
    return { result: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: -32603, message } }
  }
}

/**
 * The canonical real path of `target` IF it stays inside `workspaceDir`, else
 * `null` — symlink-resolved confinement (ADR-0004). Both sides are realpath-
 * resolved before the lexical containment check, so a symlink inside the
 * Workspace pointing out cannot escape and a symlinked Workspace root isn't
 * falsely rejected.
 */
async function confinedWriteTarget(workspaceDir: string, target: string): Promise<string | null> {
  const realRoot = await realpath(workspaceDir).catch(() => resolve(workspaceDir))
  const realTarget = await resolveLikeKernel(target)
  return isPathWithin(realRoot, realTarget) ? realTarget : null
}

/** Boolean form of {@link confinedWriteTarget}. */
export async function isWriteWithinWorkspace(workspaceDir: string, target: string): Promise<boolean> {
  return (await confinedWriteTarget(workspaceDir, target)) !== null
}

/**
 * Resolve `target` the way the OS does at write time: walk its RAW components,
 * resolving a symlink the moment it's traversed and applying `..` to the already
 * symlink-resolved accumulator. This matters because `path.resolve` would
 * collapse a `link/..` LEXICALLY (dropping `link` before realpath sees it),
 * whereas the kernel follows `link` first and THEN applies `..` — so a `..`
 * after an in-Workspace symlink could otherwise escape. Non-existent components
 * (the not-yet-created tail) stay literal; later `..` still pops, names append.
 */
async function resolveLikeKernel(target: string): Promise<string> {
  const parts = target.split(/[/\\]+/).filter((p) => p.length > 0)
  let acc = isAbsolute(target) ? parse(target).root : resolve('.')
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      acc = dirname(acc)
      continue
    }
    acc = join(acc, part)
    try {
      acc = await realpath(acc) // resolves a symlink component as the kernel would
    } catch {
      // Doesn't exist yet — leave it literal; deeper `..`/names still apply.
    }
  }
  return acc
}

/**
 * True when `target` resolves to `dir` or a descendant of it — a pure lexical
 * comparison. Callers pass realpath-resolved paths (see `isWriteWithinWorkspace`)
 * so symlinks are already resolved; on raw paths this rejects `..`/absolute
 * escapes only.
 */
export function isPathWithin(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
