import { constants as fsConstants } from 'node:fs'
import { open, realpath, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

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
  // write time, then write THROUGH file descriptors opened with O_NOFOLLOW
  // (`secureWriteWithinRoot`) rather than by path. This closes two escapes the
  // earlier resolve-then-writeFile-by-path left open:
  //   • a PRE-EXISTING dangling symlink as the final component — realpath throws
  //     on it so `resolveLikeKernel` leaves it literal (looks in-Workspace), and
  //     a path-based writeFile would FOLLOW it outside. O_NOFOLLOW on the final
  //     open refuses it. FULLY closed (open and write are the same fd — no
  //     re-resolution between them).
  //   • a planted INTERMEDIATE symlink swapped in for a validated real dir — each
  //     intermediate is re-opened with O_NOFOLLOW|O_DIRECTORY, so a symlink there
  //     fails with ELOOP. Closed for already-planted symlinks.
  // ONE irreducible residual remains: a sub-microsecond swap of an intermediate
  // directory for a symlink BETWEEN our O_NOFOLLOW open of that component and the
  // open of the next one down. Truly closing it needs native openat() relative to
  // the parent fd (no portable Node API); it is accepted under ADR-0004's desktop
  // trust model ("you launched this agent against your account").
  let writeTarget = path
  let secureRoot: string | undefined
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
    writeTarget = confined.realTarget
    secureRoot = confined.realRoot
  }

  try {
    // Secure (through-fd) writer only when confined AND no test writer is
    // injected; injected writers (test fakes) keep the path-based seam, and an
    // unconfined write (no workspaceDir) uses the plain default writer.
    if (secureRoot !== undefined && deps.write === undefined) {
      await secureWriteWithinRoot(secureRoot, writeTarget, content)
    } else {
      await write(writeTarget, content)
    }
    return { result: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: -32603, message } }
  }
}

/**
 * The realpath'd Workspace root plus the canonical real path of `target` IF the
 * latter stays inside the former, else `null` — symlink-resolved confinement
 * (ADR-0004). Both sides are realpath-resolved before the lexical containment
 * check, so a symlink inside the Workspace pointing out cannot escape and a
 * symlinked Workspace root isn't falsely rejected. `realRoot` is handed to the
 * secure writer so it knows where the through-fd walk must start.
 */
async function confinedWriteTarget(
  workspaceDir: string,
  target: string,
): Promise<{ realRoot: string; realTarget: string } | null> {
  const realRoot = await realpath(workspaceDir).catch(() => resolve(workspaceDir))
  const realTarget = await resolveLikeKernel(target)
  return isPathWithin(realRoot, realTarget) ? { realRoot, realTarget } : null
}

/** Boolean form of {@link confinedWriteTarget}. */
export async function isWriteWithinWorkspace(workspaceDir: string, target: string): Promise<boolean> {
  return (await confinedWriteTarget(workspaceDir, target)) !== null
}

/** Inject `open` for testing {@link secureWriteWithinRoot} directly. */
export interface SecureWriteDeps {
  open?: typeof open
}

/**
 * Write `content` to `target` — which MUST resolve within `realRoot` (the
 * realpath'd Workspace root) — following NO symlinks on the way down, by opening
 * file descriptors with `O_NOFOLLOW` and writing THROUGH the final fd.
 *
 * Walk `target`'s components relative to `realRoot`: each INTERMEDIATE component
 * is opened `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, so a component that is (or was
 * swapped to) a symlink fails with `ELOOP`; the FINAL component is opened
 * `O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW` and written through that handle, so
 * a symlink there (dangling or live) is refused and there is no path
 * re-resolution between open and write. All handles close in `finally`.
 *
 * Portability: `O_NOFOLLOW` is POSIX. Where it is undefined (e.g. Windows) we
 * fall back to a path-based `writeFile` — confinement was already validated and
 * the primary target is macOS/darwin where `O_NOFOLLOW` is defined.
 */
export async function secureWriteWithinRoot(
  realRoot: string,
  target: string,
  content: string,
  deps: SecureWriteDeps = {},
): Promise<void> {
  const openFn = deps.open ?? open
  const C = fsConstants

  if (C.O_NOFOLLOW === undefined) {
    await writeFile(target, content, 'utf8')
    return
  }

  const rel = relative(realRoot, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`secureWriteWithinRoot: target escapes the root: ${target}`)
  }
  const parts = rel.split(sep).filter((p) => p.length > 0)

  const handles: FileHandle[] = []
  try {
    let acc = realRoot
    for (let i = 0; i < parts.length - 1; i++) {
      acc = join(acc, parts[i])
      handles.push(await openFn(acc, C.O_RDONLY | (C.O_DIRECTORY ?? 0) | C.O_NOFOLLOW))
    }
    acc = join(acc, parts[parts.length - 1])
    const fileHandle = await openFn(acc, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | C.O_NOFOLLOW, 0o666)
    handles.push(fileHandle)
    await fileHandle.writeFile(content, 'utf8')
  } finally {
    await Promise.allSettled(handles.map((h) => h.close()))
  }
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
