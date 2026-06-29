import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TranscriptEntry } from '../../shared/ipc'

/**
 * The per-Thread visible-conversation transcript we OWN (ADR-0005). The main
 * process tees the conversation INPUTS — the user's prompt, each streamed
 * `session/update` payload, the turn outcome, and permission responses — to an
 * append-only JSONL file (`<Thread id>.jsonl`) as they cross the IPC chokepoints.
 * On reopen (TB3) the log replays through the renderer reducer to rebuild the
 * view with NO `vibe-acp` process. The renderer stays pure (ADR-0001) — it never
 * writes here.
 *
 * `TranscriptEntry` (the entry union, mirroring the reducer's `ConversationAction`
 * inputs) lives in `src/shared/ipc.ts` so the renderer replay can name it across
 * the composite project boundary; re-exported here for the main-side writers.
 */
export type { TranscriptEntry }

/** The user's prompt, teed at `sendPrompt` — mirrors the `send-prompt` action. */
export function userPromptEntry(id: string, text: string): TranscriptEntry {
  return { t: 'user-prompt', id, text }
}

/** A streamed payload, teed at the `acp:event` forward — mirrors `acp-event`. */
export function acpEventEntry(payload: unknown): TranscriptEntry {
  return { t: 'acp-event', payload }
}

/**
 * The turn ended cleanly, teed at `sendPrompt` once `session/prompt` resolves —
 * mirrors `turn-complete`. Captured here because that signal lives only in the
 * `sendPrompt` IPC RESPONSE (never an `acp:event`), so without it a replay would
 * leave `isProcessing` stuck true.
 */
export function turnCompleteEntry(): TranscriptEntry {
  return { t: 'turn-complete' }
}

/** The turn failed, teed at `sendPrompt` on a thrown/errored prompt — mirrors `turn-error`. */
export function turnErrorEntry(message: string): TranscriptEntry {
  return { t: 'turn-error', message }
}

/**
 * A permission response, teed at `respondPermission` — mirrors `resolve-permission`.
 * Main observes `requestId` + `optionId` at the chokepoint but not the option's
 * display `name` (that lives in the renderer's permission item), so `name`
 * defaults to `null`; TB3 replay can recover it from the matching request event.
 */
export function resolvePermissionEntry(
  requestId: number | string,
  optionId: string,
  name: string | null = null,
): TranscriptEntry {
  return { t: 'resolve-permission', requestId, optionId, name }
}

/**
 * Extract the ACP `sessionId` an `acp:event` payload is FOR (`session/update`
 * and `session/request_permission` both carry `params.sessionId`). Lets the tee
 * route each event to its OWN Thread via the store's sessionId lookup, rather
 * than an agent's last-opened Thread — correct when an agent hosts several
 * Threads in sequence (late events from a prior session must not misroute).
 * Lifecycle payloads (`{type:'exit'|...}`) carry none -> `null`.
 */
export function sessionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const params = (payload as { params?: unknown }).params
  if (!params || typeof params !== 'object') return null
  const sessionId = (params as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : null
}

/**
 * The injectable seam: where the logs live and how to append a line. Production
 * wires `node:fs/promises` + a `userData` transcripts dir; tests pass a temp dir
 * (and may stub `append` to simulate a failing disk), mirroring MetadataStore.
 */
export interface TranscriptDeps {
  /** Directory holding the `<threadId>.jsonl` files. */
  dir: string
  /** Append a line to a file (created if absent). Defaults to `fs.appendFile`. */
  append?: (path: string, line: string) => Promise<void>
  /** Read a Thread's whole log. Defaults to `fs.readFile`. */
  readFile?: (path: string) => Promise<string>
}

export class TranscriptStore {
  private readonly dir: string
  private readonly appendFn: (path: string, line: string) => Promise<void>
  private readonly readFileFn: (path: string) => Promise<string>
  /**
   * One serialized promise chain per Thread (keyed by log path). Each `append`
   * links onto its Thread's tail SYNCHRONOUSLY (read-then-set with no `await`
   * between), so appends run in CALL order even when fired concurrently
   * fire-and-forget — without this, two un-awaited `appendFile`s to the same
   * file race and land out of order, corrupting replay (e.g. a chunk's text
   * scrambles, or a `tool_call_update` folds before its `tool_call`).
   */
  private readonly tails = new Map<string, Promise<void>>()

  constructor(deps: TranscriptDeps) {
    this.dir = deps.dir
    this.appendFn = deps.append ?? ((path, line) => appendFile(path, line, 'utf8'))
    this.readFileFn = deps.readFile ?? ((path) => readFile(path, 'utf8'))
  }

  /** Absolute path of a Thread's log. */
  private pathFor(threadId: string): string {
    return join(this.dir, `${threadId}.jsonl`)
  }

  /**
   * Append one entry as a single JSON line to the Thread's log, serialized after
   * the Thread's prior appends so call order is preserved. Best-effort by design
   * (mirrors the guarded metadata writes): each link swallows its own I/O error
   * — a failed append can't break the live conversation NOR poison the chain for
   * the entries after it (losing one line beats wedging the turn or the order).
   */
  append(threadId: string, entry: TranscriptEntry): Promise<void> {
    const path = this.pathFor(threadId)
    const line = `${JSON.stringify(entry)}\n`
    const prev = this.tails.get(threadId) ?? Promise.resolve()
    const next = prev.then(() => this.appendFn(path, line)).catch(() => {
      // A transcript write failure is non-fatal — the conversation proceeds, and
      // the chain stays alive (resolved) so later appends still run in order.
    })
    this.tails.set(threadId, next)
    return next
  }

  /**
   * Read a Thread's log into its entry array (the TB3 replay source). A missing
   * log yields `[]`; a malformed/partial trailing line is skipped, never fatal.
   */
  async read(threadId: string): Promise<TranscriptEntry[]> {
    let raw: string
    try {
      raw = await this.readFileFn(this.pathFor(threadId))
    } catch {
      // No log yet (ENOENT) — an unwritten Thread reads back empty.
      return []
    }
    return parseTranscript(raw)
  }
}

/**
 * Parse a JSONL transcript into its entries, tolerating a malformed or partial
 * trailing line. A crash mid-append (or a torn write) can leave the final line
 * truncated; we parse each line independently and SKIP any that don't yield a
 * well-formed entry rather than throwing — so the valid prefix always replays.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue // blank/final newline — not a torn record
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // malformed/partial line (e.g. a torn trailing write) — skip it
    }
    if (isTranscriptEntry(parsed)) entries.push(parsed)
  }
  return entries
}

/** Shape-guard a parsed line to a known entry tag — drops foreign/garbled JSON. */
function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false
  const t = (value as { t?: unknown }).t
  return (
    t === 'user-prompt' ||
    t === 'acp-event' ||
    t === 'turn-complete' ||
    t === 'turn-error' ||
    t === 'resolve-permission'
  )
}
