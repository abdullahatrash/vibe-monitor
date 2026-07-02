import type { TranscriptEntry } from './transcript'

/**
 * Bridge the ACP-keyed event flow to the JSONL key (the minted Thread `id`, TB1) —
 * previously a scatter of module globals + free functions in index.ts, now one unit so
 * its invariants are enforced (and tested) in one place.
 *
 * ROUTING: the PRIMARY route is the event's own ACP `sessionId` (via the injected
 * store lookup) so each event/prompt lands in ITS Thread even when one agent has opened
 * several Threads in sequence — the `agentId -> threadId` map is last-write-wins, so a
 * late event from a prior session would misroute under it. The map is the FALLBACK,
 * for chokepoints with no sessionId in hand (e.g. `respondPermission`).
 *
 * Residual (documented): both routes miss during the brief window after `session/new`
 * returns but before the first-prompt bind persists the sessionId + seeds the map — a
 * `session/update` streamed THEN (notably the immediate `available_commands_update`,
 * not rendered) is dropped from replay. The Thread title is unaffected — it's also
 * persisted in the metadata record.
 *
 * TOMBSTONES: Thread ids whose JSONL has been (or is being) removed and must NEVER be
 * re-created ("Remove project" — a Workspace can be removed MID-TURN).
 * `TranscriptStore.delete` only drops the tail of the append chain; it can't cancel a
 * tee that arrives AFTER the unlink — notably the `turn-error` teed from
 * `runPromptTurn`'s catch when the disposed agent rejects its in-flight prompt (that
 * tee uses the Thread id directly, bypassing the map). Without the guard `append`
 * would start a FRESH chain and re-write a header + line, leaking an orphaned
 * transcript no metadata references. Tombstone a Workspace's Thread ids BEFORE removal
 * so every such late tee is suppressed at the `tee` choke point. Thread ids are
 * unique-and-never-reused, so the set is monotonic and bounded by removals this
 * session — no cleanup needed.
 *
 * Every write is best-effort (ADR-0005): a null sink (transcript dir creation failed),
 * an unresolved Thread id, or a tombstoned Thread skips the tee; the append itself
 * swallows I/O errors.
 */

/** The append surface of `TranscriptStore` (null when the transcript dir failed to create). */
export interface TranscriptSink {
  append(threadId: string, entry: TranscriptEntry): Promise<void>
}

export class TranscriptBridge {
  private readonly threads = new Map<string, string>()
  private readonly tombstoned = new Set<string>()

  constructor(
    private readonly deps: {
      sink: TranscriptSink | null
      /** Resolve a Thread id by ACP sessionId (the metadata store lookup). */
      resolveBySession: (sessionId: string | null) => string | null
    },
  ) {}

  /** Point the fallback map at the Thread an agent is currently serving (last-write-wins). */
  bind(agentId: string, threadId: string): void {
    this.threads.set(agentId, threadId)
  }

  /** Drop an evicted/stopped agent's entry so the map can't leak across evictions. */
  evictAgent(agentId: string): void {
    this.threads.delete(agentId)
  }

  /** Drop every map entry pointing at a Thread (before its delete tears the JSONL down). */
  clearThread(threadId: string): void {
    for (const [agentId, bound] of this.threads) {
      if (bound === threadId) this.threads.delete(agentId)
    }
  }

  /** Mark a Thread's JSONL as removed-forever; every later tee to it is suppressed. */
  tombstone(threadId: string): void {
    this.tombstoned.add(threadId)
  }

  /**
   * Whether a Thread is tombstoned — lets sibling persistence (the attachment
   * save in `runPromptTurn`) skip alongside the suppressed tee, so a
   * removeWorkspace racing an in-flight prompt can't re-create the Thread's
   * attachments dir after its delete (same hazard class the tee guard closes).
   */
  isTombstoned(threadId: string): boolean {
    return this.tombstoned.has(threadId)
  }

  /** Resolve the Thread id for a chokepoint, or null to skip the tee (best-effort). */
  threadIdFor(agentId: string, sessionId?: string | null): string | null {
    return this.deps.resolveBySession(sessionId ?? null) ?? this.threads.get(agentId) ?? null
  }

  /** Tee one conversation INPUT to a Thread's JSONL — fire-and-forget, best-effort. */
  tee(threadId: string | null, entry: TranscriptEntry): void {
    if (!this.deps.sink || !threadId || this.tombstoned.has(threadId)) return
    void this.deps.sink.append(threadId, entry)
  }
}
