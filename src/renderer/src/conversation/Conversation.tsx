import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react'
import type {
  AuthMethod,
  ThreadAgentControls,
  ThreadConfigAxis,
  ThreadModels,
  ThreadModes,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { FileOpenProvider } from './file-open-context'
import { isRejectOption } from './permission-option'
import type { FileLink } from './file-link'
import {
  conversationReducer,
  initialConversationState,
  type PermissionItem,
  type PermissionOption,
} from './reducer'
import { eventBelongsToThread } from './event-routing'
import { replayTranscript, transcriptHasImages } from './replay'
import { replayCache } from './replay-cache'
import { MessageScroller } from './MessageScroller'
import { Item } from './items/Item'
import { UsageBar } from './items/UsageBar'
import { WorkingRow } from './items/WorkingRow'
import { Composer } from './Composer'
import { isSending, useFollowUpQueue } from './follow-up-queue'

/** Process-local counter for unique echoed-prompt ids. */
let promptSeq = 0

/** Vibe's app code for "this model can't ingest images" (acp-capture §11, #100). */
const IMAGES_UNSUPPORTED_CODE = -31008

/**
 * The live handle for one Thread hosted on a Workspace agent (TB5). `sessionId`
 * is the bound ACP session, or `null` for a draft whose `session/new` is deferred
 * to its first prompt. Several of these can share one `agentId` (one `vibe-acp`
 * hosting many sessions); switching mounts the selected one (keyed by `threadId`).
 */
export interface LiveThread {
  agentId: string
  threadId: string
  workspaceId: string
  sessionId: string | null
  title: string | null
}

/**
 * A live Thread: hydrates its saved history from JSONL on mount (TB5), then
 * subscribes to the agent's `acp:event` stream — routing only THIS Thread's
 * session into the reducer (reducer.ts) — and lets the user send prompts. A
 * draft's first prompt binds its session in main (`session/new`), which signals
 * `thread:bound` BEFORE the session streams; the bound `sessionId` is reused
 * thereafter so the session is never re-minted, and the draft NEVER infers its
 * session from an arbitrary event (which could be a sibling's).
 *
 * This view no longer reports its status up: the sidebar's per-Thread streaming /
 * needs-attention indicators are sourced from main's `thread:status` push (#53),
 * which covers ALL live Threads (active or not) — main owns the authoritative turn
 * + permission lifecycle, so it doesn't need a mounted Conversation to observe one.
 *
 * The input surface is the `Composer` child (quality-review slice 4); this container
 * keeps the turn lifecycle (submit / flush / auto-flush) + the transcript render.
 */
export function Conversation({
  thread,
  modes,
  models,
  reasoningEffort,
  onSetConfig,
  onAuthExpired,
  onBound,
}: {
  thread: LiveThread
  /** The connection's current Mode + options (#66) — display-from-session-state. */
  modes: ThreadModes | null
  /** The connection's current Model + options (#66). */
  models: ThreadModels | null
  /** The connection's current Reasoning effort + options (#66). */
  reasoningEffort: ThreadReasoningEffort | null
  /** Change an agent control (#66): App reflects it optimistically + reverts on error.
   *  Carries the Thread's `sessionId` — non-null once bound (App fires the IPC), or
   *  null for a pre-prompt draft (#75: App caches the pre-pick, applied on bind). */
  onSetConfig?: (axis: ThreadConfigAxis, value: string, sessionId: string | null) => void
  /** Mid-session expiry (-32000): route to in-place re-auth with these methods. */
  onAuthExpired: (authMethods: AuthMethod[]) => void
  /** The Thread's session once bound (TB5) — lifts it so a switch-away-and-back
   *  re-seeds the bound session instead of re-minting it. Carries the session's
   *  agent-controls (#70) from `thread:bound` so App seeds THIS Thread's picker;
   *  null on the `sendPrompt`-result path (the result carries no controls — the
   *  `thread:bound` that fired ahead of the stream already delivered them). */
  onBound?: (sessionId: string, controls: ThreadAgentControls | null) => void
}): JSX.Element {
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState)
  // The session this Thread is bound to — null until a draft's first prompt binds
  // it (via main's `thread:bound`). Seeded from the record; mirrored into a ref so
  // the event subscription reads the LATEST value without re-subscribing (a stale
  // closure would drop the draft's own first events after binding).
  const [boundSessionId, setBoundSessionId] = useState<string | null>(thread.sessionId)
  const boundRef = useRef<string | null>(thread.sessionId)
  // Keep the lift callback in a ref so the bound subscription needn't depend on it.
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound
  // True once any live event has been folded in: guards the async hydrate from
  // clobbering events that streamed in before the JSONL read resolved.
  const liveSeen = useRef(false)
  // True once this view holds real history (a cache hit, a resolved transcript
  // read — even an empty one — or a live event): the unmount snapshot below may
  // only cache a HYDRATED view, else an instant switch-away before the read
  // resolved would cache an empty state and replay a non-empty Thread as empty.
  const hydratedRef = useRef(false)
  // Mirror of the reducer state for the unmount snapshot (an unmount cleanup
  // closes over the FIRST render's `state` otherwise). Fresh per key-remount.
  const stateRef = useRef(state)
  stateRef.current = state

  // The follow-up queue for THIS Thread (#105, ADR-0009): submitting while a turn
  // streams enqueues here (the queue lives in a module store ABOVE this remount, so
  // it survives a Thread switch), and every turn-end auto-flushes one message.
  const followUps = useFollowUpQueue(thread.threadId)

  // Hydrate this Thread's saved history from JSONL once (TB5): switching INTO a
  // previously-used Thread shows its conversation before live events resume. A
  // draft (or a fresh Thread) has none, so this is a no-op there.
  //
  // Deferred (NIT): if the Thread's PRIOR turn was still in-flight when we last
  // left it, its JSONL may lag the live tail by a few un-flushed events; the
  // `liveSeen` guard keeps a late hydrate from clobbering resumed live events, but
  // the brief early-history gap on such a reopen is accepted for this slice.
  useEffect(() => {
    // Cache first (take = consume — the mounted view owns the state from here):
    // a switch-back within the LRU window hydrates instantly, no IPC, no re-fold.
    const cached = replayCache.take(thread.threadId)
    if (cached) {
      hydratedRef.current = true
      // Sync the snapshot mirror NOW, not at the re-render: an unmount landing
      // between this dispatch and its render (StrictMode's dev double-mount
      // does exactly that) would otherwise snapshot the still-initial state and
      // poison the cache with an empty view for this Thread.
      stateRef.current = cached.state
      dispatch({ type: 'hydrate', state: cached.state })
      return
    }
    let active = true
    void window.api.readTranscript(thread.threadId).then(async (entries) => {
      // Resolve persisted image attachments (one batched IPC) ONLY when the
      // transcript references any — an image-less reopen costs nothing extra.
      const attachments = transcriptHasImages(entries)
        ? await window.api.readThreadAttachments(thread.threadId)
        : undefined
      if (!active || liveSeen.current) return
      // Hydrated even when the transcript is EMPTY — a legitimately empty
      // Thread may cache as empty; only an unresolved read must not.
      hydratedRef.current = true
      const replayed = replayTranscript(entries, attachments)
      if (replayed.items.length > 0) {
        stateRef.current = replayed // pre-render sync, same poison guard as above
        dispatch({ type: 'hydrate', state: replayed })
      }
    })
    return () => {
      active = false
    }
  }, [thread.threadId])

  // Unmount snapshot: give the folded view back to the cache so the next mount
  // of THIS Thread skips the JSONL re-read + re-fold. `put` refuses a mid-turn
  // (`isProcessing`) state — a turn outliving the unmount keeps teeing to the
  // transcript, so that snapshot would go stale (the next mount replays fully).
  useEffect(() => {
    return () => {
      if (hydratedRef.current || liveSeen.current) {
        replayCache.put(thread.threadId, {
          state: stateRef.current,
          sessionId: boundRef.current,
          workspaceId: thread.workspaceId,
        })
      }
    }
  }, [thread.threadId, thread.workspaceId])

  // Bind a draft to its OWN session the instant main signals `thread:bound` —
  // BEFORE that session's first event arrives (main emits it ahead of the prompt
  // stream). We never adopt a session from an incoming event, so a sibling's
  // still-streaming turn can't be spliced into this draft. Also lifts the session
  // so a switch-away-and-back re-seeds it instead of re-minting.
  useEffect(() => {
    return window.api.onThreadBound((e) => {
      if (e.threadId !== thread.threadId) return
      boundRef.current = e.sessionId
      setBoundSessionId(e.sessionId)
      onBoundRef.current?.(e.sessionId, e.controls)
      // A re-bind (TB4 #33): the agent couldn't resume this reopened Thread, so
      // main minted a fresh session. Weave the honest "context reset" notice in
      // NOW — main emits `thread:bound` before the prompt streams, so it lands
      // after the user's prompt and before the agent's response (matching replay).
      if (e.rebound) dispatch({ type: 'agent-rebound' })
    })
  }, [thread.threadId])

  // Subscribe to this agent's events; route ONLY this Thread's session to the
  // reducer (one agent hosts many sessions, TB5). Reads `boundRef` live so an
  // UNBOUND draft rejects every session-tagged event (no sibling adoption), and a
  // bound Thread takes only its own — without re-subscribing on each binding.
  useEffect(() => {
    return window.api.onAcpEvent((event) => {
      if (event.agentId !== thread.agentId) return
      if (!eventBelongsToThread(event.payload, boundRef.current)) return
      liveSeen.current = true
      dispatch({ type: 'acp-event', payload: event.payload })
    })
  }, [thread.agentId])

  // The actual send of ONE message as a fresh `session/prompt` (#105). Owns the
  // whole turn lifecycle — echo dispatch, IPC, result handling, and (in `finally`)
  // `turn-complete` THEN a drain of the next queued message. It NEVER touches
  // composer state (draft/pendingImages) — clearing is the Composer's job — so it can
  // send a queued message that has no relation to the current composer contents.
  // The module-level `sending` latch (via `followUps.beginSend`/`endSend`) is held for
  // the whole call so NO second turn can start for this Thread — across component
  // instances — while this one is open (a concurrent `session/prompt` would -32602).
  async function submitPrompt(
    text: string,
    images: Array<{ data: string; mimeType: string; previewUrl: string }>,
  ): Promise<boolean> {
    followUps.beginSend()
    dispatch({
      type: 'send-prompt',
      id: `user:${promptSeq++}`,
      text,
      images: images.map(({ previewUrl }) => ({ previewUrl })),
    })
    let ok = false
    try {
      const result = await window.api.sendPrompt({
        agentId: thread.agentId,
        threadId: thread.threadId,
        workspaceId: thread.workspaceId,
        sessionId: boundRef.current,
        text,
        images: images.map(({ data, mimeType }) => ({ data, mimeType })),
      })
      if (result.ok) {
        ok = true
        // Reuse the now-bound session on the next prompt (no second session/new),
        // and lift it so a switch-away-and-back doesn't re-mint. `thread:bound`
        // already set this for a fresh draft; this also covers the no-store path.
        boundRef.current = result.sessionId
        setBoundSessionId(result.sessionId)
        // The result carries no controls — `thread:bound` (emitted ahead of the
        // stream) already delivered them for a fresh mint/resume; pass null here.
        onBound?.(result.sessionId, null)
      } else if (result.kind === 'not-signed-in') {
        // Mid-session expiry: route to in-place re-auth (the agent stays alive).
        onAuthExpired(result.authMethods)
      } else {
        // Surface a failed turn as a conversation item rather than dropping it.
        // -31008 (images-unsupported, acp-capture §11) gets an actionable hint —
        // the staged images are kept above, so switching model + resend just works.
        const message =
          result.code === IMAGES_UNSUPPORTED_CODE
            ? "This model can't see images. Switch to a vision-capable model (e.g. mistral-medium-3.5) and resend."
            : result.error
        dispatch({ type: 'turn-error', message })
      }
    } finally {
      // The turn's stopReason resolves sendPrompt; flip back to the user's turn and
      // release the module `sending` latch. Releasing it NOTIFIES, which re-fires the
      // flush effect below on the CURRENTLY-mounted instance — so it drains the next
      // queued follow-up (even if THIS instance has since unmounted). We do NOT drain
      // here directly: a dead instance must not send (its echo would go to a dead
      // reducer). Flush happens on EVERY turn end — natural OR cancelled (ADR-0009).
      dispatch({ type: 'turn-complete' })
      followUps.endSend()
    }
    return ok
  }

  // Drain exactly ONE queued follow-up as a fresh turn. Gated on the LIVE module latch
  // `isSending(threadId)` (not a per-instance ref / the lagging reducer snapshot), so it
  // NEVER starts a turn while one is already open for this Thread — the strict-
  // serialization guarantee (vibe-acp -32602) that holds ACROSS the remount, and the
  // strict-mode double-invoke guard (`beginSend` sets the latch synchronously, so a
  // second call bails).
  function flushNext(): void {
    if (isSending(thread.threadId)) return
    const head = followUps.dequeueHead()
    if (head) void submitPrompt(head.text, head.images)
  }

  // The SOLE auto-flush trigger (#105): re-run whenever this Thread's `sending` latch
  // or queue changes. `flushNext` self-gates on the live `isSending` latch, so it fires
  // exactly when a turn ends (latch clears) or the queue gains its first item while idle,
  // and bails while a turn is open. Because effects run ONLY on the mounted instance, a
  // turn started by a since-unmounted instance is drained here by the currently-mounted
  // one (correct reducer/echo) — and a remount with a pre-existing queue flushes on its
  // first run. This replaces the per-instance ref + one-shot mount effect that couldn't
  // serialize across the remount (the -32602 hazard).
  useEffect(() => {
    flushNext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUps.sending, followUps.queued])

  // Reveal a file behind a clickable file-path chip (#116) in the OS file manager.
  // Provided to the deeply-nested FileChip via context so we don't prop-drill through
  // Response/Streamdown. Fire-and-forget: main resolves the (possibly relative) path
  // against THIS Thread's Workspace cwd, confines it, and reveals it (never opens/
  // executes — the chip text is untrusted agent output). Memoized on agentId so a
  // keystroke-driven re-render doesn't re-render every chip under the provider.
  const openFile = useCallback(
    (link: FileLink): void => {
      void window.api.revealPath({ agentId: thread.agentId, path: link.path })
    },
    [thread.agentId],
  )

  // Answer a pending permission request: relay the choice to the agent and mark
  // the prompt resolved so it stops asking (state stays renderer-owned).
  function respondPermission(item: PermissionItem, option: PermissionOption): void {
    void window.api.respondPermission({
      agentId: thread.agentId,
      threadId: thread.threadId,
      requestId: item.requestId,
      optionId: option.optionId,
    })
    dispatch({
      type: 'resolve-permission',
      requestId: item.requestId,
      optionId: option.optionId,
      name: option.name,
    })
  }

  // Escape hatch for a wedged turn: deny any still-pending permission (so the
  // agent stops blocking and `session/prompt` can resolve) before re-enabling
  // input. Reducer is pure, so the IPC reply happens here, not in `recover`.
  function recover(): void {
    for (const item of state.items) {
      if (item.kind !== 'permission' || item.chosenOptionId !== null) continue
      const deny = item.options.find(isRejectOption) ?? item.options[item.options.length - 1]
      if (!deny) continue
      void window.api.respondPermission({
        agentId: thread.agentId,
        threadId: thread.threadId,
        requestId: item.requestId,
        optionId: deny.optionId,
      })
      dispatch({
        type: 'resolve-permission',
        requestId: item.requestId,
        optionId: deny.optionId,
        name: deny.name,
      })
    }
    dispatch({ type: 'recover' })
  }

  const title = state.title ?? thread.title ?? 'Untitled Thread'
  // The current turn is everything AFTER the last user message; used to scope
  // reasoning auto-open to the live turn only (#115 review S1).
  const lastUserIndex = state.items.map((i) => i.kind).lastIndexOf('user')

  return (
    // Chip clicks (#116) open files through main; provided here (agentId closed over)
    // for the FileChips streamdown renders far below in the assistant markdown.
    <FileOpenProvider value={openFile}>
      <div className="conv">
        <div className="conv__head">
          <span className="dot dot--ok" aria-hidden />
          <span className="conv__title">{title}</span>
          <span className="badge">connected</span>
        </div>

        <UsageBar state={state} />

        <MessageScroller>
          {state.items.length === 0 && (
            <p className="hint">Send a prompt to start the conversation.</p>
          )}
          {state.items.map((item, idx) => (
            <Item
              key={item.id}
              item={item}
              // Auto-open reasoning only for the CURRENT turn — items AFTER the last
              // user message — so sending a new prompt doesn't re-expand the whole
              // history's "Thinking" blocks (they belong to prior, settled turns).
              streaming={state.isProcessing && idx > lastUserIndex}
              onPermission={respondPermission}
            />
          ))}
          {/* Working indicator (#115): while a turn is in flight, a self-ticking
              "Working for …" row after the transcript. It mounts when the turn opens
              and unmounts on completion, so its timer starts at turn start. */}
          {state.isProcessing && <WorkingRow />}
        </MessageScroller>

        {state.isProcessing && (
          // Escape hatch: if a turn wedges (e.g. a permission prompt is dismissed
          // and `session/prompt` never resolves), deny any pending permission and
          // re-enable input instead of sticking disabled forever (carry-over #4).
          <button className="recover" onClick={recover}>
            Turn stuck? End it and re-enable input ▶
          </button>
        )}

        <Composer
          threadId={thread.threadId}
          agentId={thread.agentId}
          boundSessionId={boundSessionId}
          isProcessing={state.isProcessing}
          isEmpty={state.items.length === 0}
          availableCommands={state.availableCommands}
          followUps={followUps}
          submitPrompt={submitPrompt}
          modes={modes}
          models={models}
          reasoningEffort={reasoningEffort}
          onSetConfig={onSetConfig}
        />
      </div>
    </FileOpenProvider>
  )
}
