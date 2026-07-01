/**
 * Spike probe for the "queue-vs-steer follow-ups" composer feature — verify how
 * `vibe-acp` CANCELS a turn and how it treats a SECOND `session/prompt` sent while
 * the first is still streaming. Both are UNVERIFIED in capture: docs list
 * `session/cancel` with "shape unverified", there is NO steer/inject method, and
 * nothing documents mid-turn second-prompt behavior. This gates the design (if the
 * agent can't inject mid-turn, "steer" is impossible and the design is queue+cancel).
 *
 * HITL / LIVE, read-only: runs in `chat` mode so the agent CANNOT touch the
 * workspace. Sends long (benign) `session/prompt`s + `session/cancel` + a second
 * `session/prompt`. Only `_auth/status` / `session/new` / `session/set_mode` /
 * `session/prompt` / `session/cancel` — no `authenticate`/`_auth/signOut`/keychain,
 * no writes. Safe under the house rules. Run it yourself, signed in:
 *
 *     bun build scripts/spike-cancel-steer.ts --target=node --outfile=/tmp/spike-cs.mjs && node /tmp/spike-cs.mjs
 *
 * (node target, NOT bun — Bun's child_process doesn't deliver stdin.write; §9 gotcha.)
 *
 * Q1 — CANCEL: is `session/cancel` a NOTIFICATION or a REQUEST? params? Does the
 *      in-flight `session/prompt` then settle — resolve (with what `stopReason`?) or
 *      reject (what code?) — and does streaming actually stop promptly?
 * Q2 — MID-TURN SECOND PROMPT (queue vs steer): a 2nd `session/prompt` sent while the
 *      1st streams — rejected immediately (code?), queued (resolves after the 1st), or
 *      interleaved? Decides whether live "steer" is even possible on vibe-acp.
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_CWD = join(tmpdir(), 'vibe-spike-cancel-cwd')
const TIMEOUT = { initialize: 30_000, authStatus: 15_000, sessionNew: 30_000, setMode: 15_000, prompt: 180_000, settle: 30_000 } as const
// A prompt that streams for a while, so there's a wide window to cancel / inject.
const LONG_PROMPT =
  'Write a detailed essay of at least 500 words about the history and construction of the Roman Colosseum. Use several paragraphs and go slowly.'
const SHORT_PROMPT = 'Separately: what is 2 + 2? Reply with just the number.'

interface Args {
  cwd: string
  command: string
  help: boolean
}
function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: DEFAULT_CWD, command: 'vibe-acp', help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--cwd=')) out.cwd = arg.slice('--cwd='.length)
    else if (arg.startsWith('--command=')) out.command = arg.slice('--command='.length)
  }
  return out
}

// --- logging helpers (mirrors the other spikes) ------------------------------
function log(msg: string): void {
  console.log(msg)
}
function banner(title: string): void {
  log(`\n===== ${title} =====`)
}
function dumpJson(label: string, value: unknown): void {
  log(`${label}:\n${JSON.stringify(value, null, 2)}`)
}
function isRpcError(err: unknown): err is { code: number; message: string; data?: unknown } {
  return typeof err === 'object' && err !== null && typeof (err as { code: unknown }).code === 'number'
}
function describeError(err: unknown): string {
  if (isRpcError(err)) return `JSON-RPC error code=${err.code} message=${JSON.stringify(err.message)}`
  if (err instanceof Error) return err.message
  return String(err)
}
function isUnauthenticated(err: unknown): boolean {
  return isRpcError(err) && err.code === -32000
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))])
}

/** Counts streamed message/thought chunks so we can tell when a turn is live + if it stops. */
class ChunkCounter {
  count = 0
  push(msg: unknown): void {
    const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string } } }
    const k = m?.params?.update?.sessionUpdate
    if (m?.method === 'session/update' && (k === 'agent_message_chunk' || k === 'agent_thought_chunk')) this.count++
  }
}

function startClient(args: Args, sink: ChunkCounter): AcpClient {
  const client = new AcpClient({ command: args.command, cwd: args.cwd, env: process.env })
  client.on('notification', (msg: unknown) => sink.push(msg))
  client.on('serverRequest', (msg: unknown) => dumpJson('  [serverRequest — NOT answered by probe]', msg))
  client.on('stderr', () => {})
  client.on('error', (err: Error) => log(`  [client error] ${err.message}`))
  client.start()
  return client
}

async function initialize(client: AcpClient): Promise<void> {
  banner('initialize')
  await withTimeout(
    client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: CLIENT_INFO,
    }),
    TIMEOUT.initialize,
    'initialize',
  )
  try {
    const status = (await withTimeout(client.request('_auth/status'), TIMEOUT.authStatus, '_auth/status')) as { authenticated?: boolean }
    if (status?.authenticated === false) {
      log('\n!! _auth/status authenticated=false. SIGN IN (run `vibe`) and retry. Exiting.')
      process.exit(2)
    }
  } catch (err) {
    log(`_auth/status failed (non-fatal): ${describeError(err)}`)
  }
}

async function newChatSession(client: AcpClient, cwd: string): Promise<string> {
  banner('session/new (+ set mode chat for read-only safety)')
  let result: Record<string, unknown>
  try {
    result = (await withTimeout(client.request('session/new', { cwd, mcpServers: [] }), TIMEOUT.sessionNew, 'session/new')) as Record<string, unknown>
  } catch (err) {
    if (isUnauthenticated(err)) {
      log('\n!! session/new -32000 (unauthenticated). SIGN IN and retry. Exiting.')
      process.exit(2)
    }
    throw err
  }
  const sid = result.sessionId as string
  const hasChat = ((result.modes as { availableModes?: { id: string }[] } | undefined)?.availableModes ?? []).some((m) => m.id === 'chat')
  if (hasChat) {
    try {
      await withTimeout(client.request('session/set_mode', { sessionId: sid, modeId: 'chat' }), TIMEOUT.setMode, 'session/set_mode')
      log('mode → chat (read-only)')
    } catch (err) {
      log(`set_mode chat failed (continuing): ${describeError(err)}`)
    }
  }
  return sid
}

/** Wait until the streaming turn has emitted at least `n` chunks (or time out). */
async function waitForChunks(sink: ChunkCounter, n: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (sink.count < n) {
    if (Date.now() - start > timeoutMs) return false
    await sleep(150)
  }
  return true
}

/** Settle a prompt promise into a tagged outcome without throwing. */
type Settled = { state: 'resolved'; stopReason: unknown; raw: unknown } | { state: 'rejected'; code: number | null; message: string } | { state: 'timeout' }
function tagged(p: Promise<unknown>): Promise<Settled> {
  return p.then(
    (r) => ({ state: 'resolved' as const, stopReason: (r as { stopReason?: unknown })?.stopReason ?? null, raw: r }),
    (e) => ({ state: 'rejected' as const, code: isRpcError(e) ? e.code : null, message: describeError(e) }),
  )
}
function settleWithin(p: Promise<Settled>, ms: number): Promise<Settled> {
  return Promise.race([p, new Promise<Settled>((resolve) => setTimeout(() => resolve({ state: 'timeout' }), ms))])
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log('spike-cancel-steer — verify vibe-acp session/cancel + mid-turn second-prompt behavior. Flags: --cwd --command')
    return
  }
  mkdirSync(args.cwd, { recursive: true })
  log(`cwd=${args.cwd}  command=${args.command}`)

  // ===== Q1: CANCEL (try the ACP-standard NOTIFICATION first, then a REQUEST) =====
  for (const mode of ['notify', 'request'] as const) {
    const sink = new ChunkCounter()
    const client = startClient(args, sink)
    await initialize(client)
    const sid = await newChatSession(client, args.cwd)

    banner(`Q1 — cancel via ${mode.toUpperCase()}  (session/cancel {sessionId})`)
    const turn = tagged(withTimeout(client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: LONG_PROMPT }] }), TIMEOUT.prompt, 'session/prompt'))
    const streaming = await waitForChunks(sink, 3, 20_000)
    log(`  streaming started: ${streaming} (chunks so far: ${sink.count})`)
    const atCancel = sink.count
    log(`  sending session/cancel as a ${mode}…`)
    try {
      if (mode === 'notify') client.notify('session/cancel', { sessionId: sid })
      else dumpJson('  cancel REQUEST result', await withTimeout(client.request('session/cancel', { sessionId: sid }), 10_000, 'session/cancel'))
    } catch (err) {
      log(`  session/cancel (${mode}) errored: ${describeError(err)} ${isRpcError(err) && err.code === -32601 ? '(-32601 method-not-found → not a ' + mode + ')' : ''}`)
    }
    // Did the turn settle promptly, and did streaming stop?
    const settled = await settleWithin(turn, TIMEOUT.settle)
    await sleep(1500)
    const afterCancel = sink.count
    log(`  chunks at cancel: ${atCancel}; after settle+1.5s: ${afterCancel} (Δ ${afterCancel - atCancel})`)
    dumpJson('  in-flight session/prompt settled as', settled)
    log(
      `  => cancel-${mode} verdict: ${
        settled.state === 'resolved'
          ? `prompt RESOLVED stopReason=${JSON.stringify(settled.stopReason)}${afterCancel - atCancel <= 2 ? ' (streaming stopped ✔)' : ' (BUT streaming kept going ✘ — cancel ineffective)'}`
          : settled.state === 'rejected'
            ? `prompt REJECTED code=${settled.code} (${settled.message})`
            : 'prompt did NOT settle within 30s (cancel had no effect ✘)'
      }`,
    )
    client.stop()
    await sleep(600)
    // If the notification form clearly worked, skip the request form.
    if (mode === 'notify' && settled.state !== 'timeout' && afterCancel - atCancel <= 2) {
      log('\n  notification form worked — skipping the request form.')
      break
    }
  }

  // ===== Q2: MID-TURN SECOND PROMPT (queue vs steer vs reject) =====
  {
    const sink = new ChunkCounter()
    const client = startClient(args, sink)
    await initialize(client)
    const sid = await newChatSession(client, args.cwd)

    banner('Q2 — second session/prompt sent WHILE the first streams')
    const p1 = tagged(withTimeout(client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: LONG_PROMPT }] }), TIMEOUT.prompt, 'session/prompt#1'))
    const streaming = await waitForChunks(sink, 3, 20_000)
    log(`  first turn streaming: ${streaming} (chunks: ${sink.count})`)
    log('  sending a SECOND session/prompt mid-turn…')
    const t2Start = Date.now()
    const p2 = tagged(withTimeout(client.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: SHORT_PROMPT }] }), TIMEOUT.prompt, 'session/prompt#2'))
    // Does #2 reject/resolve FAST (rejected mid-turn) or stay pending (queued)?
    const p2Fast = await settleWithin(
      p2.then((s) => s),
      5_000,
    )
    if (p2Fast.state === 'timeout') {
      log('  second prompt is still PENDING 5s in (not rejected) — likely QUEUED behind the first.')
    } else {
      log(`  second prompt settled FAST (${Date.now() - t2Start}ms): ${JSON.stringify(p2Fast)}`)
    }
    const first = await settleWithin(p1, TIMEOUT.settle)
    const second = await settleWithin(p2, TIMEOUT.settle)
    dumpJson('  first prompt', first)
    dumpJson('  second prompt', second)
    log(
      `  => mid-turn second-prompt verdict: ${
        p2Fast.state === 'rejected'
          ? `REJECTED immediately code=${p2Fast.code} — no queue/steer; the client must serialize (queue) or cancel-first (interrupt).`
          : p2Fast.state === 'timeout'
            ? 'QUEUED — vibe serializes; a client "queue" maps to just sending after the turn ends (or vibe holds it). Live "steer" (interleave) NOT observed.'
            : `resolved fast — inspect ordering above.`
      }`,
    )
    client.stop()
  }

  banner('DONE')
}

main()
  .then(() => setTimeout(() => process.exit(0), 300))
  .catch((err) => {
    console.error(`\nFATAL: ${describeError(err)}`)
    process.exit(1)
  })
