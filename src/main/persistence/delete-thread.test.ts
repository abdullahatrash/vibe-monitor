import { describe, it, expect, vi } from 'vitest'
import { deleteThread } from './delete-thread'

/**
 * The TB6 (#35) delete orchestration: best-effort close the Thread's live ACP
 * session (if any), then remove OUR records — the metadata entry and the JSONL
 * transcript. Per ADR-0005 a close failure (or no live session) must NEVER block
 * the deletion or surface as a hard error. Exercised with injected fakes for the
 * store / transcript / close seams — no real `vibe-acp`, no `userData`.
 */

type AsyncId = (id: string) => Promise<void>

function fakes(): {
  store: { deleteThread: ReturnType<typeof vi.fn<AsyncId>> }
  transcript: { delete: ReturnType<typeof vi.fn<AsyncId>> }
} {
  return {
    store: { deleteThread: vi.fn<AsyncId>(async () => {}) },
    transcript: { delete: vi.fn<AsyncId>(async () => {}) },
  }
}

describe('deleteThread (TB6 #35)', () => {
  it('removes the metadata record AND the transcript for a cold Thread (no live session)', async () => {
    const { store, transcript } = fakes()

    await deleteThread({ threadId: 't1', store, transcript })

    expect(store.deleteThread).toHaveBeenCalledWith('t1')
    expect(transcript.delete).toHaveBeenCalledWith('t1')
  })

  it('attempts a best-effort close before removing records when a session is live', async () => {
    const { store, transcript } = fakes()
    const order: string[] = []
    const closeSession = vi.fn(async () => {
      order.push('close')
    })
    store.deleteThread.mockImplementation(async () => {
      order.push('store')
    })
    transcript.delete.mockImplementation(async () => {
      order.push('transcript')
    })

    await deleteThread({ threadId: 't2', store, transcript, closeSession })

    expect(closeSession).toHaveBeenCalledOnce()
    // Close is attempted first, then our records come down.
    expect(order).toEqual(['close', 'store', 'transcript'])
  })

  it('RESOLVES even when the store record removal rejects (persist failure is best-effort)', async () => {
    const { store, transcript } = fakes()
    // store.deleteThread -> persist() -> writeFile/rename, which reject on a full /
    // read-only userData. That must NOT reject the orchestration (the renderer's
    // onClick has no .catch — mirrors recordWorkspaceOpen's guard).
    store.deleteThread.mockRejectedValue(new Error('EROFS: read-only file system'))

    await expect(deleteThread({ threadId: 't4', store, transcript })).resolves.toBeUndefined()
    // The transcript removal is still attempted despite the store failure.
    expect(transcript.delete).toHaveBeenCalledWith('t4')
  })

  it('RESOLVES even when the transcript removal rejects (best-effort)', async () => {
    const { store, transcript } = fakes()
    transcript.delete.mockRejectedValue(new Error('EACCES: permission denied'))

    await expect(deleteThread({ threadId: 't5', store, transcript })).resolves.toBeUndefined()
    expect(store.deleteThread).toHaveBeenCalledWith('t5')
  })

  it('drops the attachments alongside the records when the seam is provided', async () => {
    const { store, transcript } = fakes()
    const attachments = { delete: vi.fn<AsyncId>(async () => {}) }

    await deleteThread({ threadId: 't6', store, transcript, attachments })

    expect(attachments.delete).toHaveBeenCalledWith('t6')
  })

  it('RESOLVES even when the attachments removal rejects (best-effort)', async () => {
    const { store, transcript } = fakes()
    const attachments = {
      delete: vi.fn<AsyncId>(async () => {
        throw new Error('EPERM')
      }),
    }

    await expect(
      deleteThread({ threadId: 't7', store, transcript, attachments }),
    ).resolves.toBeUndefined()
    expect(store.deleteThread).toHaveBeenCalledWith('t7')
    expect(transcript.delete).toHaveBeenCalledWith('t7')
  })

  it('still completes the deletion when the best-effort close REJECTS (no error surfaced)', async () => {
    const { store, transcript } = fakes()
    const closeSession = vi.fn(async () => {
      throw new Error('session/close failed — agent gone')
    })

    // A close failure must not propagate, and must not block record removal.
    await expect(
      deleteThread({ threadId: 't3', store, transcript, closeSession }),
    ).resolves.toBeUndefined()
    expect(store.deleteThread).toHaveBeenCalledWith('t3')
    expect(transcript.delete).toHaveBeenCalledWith('t3')
  })
})
