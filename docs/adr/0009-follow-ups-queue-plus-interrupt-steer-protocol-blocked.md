# Follow-ups are handled by client-side QUEUE + INTERRUPT; steer is protocol-blocked and deferred

When the user submits a message while a Thread's turn is still streaming, vibe-mistro **queues** it
(client-side) and auto-sends it as a fresh `session/prompt` once the turn ends, and offers a **Stop**
button that **interrupts** the active turn via `session/cancel`. It does **not** "steer" (inject into the
live turn): the #102 spike proved vibe-acp rejects a concurrent `session/prompt` and exposes no steer
method. This mirrors CodexMonitor's Queue + Interrupt (`turn/start` + `turn/interrupt`) but drops its
third verb (`turn/steer`) until vibe-acp gains one.

## Verified protocol (acp-capture §12, spike #102, vibe-acp 2.18.3)

- **`session/cancel` is a NOTIFICATION** (no id, no response), params `{sessionId}`. Sent mid-turn, the
  in-flight `session/prompt` **resolves** (not rejects) with `stopReason:"cancelled"` (zero usage) and
  streaming stops immediately. So `stopReason ∈ {end_turn, cancelled}`.
- **Concurrent prompts are REJECTED**: a second `session/prompt` while the first streams fails with
  `-32602 "Concurrent prompts are not supported yet, wait for agent loop to finish"`. There is **no
  steer / mid-turn injection** — not a method, and a concurrent call hard-errors.

## Decisions

- **Queue + Interrupt, NOT steer.** A follow-up submitted during a turn is held in a client-side queue and
  sent as a normal `session/prompt` after the turn's `stopReason` resolves; a Stop control interrupts the
  turn via the `session/cancel` notification. Steer (inject-without-stopping) is **out** — protocol-blocked.
  The error wording ("not supported *yet*") suggests vibe may add it; we leave the composer's send path a
  natural seam to add a `steer` intent later, but ship nothing speculative.
- **Interrupt first, then Queue** (build order). Slice 1 = the Stop button (`session/cancel`), atomic and
  independently useful for runaway turns. Slice 2 = the follow-up queue on top. Steer, if ever, is a later
  slice gated on a new protocol capability.
- **Interrupt needs no new turn-resolution path.** Because the cancelled `session/prompt` *resolves*
  (`stopReason:"cancelled"`), main's existing `runPromptTurn` returns `{ok:true, result}` and the renderer's
  `turn-complete` already flips `isProcessing` off and tees a clean turn end. A cancel is therefore a thin
  new *input* (an IPC that fires the notification), not a new *output* shape — no ErrorItem, no "cancelled"
  notice for v1 (the turn simply ends where it stopped).
- **The Stop notification is a new fire-and-forget IPC** (`cancelTurn {agentId, sessionId}`) → main resolves
  the pool agent and calls `WorkspaceAgent.cancel(sessionId)` → `client.notify('session/cancel', {sessionId})`.
  No-op when the sessionId is null (an unbound draft has no turn) or the agent isn't initialized. This keeps
  the single-`acp:event`-channel discipline (ADR-0001) — cancel is an outbound control, not an event.
- **The follow-up queue is renderer-only, per-Thread, ephemeral (slice 2).** It holds MULTIPLE pending
  messages keyed by `threadId`, lives ABOVE the conversation view's per-Thread remount (so it survives a
  Thread switch), and is NOT persisted across app restart (like CodexMonitor; drafts/composer state are
  renderer-only, ADR-0006). It auto-flushes one message at a time as a fresh `session/prompt` when the
  Thread's turn ends. Queued messages render as removable rows above the composer; edit-in-place is deferred.
- **Compose stays enabled while streaming (slice 2).** Enter during a turn ENQUEUES (composer no longer
  hard-disables mid-turn); the Stop button interrupts. This is the CodexMonitor posture minus steer. The
  per-message override key (queue-vs-steer flip) is moot without steer, so it is not built.

## Considered alternatives

- **Steer (mid-turn injection), à la CodexMonitor `turn/steer`.** Rejected as impossible today: vibe-acp has
  no steer method and rejects concurrent prompts (`-32602`, spike #102). Revisit if vibe adds a steer/inject
  capability; the queue's flush seam is where it would attach.
- **Interrupt-only, no queue (t3code posture: block the composer while running + a Stop button).** Rejected
  as the end state — it's strictly less than what vibe supports (a client can safely serialize follow-ups).
  But it IS effectively slice 1 in isolation, so we ship it first and add the queue second.
- **Persist the queue across restart / in the metadata store.** Rejected for v1: follow-ups are transient
  intent, not durable Thread state (ADR-0005 owns only durable Thread id/title/transcript); a queued message
  that outlives a restart would surprise the user. Renderer-only ephemeral state matches drafts (#60).
- **A "cancelled" notice/ErrorItem in the transcript.** Rejected for v1: the turn resolving `cancelled` is a
  normal, user-initiated end; surfacing it as an error would be noise. The partial output already streamed
  stays; the turn just stops. Revisit if users want an explicit "stopped here" marker.
