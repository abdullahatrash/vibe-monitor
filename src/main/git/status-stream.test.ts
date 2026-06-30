import { describe, it, expect, vi } from 'vitest'
import { GitStatusManager, type Clock, type WatchFactory } from './status-stream'
import type { GitStatus, GitStatusEvent } from '../../shared/ipc'

/**
 * The manager's lifecycle is the load-bearing seam: ref-count start/stop, the single
 * watcher + fetch per dir, debounce, fetch TTL, and teardown. Driven entirely by
 * injected fakes (clock / watch / read / fetch / emit) — no real git, fs, or timers.
 */

const sampleStatus: GitStatus = {
  isRepo: true,
  branch: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [],
}

/** Let any pending microtasks + a few macrotasks settle (real timers; the manager's are faked). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
}

function makeClock(): {
  clock: Clock
  timeouts: Map<number, () => void>
  intervals: Map<number, () => void>
  fireTimeouts: () => void
  fireIntervals: () => void
} {
  let nextId = 1
  const timeouts = new Map<number, () => void>()
  const intervals = new Map<number, () => void>()
  const clock: Clock = {
    setTimeout: (fn) => {
      const id = nextId++
      timeouts.set(id, fn)
      return id
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    setInterval: (fn) => {
      const id = nextId++
      intervals.set(id, fn)
      return id
    },
    clearInterval: (h) => void intervals.delete(h as number),
  }
  return {
    clock,
    timeouts,
    intervals,
    fireTimeouts: () => [...timeouts.values()].forEach((fn) => fn()),
    fireIntervals: () => [...intervals.values()].forEach((fn) => fn()),
  }
}

function makeWatch(): {
  factory: WatchFactory
  watchers: { dir: string; onChange: () => void; closed: boolean }[]
} {
  const watchers: { dir: string; onChange: () => void; closed: boolean }[] = []
  const factory: WatchFactory = (dir, onChange) => {
    const w = { dir, onChange, closed: false }
    watchers.push(w)
    return { close: () => void (w.closed = true) }
  }
  return { factory, watchers }
}

function setup() {
  const clock = makeClock()
  const watch = makeWatch()
  const emitted: GitStatusEvent[] = []
  const read = vi.fn().mockResolvedValue(sampleStatus)
  const fetch = vi.fn().mockResolvedValue(undefined)
  const manager = new GitStatusManager({
    read,
    fetch,
    watch: watch.factory,
    clock: clock.clock,
    emit: (event) => emitted.push(event),
  })
  return { manager, clock, watch, emitted, read, fetch }
}

describe('GitStatusManager', () => {
  it('emits a snapshot on subscribe', async () => {
    const { manager, emitted } = setup()
    manager.subscribe('/a')
    await flush()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ workspaceDir: '/a', kind: 'snapshot', status: sampleStatus })
  })

  it('ref-counts: a 2nd subscribe does not start a 2nd watcher', async () => {
    const { manager, watch, clock } = setup()
    manager.subscribe('/a')
    manager.subscribe('/a')
    await flush()
    expect(watch.watchers).toHaveLength(1)
    expect(clock.intervals.size).toBe(1)
  })

  it('tears down only on the LAST unsubscribe', async () => {
    const { manager, watch, clock } = setup()
    manager.subscribe('/a')
    manager.subscribe('/a')
    manager.unsubscribe('/a')
    expect(watch.watchers[0].closed).toBe(false)
    expect(clock.intervals.size).toBe(1)
    manager.unsubscribe('/a')
    expect(watch.watchers[0].closed).toBe(true)
    expect(clock.intervals.size).toBe(0)
    expect(manager.isSubscribed('/a')).toBe(false)
  })

  it('debounces an fs-watcher burst into one localUpdated re-read', async () => {
    const { manager, watch, clock, emitted } = setup()
    manager.subscribe('/a')
    await flush()
    emitted.length = 0
    watch.watchers[0].onChange()
    watch.watchers[0].onChange() // burst: the first timer is cleared, one remains
    expect(clock.timeouts.size).toBe(1)
    clock.fireTimeouts()
    await flush()
    expect(emitted.filter((e) => e.kind === 'localUpdated')).toHaveLength(1)
  })

  it('fetches then emits remoteUpdated on a fetch tick', async () => {
    const { manager, clock, emitted, fetch } = setup()
    manager.subscribe('/a')
    await flush()
    emitted.length = 0
    fetch.mockClear()
    clock.fireIntervals()
    await flush()
    expect(fetch).toHaveBeenCalledWith('/a')
    expect(emitted.filter((e) => e.kind === 'remoteUpdated')).toHaveLength(1)
  })

  it('refresh re-reads (localUpdated) when subscribed, no-ops otherwise', async () => {
    const { manager, emitted } = setup()
    manager.refresh('/x') // not subscribed
    await flush()
    expect(emitted).toHaveLength(0)
    manager.subscribe('/a')
    await flush()
    emitted.length = 0
    manager.refresh('/a')
    await flush()
    expect(emitted.filter((e) => e.kind === 'localUpdated')).toHaveLength(1)
  })

  it('disposeAll tears down every subscription', () => {
    const { manager, watch, clock } = setup()
    manager.subscribe('/a')
    manager.subscribe('/b')
    expect(watch.watchers).toHaveLength(2)
    manager.disposeAll()
    expect(watch.watchers.every((w) => w.closed)).toBe(true)
    expect(clock.intervals.size).toBe(0)
    expect(manager.isSubscribed('/a')).toBe(false)
    expect(manager.isSubscribed('/b')).toBe(false)
  })
})
