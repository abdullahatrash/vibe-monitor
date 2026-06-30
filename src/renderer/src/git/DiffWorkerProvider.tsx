import { useMemo, type JSX, type ReactNode } from 'react'
import { WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'

/**
 * Mounts `@pierre/diffs`' web-worker pool around the diff viewer (#85, ADR-0008). The
 * lib offloads syntax-highlighting + diff layout to workers; `WorkerPoolContextProvider`
 * owns a process-wide singleton pool (created on first mount, torn down when the last
 * provider unmounts), so this is mounted ONCE around the diff area — not per file.
 *
 * The worker is a Vite `?worker` import (`@pierre/diffs/worker/worker.js?worker`), which
 * electron-vite's renderer bundles to a worker-constructor; we hand the pool a factory
 * that news one up. Pool size is derived from `hardwareConcurrency`, clamped to 2-6 so a
 * many-core machine doesn't spawn a wasteful fleet and a single-core one still gets two.
 *
 * Brand is light-mode (CONTEXT.md), so we pin @pierre's `pierre-light` highlighter theme
 * and skip t3code's theme-sync effect entirely — there is no dark mode to follow.
 */

/** @pierre's bundled light theme — matches the brand's light-mode surfaces. */
const DIFF_THEME = 'pierre-light'

export function DiffWorkerProvider({ children }: { children?: ReactNode }): JSX.Element {
  // Clamp pool size to 2-6 from half the core count (mirrors t3code's heuristic): a
  // diff render is bursty, so a couple of workers suffice and a big box gains little.
  const poolSize = useMemo(() => {
    const cores = typeof navigator === 'undefined' ? 4 : Math.max(1, navigator.hardwareConcurrency || 4)
    return Math.max(2, Math.min(6, Math.floor(cores / 2)))
  }, [])

  return (
    <WorkerPoolContextProvider
      poolOptions={{ workerFactory: () => new DiffsWorker(), poolSize }}
      highlighterOptions={{ theme: DIFF_THEME }}
    >
      {children}
    </WorkerPoolContextProvider>
  )
}
