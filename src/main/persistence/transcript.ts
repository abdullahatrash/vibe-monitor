import { appendFile, readFile, unlink } from 'node:fs/promises'
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
 *
 * SEAM CONTRACT (ADR-0005 hardening): this class is the ONLY reader/writer of the
 * transcript files. No other module may build a `<threadId>.jsonl` path or touch
 * that dir — the `userData` transcripts dir is single-sourced in `src/main/index.ts`
 * and injected here. Keep it that way so the JSONL→SQLite swap stays a drop-in.
 *
 * SCHEMA VERSIONING: each log's FIRST line is a version header (see
 * `TRANSCRIPT_SCHEMA_VERSION`), so a future reader/migrator can tell which format
 * a file is in. Legacy logs predate the header and are read as v1. The header is
 * NOT a conversation entry — replay skips it (`isTranscriptEntry` rejects it).
 */
export type { TranscriptEntry }

/**
 * The on-disk format version, written as the first line of every new transcript.
 * Bump ONLY on a backward-incompatible change to the entry format, and teach the
 * reader/migrator to branch on the header version. A log with no header is v1.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1

/** The header line's discriminator tag. Deliberately outside the entry union so
 * `isTranscriptEntry` drops it and replay never sees it as a conversation event. */
const TRANSCRIPT_HEADER_TAG = '__transcript_header'

/** The version-header record written as line 1 of a fresh log. */
function transcriptHeader(): { t: typeof TRANSCRIPT_HEADER_TAG; v: number } {
  return { t: TRANSCRIPT_HEADER_TAG, v: TRANSCRIPT_SCHEMA_VERSION }
}

/**
 * The format version of a raw transcript: the `v` from its header line, or `1`
 * for a legacy header-less log. For future migrators (JSONL→SQLite) to branch on;
 * `parseTranscript` itself is version-agnostic today (only v1 exists).
 */
export function transcriptVersionOf(raw: string): number {
  const first = raw.split('\n', 1)[0]
  if (!first) return TRANSCRIPT_SCHEMA_VERSION
  try {
    const parsed = JSON.parse(first) as { t?: unknown; v?: unknown }
    if (parsed.t === TRANSCRIPT_HEADER_TAG && typeof parsed.v === 'number') return parsed.v
  } catch {
    // First line isn't a header (legacy log starts with a real entry) — v1.
  }
  return TRANSCRIPT_SCHEMA_VERSION
}

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
 * The agent's context was reset on a reopen (TB4 #33), teed at `sendPrompt` when a
 * `session/load` resume failed and main re-bound a fresh `session/new` — mirrors
 * the `agent-rebound` reducer action. Persisted so the notice survives a later
 * reopen; the user-facing copy is a renderer-side constant, so it carries none.
 */
export function agentReboundEntry(): TranscriptEntry {
  return { t: 'agent-rebound' }
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
  /** Remove a Thread's log file (TB6 delete). Defaults to `fs.unlink`. */
  unlink?: (path: string) => Promise<void>
}

export class TranscriptStore {
  private readonly dir: string
  private readonly appendFn: (path: string, line: string) => Promise<void>
  private readonly readFileFn: (path: string) => Promise<string>
  private readonly unlinkFn: (path: string) => Promise<void>
  /**
   * One serialized promise chain per Thread (keyed by log path). Each `append`
   * links onto its Thread's tail SYNCHRONOUSLY (read-then-set with no `await`
   * between), so appends run in CALL order even when fired concurrently
   * fire-and-forget — without this, two un-awaited `appendFile`s to the same
   * file race and land out of order, corrupting replay (e.g. a chunk's text
   * scrambles, or a `tool_call_update` folds before its `tool_call`).
   */
  private readonly tails = new Map<string, Promise<void>>()
  /**
   * Threads whose header we've already ensured this session (so we don't re-check
   * on every append). Cleared on `delete` so a re-created log gets a fresh header.
   * Restart-safe because `ensureHeader` checks the file's CONTENTS, not this set,
   * to decide whether to write — the set is only a per-session fast-path.
   */
  private readonly headerEnsured = new Set<string>()

  constructor(deps: TranscriptDeps) {
    this.dir = deps.dir
    this.appendFn = deps.append ?? ((path, line) => appendFile(path, line, 'utf8'))
    this.readFileFn = deps.readFile ?? ((path) => readFile(path, 'utf8'))
    this.unlinkFn = deps.unlink ?? unlink
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
    const next = prev
      // Ensure the version header is line 1 BEFORE this entry, inside the same
      // serialized chain so it can't race a concurrent append.
      .then(() => this.ensureHeader(threadId, path))
      .then(() => this.appendFn(path, line))
      .catch(() => {
        // A transcript write failure is non-fatal — the conversation proceeds, and
        // the chain stays alive (resolved) so later appends still run in order.
      })
    this.tails.set(threadId, next)
    return next
  }

  /**
   * Guarantee a fresh log's FIRST line is the version header, exactly once per
   * file. Restart-safe: it checks the file's CURRENT contents rather than an
   * in-memory "first append" flag, so after a restart an existing non-empty log
   * (header, or a legacy header-less v1 log) is left intact and only a brand-new
   * or empty file gets the header. Self-guarded: a header read/write failure is
   * swallowed so it can never cost the entry that follows it — a missing header
   * simply reads back as v1.
   */
  private async ensureHeader(threadId: string, path: string): Promise<void> {
    if (this.headerEnsured.has(threadId)) return
    this.headerEnsured.add(threadId)
    try {
      let existing = ''
      try {
        existing = await this.readFileFn(path)
      } catch {
        existing = '' // ENOENT — a brand-new log
      }
      if (existing.length === 0) {
        await this.appendFn(path, `${JSON.stringify(transcriptHeader())}\n`)
      }
    } catch {
      // Header write failed — proceed to append the entry regardless. Losing the
      // header (reads back as v1) must never lose the conversation line.
    }
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

  /**
   * Delete a Thread's log (TB6 #35). Best-effort by design, mirroring the guarded
   * appends: a MISSING file (a never-prompted draft has no JSONL) is a no-op, and
   * ANY unlink failure is swallowed — tearing down our records must never throw,
   * since the metadata record is already being removed alongside (ADR-0005).
   *
   * Dropping the Thread's append-chain tail only stops FUTURE chained appends —
   * it does NOT cancel an `appendFile` already in flight (which, with flag 'a',
   * would recreate the file after the unlink) nor a fresh tee arriving on a new
   * chain. That's acceptable solely because delete is COLD-LIST-ONLY today: no
   * live agent is streaming appends to a Thread being deleted from the cold list.
   * This MUST be revisited before wiring delete into the live `ConnectedWorkspace`
   * thread list — do NOT rely on this tail-drop as a real cancellation guard.
   */
  async delete(threadId: string): Promise<void> {
    this.tails.delete(threadId)
    // Forget the header fast-path so a re-created log for this id re-writes it.
    this.headerEnsured.delete(threadId)
    try {
      await this.unlinkFn(this.pathFor(threadId))
    } catch {
      // No log (ENOENT) or an unremovable file — non-fatal; deletion proceeds.
    }
  }
}

/**
 * Parse a JSONL transcript into its entries, tolerating a malformed or partial
 * trailing line. A crash mid-append (or a torn write) can leave the final line
 * truncated; we parse each line independently and SKIP any that don't yield a
 * well-formed entry rather than throwing — so the valid prefix always replays.
 *
 * The version-header line (present on logs written since the versioning change)
 * is not a conversation entry, so `isTranscriptEntry` drops it here — replay is
 * unaffected. Read the version separately via `transcriptVersionOf` if needed.
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
    t === 'resolve-permission' ||
    t === 'agent-rebound'
  )
}
