import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react'
import type {
  AuthMethod,
  ThreadAgentControls,
  ThreadConfigAxis,
  ThreadModes,
  ThreadModels,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { AgentControls } from './AgentControls'
import {
  conversationReducer,
  initialConversationState,
  type AcpCommand,
  type AssistantItem,
  type ConversationItem,
  type ErrorItem,
  type FallbackItem,
  type NoticeItem,
  type PermissionItem,
  type PermissionOption,
  type ReasoningItem,
  type ToolItem,
  type UserItem,
} from './reducer'
import { eventBelongsToThread } from './event-routing'
import { replayTranscript } from './replay'
import { ChatMarkdown } from './ChatMarkdown'
import { getDraft, setDraft as persistDraft, clearDraft } from './composer-draft-store'
import {
  applyCommand,
  filterCommands,
  getCommandQuery,
  moveSelection,
} from './command-autocomplete'
import { ACCEPTED_IMAGE_TYPES, isAcceptedImageType, parseDataUrl } from './image-attach'
import { isSending, nextQueueId, useFollowUpQueue } from './follow-up-queue'

/** Process-local counter for unique echoed-prompt ids. */
let promptSeq = 0

/** Process-local counter for unique pending-image ids (not Math.random/Date). */
let imageSeq = 0

/** The picker's `accept` list — the accepted image mime types, comma-joined. */
const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',')

/** Vibe's app code for "this model can't ingest images" (acp-capture §11, #100). */
const IMAGES_UNSUPPORTED_CODE = -31008

/**
 * An image staged in the composer before send (#100). `data` is BARE base64 (sent
 * to the agent); `previewUrl` is the full data URL (thumbnail + echoed user turn).
 */
interface PendingImage {
  id: string
  data: string
  mimeType: string
  name: string
  previewUrl: string
}

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
  // The composer's unsent text, persisted per-Thread to localStorage (#60) so it
  // survives any unmount (cold↔live, agent eviction/re-warm, app restart, switching
  // to a cold Thread). This view is keyed by `thread.threadId` in the outlet, so it
  // REMOUNTS on a Thread switch — the lazy initializer seeds THAT Thread's stored
  // draft fresh, with no stale carry-over (no re-seed effect needed). Reading here
  // must not write, so we only persist on change/send below.
  const [draft, setDraft] = useState(() => getDraft(window.localStorage, thread.threadId))
  // Images staged in the composer, awaiting send (#100). Renderer-only, ephemeral:
  // this view remounts on a Thread switch (keyed by threadId), so the strip starts
  // empty per Thread. Kept on a failed send so the user can retry / switch model.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  // The session this Thread is bound to — null until a draft's first prompt binds
  // it (via main's `thread:bound`). Seeded from the record; mirrored into a ref so
  // the event subscription reads the LATEST value without re-subscribing (a stale
  // closure would drop the draft's own first events after binding).
  const [boundSessionId, setBoundSessionId] = useState<string | null>(thread.sessionId)
  const boundRef = useRef<string | null>(thread.sessionId)
  // Keep the lift callback in a ref so the bound subscription needn't depend on it.
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The hidden file picker behind the 📎 button (#100).
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Ephemeral `/` slash-command autocomplete state (#95): the open trigger (the
  // `/`'s index + the query after it) and the highlighted row. Purely renderer-local
  // — no IPC, no persistence — so a Thread switch (which remounts this view, keyed by
  // threadId) always starts with the popover closed. `null` = closed.
  const [commandTrigger, setCommandTrigger] = useState<{ start: number; query: string } | null>(
    null,
  )
  const [commandIndex, setCommandIndex] = useState(0)
  // The highlighted popover row, so ↑/↓ can keep the selection scrolled into the
  // overflow window (#95).
  const activeRowRef = useRef<HTMLLIElement>(null)
  // Esc-dismiss latch (#95): the `/`-token start the user dismissed. While it holds,
  // re-deriving the SAME token keeps the popover closed — so Esc stays dismissed as
  // you keep typing (the escape hatch for sending literal `/text`). Cleared once the
  // token closes/deletes or a different `/` opens, so a fresh trigger reopens.
  const dismissedStartRef = useRef<number | null>(null)
  // True once any live event has been folded in: guards the async hydrate from
  // clobbering events that streamed in before the JSONL read resolved.
  const liveSeen = useRef(false)

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
    let active = true
    void window.api.readTranscript(thread.threadId).then((entries) => {
      if (!active || liveSeen.current) return
      const replayed = replayTranscript(entries)
      if (replayed.items.length > 0) dispatch({ type: 'hydrate', state: replayed })
    })
    return () => {
      active = false
    }
  }, [thread.threadId])

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

  // Keep the latest item in view as the answer streams in.
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [state.items])

  // Read a pasted/picked image blob to a data URL (DOM: FileReader lives here, not
  // in the pure module), split it into bare base64 + mime via `parseDataUrl`, and
  // stage it. Non-accepted types are skipped up front so we don't read junk.
  function addFile(file: File | Blob, name: string): void {
    if (!isAcceptedImageType(file.type)) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) return
      setPendingImages((prev) => [
        ...prev,
        { id: `img:${imageSeq++}`, data: parsed.data, mimeType: parsed.mimeType, name, previewUrl: dataUrl },
      ])
    }
    reader.readAsDataURL(file)
  }

  // Clipboard paste (#100): stage any pasted image files. `preventDefault` fires
  // ONLY when at least one image was handled, so a normal text paste is untouched.
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void {
    let handled = false
    for (const item of e.clipboardData.items) {
      if (item.kind !== 'file' || !isAcceptedImageType(item.type)) continue
      const file = item.getAsFile()
      if (!file) continue
      addFile(file, file.name || 'pasted-image')
      handled = true
    }
    if (handled) e.preventDefault()
  }

  // File picker (#100): stage each selected image, then reset the input value so
  // re-picking the SAME file fires `change` again.
  function onPickFiles(e: ChangeEvent<HTMLInputElement>): void {
    const files = e.target.files
    if (files) for (const file of files) addFile(file, file.name)
    e.target.value = ''
  }

  function removeImage(id: string): void {
    setPendingImages((prev) => prev.filter((img) => img.id !== id))
  }

  // The actual send of ONE message as a fresh `session/prompt` (#105). Owns the
  // whole turn lifecycle — echo dispatch, IPC, result handling, and (in `finally`)
  // `turn-complete` THEN a drain of the next queued message. It NEVER touches
  // composer state (draft/pendingImages) — clearing is the caller's job — so it can
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

  // Composer submit (Enter or the Send/Queue button). When a turn is streaming we
  // ENQUEUE the composer payload and clear the composer (it flushes on the next turn
  // end); when idle we send immediately, preserving #100's clear-on-success /
  // keep-on-failure UX (a failed send keeps the text + staged images for retry).
  async function send(): Promise<void> {
    const text = draft.trim()
    const hasContent = text.length > 0 || pendingImages.length > 0
    if (!hasContent) return
    const images = pendingImages.map(({ data, mimeType, previewUrl }) => ({
      data,
      mimeType,
      previewUrl,
    }))
    if (followUps.sending) {
      // A turn is live for this Thread (authoritative module latch, not the per-
      // instance reducer snapshot which lags on a remount) — queue it (protocol forbids
      // a concurrent prompt) and clear the composer so the user can compose the next
      // follow-up. It auto-flushes on the next turn end.
      followUps.enqueue({ id: nextQueueId(), text, images })
      setDraft('')
      clearDraft(window.localStorage, thread.threadId)
      setPendingImages([])
      return
    }
    // Idle: send now. `submitPrompt` echoes text/images by value up front, so we can
    // clear the composer AFTER, but only on a successful outcome — preserving #100's
    // clear-on-success / keep-on-failure (a failed send keeps text + staged images
    // for retry, e.g. switching to a vision model).
    const ok = await submitPrompt(text, images)
    if (ok) {
      setPendingImages([])
      setDraft('')
      clearDraft(window.localStorage, thread.threadId)
    }
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
      const deny =
        item.options.find((o) => o.kind.startsWith('reject')) ?? item.options[item.options.length - 1]
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

  // The `/` autocomplete's live matches (#95): folded from the Vibe-streamed
  // `availableCommands`, filtered prefix-then-substring by the open query. The
  // popover shows only with an active trigger AND at least one match; `commandRows`
  // is empty otherwise so the keyboard handlers are inert. `activeIndex` clamps the
  // stored highlight in case the match count shrank as the query grew.
  const commandRows: AcpCommand[] = commandTrigger
    ? filterCommands(state.availableCommands, commandTrigger.query)
    : []
  const showCommands = commandTrigger !== null && commandRows.length > 0
  const activeIndex = Math.min(commandIndex, commandRows.length - 1)

  // Keep the highlighted row visible when ↑/↓ walk past the popover's max-height
  // (#95). `block: 'nearest'` scrolls only the overflow list, not the whole page.
  useEffect(() => {
    if (showCommands) activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [showCommands, activeIndex])

  // Re-derive the trigger from the composer's value + caret after any edit or caret
  // move. Reads the live caret so `hello /re` (mid-line) never triggers while `/re`
  // (line start) does. Resetting the highlight to the top on every re-derive is safe:
  // list navigation preventDefaults the caret move, so it never re-runs this.
  function refreshCommandTrigger(value: string, caret: number | null): void {
    const trigger = caret === null ? null : getCommandQuery(value, caret)
    if (!trigger || !trigger.active) {
      // Token gone — drop any dismissal so a later `/` reopens fresh.
      dismissedStartRef.current = null
      setCommandTrigger(null)
      setCommandIndex(0)
      return
    }
    if (dismissedStartRef.current === trigger.start) {
      // Still the Esc-dismissed token — stay closed as the query grows.
      setCommandTrigger(null)
      return
    }
    dismissedStartRef.current = null
    setCommandTrigger({ start: trigger.start, query: trigger.query })
    setCommandIndex(0)
  }

  // Accept a completion: splice `/<name> ` in over the `/query` token, keep the
  // draft + persisted draft (#60) in lockstep, then restore focus and drop the caret
  // just past the inserted space. The DOM caret is set after commit (rAF) so React's
  // controlled value doesn't stomp it; the resulting `onSelect` closes the popover.
  function acceptCommand(command: AcpCommand): void {
    if (!commandTrigger) return
    const node = inputRef.current
    const caret = node ? node.selectionStart : draft.length
    const next = applyCommand(draft, commandTrigger.start, caret, command.name)
    setDraft(next.value)
    persistDraft(window.localStorage, thread.threadId, next.value)
    setCommandTrigger(null)
    setCommandIndex(0)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // Popover-open key interception (#95): navigation + accept must win over Enter's
    // send and Tab's focus move. When closed, every key falls through unchanged.
    if (showCommands) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex(moveSelection(activeIndex, commandRows.length, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex(moveSelection(activeIndex, commandRows.length, -1))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        acceptCommand(commandRows[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // Latch this token as dismissed so typing more doesn't reopen it (#95).
        dismissedStartRef.current = commandTrigger?.start ?? null
        setCommandTrigger(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const title = state.title ?? thread.title ?? 'Untitled Thread'

  return (
    <div className="conv">
      <div className="conv__head">
        <span className="dot dot--ok" aria-hidden />
        <span className="conv__title">{title}</span>
        <span className="badge">{state.isProcessing ? 'thinking…' : 'connected'}</span>
      </div>

      <UsageBar state={state} />

      <div className="messages" ref={listRef}>
        {state.items.length === 0 && (
          <p className="hint">Send a prompt to start the conversation.</p>
        )}
        {state.items.map((item) => (
          <Item key={item.id} item={item} onPermission={respondPermission} />
        ))}
      </div>

      {state.isProcessing && (
        // Escape hatch: if a turn wedges (e.g. a permission prompt is dismissed
        // and `session/prompt` never resolves), deny any pending permission and
        // re-enable input instead of sticking disabled forever (carry-over #4).
        <button className="recover" onClick={recover}>
          Turn stuck? End it and re-enable input ▶
        </button>
      )}

      <div className="composer-area">
        {/* Agent controls (#66): Mode / Model / Reasoning effort. Vibe-owned,
            between-turns only — disabled WHILE a turn streams. A pre-prompt draft
            (#75) is NOT processing, so its pickers are live: a pick passes the null
            `boundSessionId` up, and App caches it (no IPC — no session yet) to apply
            on the first bind. A bound Thread passes its real session for the IPC. */}
        <AgentControls
          modes={modes}
          models={models}
          reasoningEffort={reasoningEffort}
          disabled={state.isProcessing}
          onSetConfig={(axis, value) => onSetConfig?.(axis, value, boundSessionId)}
        />

        {followUps.queued.length > 0 && (
          // Queued follow-ups (#105, ADR-0009): messages submitted while a turn
          // streams, auto-flushed one per turn end. Each row shows its text (or a
          // `📎 N image(s)` label when text-empty; a `📎 N` marker when it has both)
          // and a ✕ to drop it. Edit-in-place is deferred.
          <div className="composer-queue">
            {followUps.queued.map((m) => (
              <div key={m.id} className="queued">
                <span className="queued__text">
                  {m.text ? m.text : `📎 ${m.images.length} image${m.images.length === 1 ? '' : 's'}`}
                  {m.text && m.images.length > 0 && (
                    <span className="queued__marker"> 📎 {m.images.length}</span>
                  )}
                </span>
                <button
                  className="queued__remove"
                  aria-label="Remove queued message"
                  onClick={() => followUps.remove(m.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {pendingImages.length > 0 && (
          // Staged-image strip (#100): thumbnails with a ✕ remove, above the composer.
          <div className="composer-attachments">
            {pendingImages.map((img) => (
              <div key={img.id} className="attachment">
                <img className="attachment__thumb" src={img.previewUrl} alt={img.name} />
                <button
                  className="attachment__remove"
                  aria-label={`Remove ${img.name}`}
                  onClick={() => removeImage(img.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="composer">
          {showCommands && (
            <ul className="command-autocomplete" role="listbox" aria-label="Slash commands">
              {commandRows.map((command, i) => (
                <li
                  key={command.name}
                  ref={i === activeIndex ? activeRowRef : null}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={
                    i === activeIndex
                      ? 'command-autocomplete__row command-autocomplete__row--active'
                      : 'command-autocomplete__row'
                  }
                  // mousedown (not click) so we accept BEFORE the textarea blurs.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    acceptCommand(command)
                  }}
                >
                  <span className="command-autocomplete__name">/{command.name}</span>
                  {command.description && (
                    <span className="command-autocomplete__desc">{command.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={inputRef}
            className="composer__input"
            placeholder="Ask Vibe… (Enter to send, Shift+Enter for a newline)"
            value={draft}
            onChange={(e) => {
              // Write-through: keep React state and the persisted draft (#60) in lockstep.
              setDraft(e.target.value)
              persistDraft(window.localStorage, thread.threadId, e.target.value)
              // Re-derive the `/` autocomplete trigger from the new value + caret (#95).
              refreshCommandTrigger(e.target.value, e.target.selectionStart)
            }}
            // Caret moves (arrows/click) with no edit also open/close the trigger (#95).
            onSelect={(e) =>
              refreshCommandTrigger(e.currentTarget.value, e.currentTarget.selectionStart)
            }
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
          />
          <input
            ref={fileInputRef}
            type="file"
            className="composer__file-input"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={onPickFiles}
          />
          <button
            className="btn btn--ghost composer__attach"
            aria-label="Attach images"
            title="Attach images"
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </button>
          {state.isProcessing && boundSessionId && (
            // Interrupt the active turn (#103, ADR-0009): fire `session/cancel`. The
            // turn then resolves `cancelled`, which the existing turn-complete path
            // flips `isProcessing` off on — no new local state needed here. Gated on
            // `boundSessionId` so it only shows once there's a turn it can cancel (a
            // draft's first prompt is pre-bind for its session/new round-trip).
            <button
              className="btn btn--stop"
              onClick={() =>
                void window.api.cancelTurn({ agentId: thread.agentId, sessionId: boundSessionId })
              }
            >
              ⏹ Stop
            </button>
          )}
          <button
            className="btn"
            onClick={() => void send()}
            disabled={draft.trim().length === 0 && pendingImages.length === 0}
          >
            {followUps.sending ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function UsageBar({ state }: { state: { usage: { used: number; size: number } | null; cost: { amount: number; currency: string } | null } }): JSX.Element | null {
  if (!state.usage && !state.cost) return null
  return (
    <div className="usage">
      {state.usage && (
        <span className="usage__item">
          context <strong>{state.usage.used.toLocaleString()}</strong> /{' '}
          {state.usage.size.toLocaleString()} tokens
        </span>
      )}
      {state.cost && (
        <span className="usage__item">
          cost <strong>{formatCost(state.cost.amount, state.cost.currency)}</strong>
        </span>
      )}
    </div>
  )
}

export function Item({
  item,
  onPermission,
}: {
  item: ConversationItem
  onPermission: (item: PermissionItem, option: PermissionOption) => void
}): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} />
    case 'reasoning':
      return <ReasoningRow item={item} />
    case 'assistant':
      return <AssistantRow item={item} />
    case 'tool':
      return <ToolRow item={item} />
    case 'permission':
      return <PermissionRow item={item} onPermission={onPermission} />
    case 'error':
      return <ErrorRow item={item} />
    case 'fallback':
      return <FallbackRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
  }
}

function UserRow({ item }: { item: UserItem }): JSX.Element {
  return (
    <div className="msg msg--user">
      <div className="msg__role">You</div>
      {item.images && item.images.length > 0 && (
        // Echo the sent attachments in the user bubble (#100).
        <div className="msg__images">
          {item.images.map((img, i) => (
            <img key={i} className="msg__image" src={img.previewUrl} alt="attachment" />
          ))}
        </div>
      )}
      {item.text && <div className="msg__body">{item.text}</div>}
    </div>
  )
}

function AssistantRow({ item }: { item: AssistantItem }): JSX.Element {
  return (
    <div className="msg msg--assistant">
      <div className="msg__role">Vibe</div>
      <ChatMarkdown className="msg__body" text={item.text} />
    </div>
  )
}

function ReasoningRow({ item }: { item: ReasoningItem }): JSX.Element {
  return (
    <details className="reasoning" open>
      <summary className="reasoning__summary">Reasoning</summary>
      <ChatMarkdown className="reasoning__body" text={item.text} />
    </details>
  )
}

function ToolRow({ item }: { item: ToolItem }): JSX.Element {
  const done = item.status === 'completed'
  const label = item.title ?? item.toolKind ?? 'tool'
  const path = item.locations.find((l) => l.path)?.path
  return (
    <div className="tool">
      <div className="tool__head">
        <span className={done ? 'dot dot--ok' : 'dot dot--pending'} aria-hidden />
        <span className="tool__name">{label}</span>
        <span className="tool__status">{item.status}</span>
      </div>
      {path && <div className="tool__path mono">{path}</div>}
    </div>
  )
}

function PermissionRow({
  item,
  onPermission,
}: {
  item: PermissionItem
  onPermission: (item: PermissionItem, option: PermissionOption) => void
}): JSX.Element {
  return (
    <div className="permission">
      <div className="permission__title">
        Permission request{item.toolCallId ? ` · ${item.toolCallId}` : ''}
      </div>
      {item.chosenName ? (
        <div className="permission__chosen">You chose: {item.chosenName}</div>
      ) : (
        <div className="permission__options">
          {item.options.map((option) => (
            <button
              key={option.optionId}
              className={option.kind.startsWith('reject') ? 'btn btn--ghost' : 'btn'}
              onClick={() => onPermission(item, option)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ErrorRow({ item }: { item: ErrorItem }): JSX.Element {
  return (
    <div className="alert">
      <div className="alert__title">Turn ended</div>
      <div className="alert__message">{item.message}</div>
    </div>
  )
}

function NoticeRow({ item }: { item: NoticeItem }): JSX.Element {
  return (
    <div className="notice">
      <span className="notice__icon" aria-hidden>
        ↻
      </span>
      <span className="notice__message">{item.message}</span>
    </div>
  )
}

function FallbackRow({ item }: { item: FallbackItem }): JSX.Element {
  return (
    <details className="fallback">
      <summary className="fallback__summary">{item.sessionUpdate}</summary>
      <pre className="fallback__body mono">{JSON.stringify(item.raw, null, 2)}</pre>
    </details>
  )
}

function formatCost(amount: number, currency: string): string {
  const symbol = currency.toUpperCase() === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(4)}`
}
