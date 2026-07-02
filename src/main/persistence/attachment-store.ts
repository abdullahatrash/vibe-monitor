import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PromptImage, TranscriptImageRef } from '../../shared/ipc'

/**
 * The per-Thread prompt-image attachments we OWN (ADR-0005 sibling of the JSONL
 * transcript). `runPromptTurn` persists a prompt's images here BEFORE teeing the
 * `user-prompt` entry, so the entry's `images` refs point at files that already
 * exist; on reopen the renderer resolves the refs back to data URLs via ONE
 * batched `readThreadAttachments` and replays the prompt with its images. The
 * LIVE send is untouched — the agent receives the base64 directly; these files
 * exist only for our replay.
 *
 * SEAM CONTRACT (mirrors TranscriptStore): this class is the ONLY reader/writer
 * of the attachment files. No other module may build an `attachments/<threadId>`
 * path — the `userData` attachments dir is single-sourced in `src/main/index.ts`
 * and injected here. Keep it that way so a future storage swap stays a drop-in.
 *
 * Every operation is best-effort and NEVER throws (ADR-0005): a failed image
 * write degrades that image out of the returned refs (the prompt replays
 * text-only), a failed read omits that image, and delete failures are swallowed
 * — always logged, never gating the live turn or teardown.
 */

/**
 * Per-image persistence cap (decoded bytes). Per-image, not per-thread: images
 * arrive and fail per-image (vibe's own -31008 is per-image), and a per-thread
 * budget would need cumulative bookkeeping for no real win — thread deletion
 * already reclaims. An oversized image is simply not persisted (replays
 * text-only); the live send is not our limit to enforce.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/**
 * Total-bytes cap on a `readAll` reply, so one pathological thread of
 * screenshots can't blow the IPC payload. Files beyond it are omitted (logged).
 */
export const MAX_READ_ALL_BYTES = 64 * 1024 * 1024

/**
 * The persistable mime set — mirrors the renderer's `ACCEPTED_IMAGE_TYPES`
 * (src/renderer/src/conversation/image-attach.ts). An unknown mime is skipped at
 * save (nothing upstream should produce one; log if it happens).
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Belt-and-suspenders vs path traversal: we mint every filename (uuid + mapped
 * extension) and key dirs by our minted Thread ids, but validate BOTH on every
 * entry point anyway — this store creates directories, so it hardens harder
 * than `readTranscript` (which only ever reads `<threadId>.jsonl`).
 */
const THREAD_ID_RE = /^[A-Za-z0-9_-]+$/
const FILE_NAME_RE = /^[A-Za-z0-9-]+\.(png|jpg|webp|gif)$/

/**
 * The injectable seam: where the attachment dirs live and how to touch the fs.
 * Production wires `node:fs/promises` + a `userData` attachments dir; tests pass
 * a temp dir (and may stub `writeFile` to simulate a failing disk), mirroring
 * TranscriptStore.
 */
export interface AttachmentStoreDeps {
  /** Directory holding the per-Thread subdirs (`<dir>/<threadId>/<file>`). */
  dir: string
  /** Create a Thread's subdir (recursive). Defaults to `fs.mkdir`. */
  mkdir?: (path: string) => Promise<unknown>
  /** Write one image file. Defaults to `fs.writeFile`. */
  writeFile?: (path: string, data: Uint8Array) => Promise<void>
  /** Read one image file. Defaults to `fs.readFile`. */
  readFile?: (path: string) => Promise<Buffer>
  /** List a Thread's subdir. Defaults to `fs.readdir`. */
  readdir?: (path: string) => Promise<string[]>
  /** Remove a Thread's whole subdir. Defaults to `fs.rm` (recursive + force). */
  rm?: (path: string) => Promise<void>
}

export class AttachmentStore {
  private readonly dir: string
  private readonly mkdirFn: (path: string) => Promise<unknown>
  private readonly writeFileFn: (path: string, data: Uint8Array) => Promise<void>
  private readonly readFileFn: (path: string) => Promise<Buffer>
  private readonly readdirFn: (path: string) => Promise<string[]>
  private readonly rmFn: (path: string) => Promise<void>

  constructor(deps: AttachmentStoreDeps) {
    this.dir = deps.dir
    this.mkdirFn = deps.mkdir ?? ((path) => mkdir(path, { recursive: true }))
    this.writeFileFn = deps.writeFile ?? ((path, data) => writeFile(path, data))
    this.readFileFn = deps.readFile ?? ((path) => readFile(path))
    this.readdirFn = deps.readdir ?? ((path) => readdir(path))
    this.rmFn = deps.rm ?? ((path) => rm(path, { recursive: true, force: true }))
  }

  /** Absolute path of a Thread's attachments subdir. */
  private dirFor(threadId: string): string {
    return join(this.dir, threadId)
  }

  /**
   * Persist a prompt's images; returns the refs for the transcript's
   * `user-prompt` entry. Best-effort PER IMAGE: an oversized, unknown-mime, or
   * write-failed image is skipped (logged) and the rest still persist — the
   * caller tees whatever survived. Always resolves; never throws (a persistence
   * failure must never gate the live turn).
   */
  async saveAll(threadId: string, images: PromptImage[]): Promise<TranscriptImageRef[]> {
    if (!THREAD_ID_RE.test(threadId)) {
      console.error(`[vibe-mistro:attachments] saveAll refused malformed threadId: ${threadId}`)
      return []
    }
    const refs: TranscriptImageRef[] = []
    let dirReady = false
    for (const image of images) {
      try {
        const ext = EXT_BY_MIME[image.mimeType]
        if (!ext) {
          console.error(`[vibe-mistro:attachments] skipped unknown mime ${image.mimeType} (${threadId})`)
          continue
        }
        const bytes = Buffer.from(image.data, 'base64')
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          console.error(
            `[vibe-mistro:attachments] skipped oversized image (${bytes.byteLength} bytes) (${threadId})`,
          )
          continue
        }
        if (!dirReady) {
          await this.mkdirFn(this.dirFor(threadId))
          dirReady = true
        }
        const file = `${randomUUID()}.${ext}`
        await this.writeFileFn(join(this.dirFor(threadId), file), bytes)
        refs.push({ file, mimeType: image.mimeType })
      } catch (err) {
        console.error(
          `[vibe-mistro:attachments] image write failed (${threadId}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return refs
  }

  /**
   * All of a Thread's attachments as `file name -> data URL` — the batched
   * replay read. A missing subdir (image-less Thread) reads back `{}`; a foreign
   * or unreadable file is omitted; past `MAX_READ_ALL_BYTES` total, the rest are
   * omitted (logged) so the reply stays bounded. Never throws.
   */
  async readAll(threadId: string): Promise<Record<string, string>> {
    if (!THREAD_ID_RE.test(threadId)) {
      console.error(`[vibe-mistro:attachments] readAll refused malformed threadId: ${threadId}`)
      return {}
    }
    let names: string[]
    try {
      names = await this.readdirFn(this.dirFor(threadId))
    } catch {
      return {} // ENOENT — the Thread has no attachments
    }
    const result: Record<string, string> = {}
    let total = 0
    for (const name of names) {
      if (!FILE_NAME_RE.test(name)) continue // foreign file — not ours to serve
      try {
        const bytes = await this.readFileFn(join(this.dirFor(threadId), name))
        total += bytes.byteLength
        if (total > MAX_READ_ALL_BYTES) {
          console.error(`[vibe-mistro:attachments] readAll capped at ${MAX_READ_ALL_BYTES} bytes (${threadId})`)
          break
        }
        const mime = MIME_BY_EXT[name.slice(name.lastIndexOf('.') + 1)]
        result[name] = `data:${mime};base64,${bytes.toString('base64')}`
      } catch (err) {
        console.error(
          `[vibe-mistro:attachments] read failed (${threadId}/${name}): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    return result
  }

  /**
   * Drop the Thread's whole attachments subdir (thread delete / remove-Workspace
   * teardown, alongside the transcript drop). Best-effort: a missing dir is a
   * no-op (`force`), any failure is logged and swallowed — tearing down our
   * records must never throw (ADR-0005).
   */
  async delete(threadId: string): Promise<void> {
    if (!THREAD_ID_RE.test(threadId)) {
      console.error(`[vibe-mistro:attachments] delete refused malformed threadId: ${threadId}`)
      return
    }
    try {
      await this.rmFn(this.dirFor(threadId))
    } catch (err) {
      console.error(
        `[vibe-mistro:attachments] delete failed (${threadId}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
