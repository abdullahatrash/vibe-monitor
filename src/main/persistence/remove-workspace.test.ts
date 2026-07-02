import { describe, it, expect, vi } from 'vitest'
import { removeWorkspace } from './remove-workspace'

/**
 * The "Remove project" orchestration (ADR-0005): stop the Workspace's live warm
 * agent (if any), then remove OUR records — the Workspace + Thread metadata and each
 * Thread's JSONL transcript. Per ADR-0005 a stop failure (or no warm agent) and a
 * store/transcript failure must NEVER block the removal or surface as a hard error.
 * Exercised with injected fakes for the store / transcript / stop seams — no real
 * `vibe-acp`, no `userData`, no files on disk touched.
 */

type RemoveWs = (id: string) => Promise<string[]>
type DeleteFn = (threadId: string) => Promise<void>

function fakes(threadIds: string[]): {
  store: { removeWorkspace: ReturnType<typeof vi.fn<RemoveWs>> }
  transcript: { delete: ReturnType<typeof vi.fn<DeleteFn>> }
} {
  return {
    store: { removeWorkspace: vi.fn<RemoveWs>(async () => threadIds) },
    transcript: { delete: vi.fn<DeleteFn>(async () => {}) },
  }
}

describe('removeWorkspace ("Remove project")', () => {
  it('removes the Workspace records and deletes every returned Thread transcript', async () => {
    const { store, transcript } = fakes(['t1', 't2'])

    await removeWorkspace({ workspaceId: 'w1', store, transcript })

    expect(store.removeWorkspace).toHaveBeenCalledWith('w1')
    expect(transcript.delete).toHaveBeenCalledWith('t1')
    expect(transcript.delete).toHaveBeenCalledWith('t2')
    expect(transcript.delete).toHaveBeenCalledTimes(2)
  })

  it('drops each removed Thread\'s attachments when the seam is provided', async () => {
    const { store, transcript } = fakes(['t1', 't2'])
    const attachments = { delete: vi.fn<DeleteFn>(async () => {}) }

    await removeWorkspace({ workspaceId: 'w1', store, transcript, attachments })

    expect(attachments.delete).toHaveBeenCalledWith('t1')
    expect(attachments.delete).toHaveBeenCalledWith('t2')
    expect(attachments.delete).toHaveBeenCalledTimes(2)
  })

  it('a rejecting attachments removal never rejects the orchestration nor skips the rest', async () => {
    const { store, transcript } = fakes(['t1', 't2'])
    const attachments = {
      delete: vi.fn<DeleteFn>(async (threadId) => {
        if (threadId === 't1') throw new Error('EPERM')
      }),
    }

    await expect(
      removeWorkspace({ workspaceId: 'w1', store, transcript, attachments }),
    ).resolves.toBeUndefined()
    expect(attachments.delete).toHaveBeenCalledWith('t2')
    expect(transcript.delete).toHaveBeenCalledTimes(2)
  })

  it('stops the agent BEFORE touching the store when a warm agent is present', async () => {
    const { store, transcript } = fakes(['t1'])
    const order: string[] = []
    const stopAgent = vi.fn(async () => {
      order.push('stop')
    })
    store.removeWorkspace.mockImplementation(async () => {
      order.push('store')
      return ['t1']
    })
    transcript.delete.mockImplementation(async () => {
      order.push('transcript')
    })

    await removeWorkspace({ workspaceId: 'w1', store, transcript, stopAgent })

    expect(stopAgent).toHaveBeenCalledOnce()
    expect(order).toEqual(['stop', 'store', 'transcript'])
  })

  it('is fine with NO stopAgent (a cold Workspace) — still removes records + transcripts', async () => {
    const { store, transcript } = fakes(['t1'])

    await expect(removeWorkspace({ workspaceId: 'w1', store, transcript })).resolves.toBeUndefined()
    expect(store.removeWorkspace).toHaveBeenCalledWith('w1')
    expect(transcript.delete).toHaveBeenCalledWith('t1')
  })

  it('RESOLVES even when the store removal rejects, and skips transcript cleanup (nothing removed)', async () => {
    const { store, transcript } = fakes(['t1'])
    store.removeWorkspace.mockRejectedValue(new Error('EROFS: read-only file system'))

    await expect(removeWorkspace({ workspaceId: 'w1', store, transcript })).resolves.toBeUndefined()
    // A throw is treated as "nothing removed", so no transcript is deleted.
    expect(transcript.delete).not.toHaveBeenCalled()
  })

  it('one transcript-delete rejecting does NOT skip the others', async () => {
    const { store, transcript } = fakes(['t1', 't2', 't3'])
    transcript.delete.mockImplementation(async (id: string) => {
      if (id === 't2') throw new Error('EACCES: permission denied')
    })

    await expect(removeWorkspace({ workspaceId: 'w1', store, transcript })).resolves.toBeUndefined()
    // All three attempted despite t2 rejecting.
    expect(transcript.delete).toHaveBeenCalledWith('t1')
    expect(transcript.delete).toHaveBeenCalledWith('t2')
    expect(transcript.delete).toHaveBeenCalledWith('t3')
    expect(transcript.delete).toHaveBeenCalledTimes(3)
  })

  it('still removes records when the best-effort stop REJECTS (no error surfaced)', async () => {
    const { store, transcript } = fakes(['t1'])
    const stopAgent = vi.fn(async () => {
      throw new Error('dispose failed — agent gone')
    })

    await expect(
      removeWorkspace({ workspaceId: 'w1', store, transcript, stopAgent }),
    ).resolves.toBeUndefined()
    expect(store.removeWorkspace).toHaveBeenCalledWith('w1')
    expect(transcript.delete).toHaveBeenCalledWith('t1')
  })
})
