import { watch as chokidarWatch } from 'chokidar'
import type { Clock, WatchFactory } from './status-stream'

/**
 * Production wiring for the git status manager (#84) — the real clock + the chokidar
 * fs watcher. Kept out of `status-stream.ts` so that module stays dep-free and fully
 * unit-testable (fakes for both), mirroring how the ACP transport injects its spawn.
 */

/** The real timers as a `Clock` (handles are opaque to the manager). */
export const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * Churn dirs the working-tree watcher must IGNORE (#84): `.git/` (so our own status
 * reads + the agent's commits don't self-trigger — the turn-end refresh covers those
 * deliberately), plus heavy build/dep dirs whose writes aren't user changes. Matched
 * anywhere in the path (segment-bounded) on both `/` and `\` separators.
 */
const IGNORED = /(^|[/\\])(\.git|node_modules|out|dist)([/\\]|$)/

/**
 * chokidar-backed `WatchFactory`. Node's recursive `fs.watch` isn't portable, so we
 * use chokidar with `ignoreInitial` (no snapshot burst — `subscribe` emits that) and
 * the ignore matcher above. Any add/change/unlink calls `onChange`; the manager
 * debounces the burst into one re-read.
 */
export const chokidarWatchFactory: WatchFactory = (workspaceDir, onChange) => {
  const watcher = chokidarWatch(workspaceDir, {
    ignoreInitial: true,
    ignored: (path: string) => IGNORED.test(path),
  })
  watcher.on('all', () => onChange())
  // Swallow watcher errors (a removed dir, an EMFILE) — they must never crash main.
  watcher.on('error', () => {})
  return { close: () => watcher.close() }
}
