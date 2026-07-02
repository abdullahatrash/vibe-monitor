import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type JSX,
  type KeyboardEvent,
} from 'react'
import { ArrowUp, Mic, Plus, Square, X } from 'lucide-react'
import type {
  FileEntry,
  ThreadConfigAxis,
  ThreadModels,
  ThreadModes,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { AgentControls } from './AgentControls'
import { Card } from '../ui/card'
import { IconButton } from '../ui/icon-button'
import { Textarea } from '../ui/textarea'
import type { AcpCommand } from './reducer'
import { getDraft, setDraft as persistDraft, clearDraft } from './composer-draft-store'
import { appendMention, subscribeComposerInsert } from './composer-insert'
import { ACCEPTED_IMAGE_TYPES, isAcceptedImageType, parseDataUrl } from './image-attach'
import { nextQueueId, type FollowUpQueue } from './follow-up-queue'
import { useComposerAutocomplete, CompletionPopover } from './use-composer-autocomplete'
import { createCommandSource, createPathSource } from './composer-sources'

/** Process-local counter for unique pending-image ids (not Math.random/Date). */
let imageSeq = 0

/** The picker's `accept` list — the accepted image mime types, comma-joined. */
const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',')

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
 * The composer: the Thread's input surface (quality-review slice 4 split from Conversation).
 * Owns its own renderer-only state — the per-Thread persisted draft (#60), the staged images
 * awaiting send (#100), and the unified `/`+`@` autocomplete (#95/#190) — plus the queued
 * follow-up strip (#105). It hands a composed message UP to the container via `submitPrompt`
 * (idle send) or `followUps.enqueue` (while a turn streams); the container owns the turn
 * lifecycle and drains the queue. Keyed by `threadId` through its parent's remount, so all of
 * this state seeds fresh per Thread.
 */
export function Composer({
  threadId,
  agentId,
  boundSessionId,
  isProcessing,
  isEmpty,
  availableCommands,
  followUps,
  submitPrompt,
  modes,
  models,
  reasoningEffort,
  onSetConfig,
}: {
  threadId: string
  agentId: string
  /** The Thread's bound session, or null for a pre-prompt draft (#75). */
  boundSessionId: string | null
  /** A turn is streaming for this Thread (#115): disables controls, shows Stop. */
  isProcessing: boolean
  /** No conversation yet — drives the placeholder copy. */
  isEmpty: boolean
  /** The Vibe-streamed slash commands for the `/` autocomplete (#95). */
  availableCommands: AcpCommand[]
  /** This Thread's follow-up queue (#105) — send-vs-queue, the queued strip, drain. */
  followUps: FollowUpQueue
  /** Send ONE message as a fresh turn (owned by the container). Resolves ok/failed. */
  submitPrompt: (
    text: string,
    images: Array<{ data: string; mimeType: string; previewUrl: string }>,
  ) => Promise<boolean>
  /** Agent controls (#66): display-from-session-state. */
  modes: ThreadModes | null
  models: ThreadModels | null
  reasoningEffort: ThreadReasoningEffort | null
  onSetConfig?: (axis: ThreadConfigAxis, value: string, sessionId: string | null) => void
}): JSX.Element {
  // The composer's unsent text, persisted per-Thread to localStorage (#60) so it
  // survives any unmount (cold↔live, agent eviction/re-warm, app restart, switching
  // to a cold Thread). This view is keyed by `threadId` through its parent, so it
  // REMOUNTS on a Thread switch — the lazy initializer seeds THAT Thread's stored
  // draft fresh, with no stale carry-over (no re-seed effect needed). Reading here
  // must not write, so we only persist on change/send below.
  const [draft, setDraft] = useState(() => getDraft(window.localStorage, threadId))
  // Images staged in the composer, awaiting send (#100). Renderer-only, ephemeral:
  // this view remounts on a Thread switch (keyed by threadId), so the strip starts
  // empty per Thread. Kept on a failed send so the user can retry / switch model.
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // The hidden file picker behind the 📎 button (#100).
  const fileInputRef = useRef<HTMLInputElement>(null)
  // The shared `files:list` listing (ADR-0013 decision 5), fetched ONCE per composer
  // mount on the first `@` (lazy) and cached here — ranking runs in the renderer, so no
  // per-keystroke IPC. `requestedRef` guards the single fetch; a failed/empty listing is
  // tolerated (the popup just shows nothing — a typed `@path` still sends fine, the agent
  // resolves it). Addressed by the connection's `agentId`, like the Files Surface.
  const [pathEntries, setPathEntries] = useState<FileEntry[]>([])
  const pathEntriesRequestedRef = useRef(false)

  // Fetch the shared `files:list` listing ONCE per composer mount, lazily on the first
  // `@` (ADR-0013 decision 5). Serves main's per-Workspace cache (no `refresh`), so it is
  // cheap; a failure is swallowed — the popup just stays empty and a typed `@path` still
  // sends. The resolved entries land in state, which re-renders the open popover with them.
  function ensurePathEntries(): void {
    if (pathEntriesRequestedRef.current) return
    pathEntriesRequestedRef.current = true
    void window.api.filesList({ agentId }).then(
      (result) => setPathEntries(result.entries),
      () => {
        /* tolerate a failed listing — typed paths still send; the agent resolves them */
      },
    )
  }

  // Write-through: keep React state and the persisted draft (#60) in lockstep. The
  // autocomplete hook calls this when it accepts a completion; the textarea's onChange
  // and the composer-insert subscription use it too.
  function writeDraft(next: string): void {
    setDraft(next)
    persistDraft(window.localStorage, threadId, next)
  }

  // The `/` (#95) and `@` (#190) autocompletes, unified into ONE state machine over two
  // priority-ordered sources (command first, so it wins when both tokens overlap).
  const commandSource = useMemo(() => createCommandSource(availableCommands), [availableCommands])
  const pathSource = useMemo(
    () => createPathSource({ entries: pathEntries, onFirstOpen: ensurePathEntries }),
    // ensurePathEntries is stable (refs + agentId); rebuild only when the listing lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathEntries],
  )
  const sources = useMemo(() => [commandSource, pathSource], [commandSource, pathSource])
  const autocomplete = useComposerAutocomplete(sources, draft, writeDraft, inputRef)

  // Insert `@path` from the Files preview's action (#189): the side panel is a sibling of
  // this view, so it reaches the composer through the module-level `composer-insert` channel
  // keyed by threadId. We append to the CURRENT persisted draft (kept in lockstep with
  // `draft` state on every keystroke below), then write state + persisted draft together —
  // the same write-through the textarea's onChange uses. Plain text only: the agent expands
  // `@path` itself (ADR-0002).
  useEffect(() => {
    return subscribeComposerInsert(threadId, (relativePath) => {
      writeDraft(appendMention(getDraft(window.localStorage, threadId), relativePath))
      inputRef.current?.focus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

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
      clearDraft(window.localStorage, threadId)
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
      clearDraft(window.localStorage, threadId)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // The autocomplete intercepts nav/accept/Esc while open; when it doesn't handle the
    // key (closed, or a non-nav key), Enter falls through to send.
    if (autocomplete.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    // @container: the composer adapts to ITS OWN width (container queries), not the
    // viewport's — with the sidebar + side panel open the chat column narrows while
    // the window stays wide, so viewport breakpoints would never fire.
    <div className="mx-auto w-full max-w-[830px] @container">
      {/* shadow-xs: a lighter lift than the Card default — the composer sits over the
          transcript, so the full shadow-sm read as a heavy smudge under it. */}
      <Card className="gap-0 p-0 shadow-xs">
        <div className="flex flex-col px-6 pt-[22px] pb-[14px] @max-[480px]:px-4">
          {followUps.queued.length > 0 && (
            // Queued follow-ups (#105, ADR-0009): messages submitted while a turn
            // streams, auto-flushed one per turn end. Each row shows its text (or a
            // `📎 N image(s)` label when text-empty; a `📎 N` marker when it has both)
            // and a ✕ to drop it. Edit-in-place is deferred.
            <div className="mb-3 flex flex-col gap-1">
              {followUps.queued.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-panel px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                    {m.text
                      ? m.text
                      : `📎 ${m.images.length} image${m.images.length === 1 ? '' : 's'}`}
                    {m.text && m.images.length > 0 && (
                      <span className="text-muted"> 📎 {m.images.length}</span>
                    )}
                  </span>
                  <IconButton
                    size="icon-xs"
                    aria-label="Remove queued message"
                    onClick={() => followUps.remove(m.id)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </div>
              ))}
            </div>
          )}

          {pendingImages.length > 0 && (
            // Staged-image strip (#100): thumbnails with a ✕ remove, above the input.
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingImages.map((img) => (
                <div key={img.id} className="relative size-14">
                  <img
                    className="size-14 rounded-lg border border-border object-cover"
                    src={img.previewUrl}
                    alt={img.name}
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${img.name}`}
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 inline-flex size-[18px] items-center justify-center rounded-full border border-border bg-panel text-text outline-none"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            {autocomplete.open && autocomplete.activeSource && (
              <CompletionPopover
                source={autocomplete.activeSource}
                rows={autocomplete.rows}
                activeIndex={autocomplete.activeIndex}
                activeRowRef={autocomplete.activeRowRef}
                onAccept={autocomplete.accept}
              />
            )}
            <Textarea
              ref={inputRef}
              className="min-h-0 resize-none border-0 bg-transparent p-0 text-[17px] leading-normal focus-visible:border-0"
              placeholder={isEmpty ? 'Ask anything…' : 'Ask for follow-up changes'}
              value={draft}
              onChange={(e) => {
                // Write-through: keep React state and the persisted draft (#60) in lockstep.
                writeDraft(e.target.value)
                // Re-derive the `/` (#95) and `@` (#190) triggers from the new value + caret.
                autocomplete.onInput(e.target.value, e.target.selectionStart)
              }}
              // Caret moves (arrows/click) with no edit also open/close the triggers.
              onSelect={(e) => autocomplete.onInput(e.currentTarget.value, e.currentTarget.selectionStart)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={2}
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={onPickFiles}
          />

          {/* Control row (prototype: 44px gap below the input). Attach + agent
              controls left; mic + interrupt + gradient send right. */}
          {/* min-w-0 lets the AgentControls chips absorb the squeeze (they shrink +
              truncate) so the send button NEVER leaves the card in a narrow column. */}
          <div className="mt-[44px] flex min-w-0 items-center gap-3.5 @max-[560px]:gap-2">
            <IconButton
              size="icon-sm"
              aria-label="Attach images"
              title="Attach images"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-5" aria-hidden />
            </IconButton>

            {/* Agent controls (#66): Mode / Model / Reasoning effort. Vibe-owned,
                between-turns only — disabled WHILE a turn streams. A pre-prompt draft
                (#75) is NOT processing, so its pickers are live: a pick passes the null
                `boundSessionId` up, and App caches it (no IPC — no session yet) to apply
                on the first bind. A bound Thread passes its real session for the IPC. */}
            <AgentControls
              modes={modes}
              models={models}
              reasoningEffort={reasoningEffort}
              disabled={isProcessing}
              onSetConfig={(axis, value) => onSetConfig?.(axis, value, boundSessionId)}
            />

            <div className="flex-1" />

            {/* Decorative voice-input affordance from the prototype; not yet wired.
                First thing to yield in a tight column (it does nothing yet). */}
            <Mic className="size-[19px] shrink-0 text-muted @max-[400px]:hidden" aria-hidden />

            {isProcessing && boundSessionId && (
              // Interrupt the active turn (#103, ADR-0009): fire `session/cancel`. The
              // turn then resolves `cancelled`, which the existing turn-complete path
              // flips `isProcessing` off on — no new local state needed here. Gated on
              // `boundSessionId` so it only shows once there's a turn it can cancel (a
              // draft's first prompt is pre-bind for its session/new round-trip).
              <IconButton
                size="icon-sm"
                variant="stop"
                aria-label="Stop turn"
                title="Stop"
                onClick={() => void window.api.cancelTurn({ agentId, sessionId: boundSessionId })}
              >
                <Square className="size-4" aria-hidden />
              </IconButton>
            )}

            {/* Circular gradient send (prototype: 36px `--accent-grad-action` + glow).
                Icon-only; the Queue-vs-Send distinction (#105) is conveyed via the
                label/tooltip while a turn streams. */}
            <button
              type="button"
              onClick={() => void send()}
              disabled={draft.trim().length === 0 && pendingImages.length === 0}
              aria-label={followUps.sending ? 'Queue message' : 'Send message'}
              title={followUps.sending ? 'Queue' : 'Send'}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white shadow-[0_1px_2px_var(--accent-shadow)] outline-none transition-opacity [background:var(--accent-grad-action)] hover:opacity-90 disabled:cursor-default disabled:opacity-40 @max-[560px]:size-8"
            >
              <ArrowUp className="size-5 @max-[560px]:size-4" aria-hidden />
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
