import { sep } from 'node:path'

/**
 * Security helper for the `shell:reveal-path` handler (#116). A file-link chip is
 * agent-authored (UNTRUSTED), so its click is an UNPERMISSIONED path into the OS file
 * manager. We never OPEN/execute the target (the handler uses `shell.showItemInFolder`,
 * which only REVEALS it in Finder — no Launch Services, no code execution). We still
 * CONFINE the revealed target to the Workspace so a click can't disclose the location
 * of an out-of-tree file (`/etc/…`, `~/.ssh/…`, a `..` escape). Pure so it's unit-tested
 * here; the caller collapses symlinks (`realpath`) before calling this.
 */

/**
 * True when `target` sits inside `dir`, or IS `dir`. Both must already be
 * realpath-resolved absolute paths (the caller collapses symlinks first) so this is a
 * plain lexical containment test — no `..` or symlink can slip past it. The trailing
 * separator on `dir` stops the classic sibling-prefix escape (`/a/proj` vs `/a/proj-evil`).
 */
export function isWithinDir(dir: string, target: string): boolean {
  if (dir.length === 0) return false
  if (target === dir) return true
  const base = dir.endsWith(sep) ? dir : dir + sep
  return target.startsWith(base)
}
