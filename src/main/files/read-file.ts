import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { FilesReadResult } from '../../shared/ipc'
import { resolveWorkspacePath } from '../resolve-workspace-path'
import { isWithinDir } from '../open-target'

/**
 * The Workspace file reader for the read-only preview (#189, ADR-0013 decisions 2-3). Given a
 * Workspace root and a tree-relative path, it confines the target, enforces a size cap, sniffs
 * for binary content, and returns a discriminated {@link FilesReadResult} the preview renders
 * without ever showing garbage. STRICTLY read-only — there is no write path anywhere in here.
 *
 * CONFINEMENT (the security core; the SAME posture + machinery as the `revealPath` handler, so
 * the two are easy to compare):
 *   1. `realpath` the Workspace root once.
 *   2. Resolve the (relative) target against the root via `resolveWorkspacePath` — an absolute or
 *      `~` input resolves too, but step 4 rejects it if it lands outside.
 *   3. `stat` it; a non-regular-file (directory, socket, missing) → `error`.
 *   4. `realpath` the target (collapsing any symlink) and require `isWithinDir(realRoot, realTarget)`;
 *      a `..`/absolute escape or a symlink pointing OUT of the tree → `error` (logged). We only ever
 *      `readFile` the realpath'd, in-tree target, so an out-of-tree file's bytes are never read.
 *
 * CLASSIFY: the size cap is checked from `stat.size` BEFORE reading (a huge file never loads) →
 * `tooLarge`. Otherwise the bytes are read once as a Buffer; a NUL byte within the first
 * {@link BINARY_SNIFF_BYTES} → `binary` (the standard "looks binary" heuristic); else utf8 → `text`.
 *
 * Best-effort: EVERY throw (bad root, stat/realpath/read failure) is caught and degrades to
 * `error`; the function never rejects and never leaks an absolute path or stack to the caller.
 * Pure over an injectable fs boundary (default: `node:fs/promises`); the colocated tests exercise
 * the DEFAULT boundary against real tmpdir fixtures (symlink escapes, caps, binary, text).
 */

/** ~1MB read cap. A file larger than this is reported `tooLarge` (checked via `stat`, not read). */
export const FILES_READ_MAX_BYTES = 1_000_000

/** Bytes scanned for a NUL when deciding binary-vs-text (git uses the same first-8000-bytes rule). */
export const BINARY_SNIFF_BYTES = 8_000

/** Injectable fs boundary (Seam). The default wires `node:fs/promises`. */
export interface ReadFileFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  readFile(path: string): Promise<Buffer>
}

const nodeFs: ReadFileFs = {
  realpath: (p) => realpath(p),
  stat: (p) => stat(p),
  readFile: (p) => readFile(p),
}

export interface ReadFileOptions {
  fs?: ReadFileFs
  maxBytes?: number
  /** Injected for `resolveWorkspacePath`'s `~` expansion; defaults to the real home dir. */
  homeDir?: string
}

/** True when any of the first {@link BINARY_SNIFF_BYTES} bytes of `buf` is a NUL. */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export async function readWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  opts: ReadFileOptions = {},
): Promise<FilesReadResult> {
  const fs = opts.fs ?? nodeFs
  const maxBytes = opts.maxBytes ?? FILES_READ_MAX_BYTES
  const homeDir = opts.homeDir ?? homedir()

  try {
    const realRoot = await fs.realpath(workspaceDir)
    const requested = resolveWorkspacePath(workspaceDir, relativePath, homeDir)
    const stats = await fs.stat(requested)
    if (!stats.isFile()) return { kind: 'error' } // a dir / socket / missing target — refuse

    const realTarget = await fs.realpath(requested)
    if (!isWithinDir(realRoot, realTarget)) {
      // An out-of-tree target (a `..`/absolute path, or a symlink escaping the root). Log the
      // realpath for main's console only — the renderer gets a bare `error`, never the path.
      console.error(`[vibe-mistro:files-read] refused (outside Workspace): ${realTarget}`)
      return { kind: 'error' }
    }

    if (stats.size > maxBytes) return { kind: 'tooLarge' } // never read a file over the cap

    const buf = await fs.readFile(realTarget) // realpath'd + confirmed in-tree — safe to read
    if (looksBinary(buf)) return { kind: 'binary' }
    return { kind: 'text', content: buf.toString('utf8') }
  } catch (err) {
    // Bad root / stat / realpath / read failure — best-effort, never rejects, never leaks a stack.
    console.error(`[vibe-mistro:files-read] ${relativePath}: ${String(err)}`)
    return { kind: 'error' }
  }
}
