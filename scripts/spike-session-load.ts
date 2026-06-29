/**
 * Spike probe for GitHub issue #29 — verify `vibe-acp`'s `session/load` behaviour.
 *
 * HITL / LIVE: this drives the user's REAL Mistral account (consumes credits,
 * touches the real session store). It is NOT part of the test suite and must be
 * run by a signed-in user, by hand:
 *
 *     bun scripts/spike-session-load.ts --phase=all
 *
 * It reuses the app's own transport (`src/main/acp/client.ts::AcpClient`) so the
 * newline-delimited JSON-RPC framing is byte-identical to production. The
 * `initialize` params mirror `src/main/workspace-agent.ts` so the handshake the
 * agent sees is the same one the app sends.
 *
 * Phases (see issue #29):
 *   A — create a session in one process: initialize → session/new → a trivial
 *       session/prompt → print + persist the resulting sessionId, then exit.
 *   B — resume in a FRESH process: initialize → session/load{sessionId,cwd,
 *       mcpServers:[]}; log the response AND every replayed session/update, using
 *       an idle-gap to decide "replay done". Summarise what (if anything) replayed.
 *   C — unknown session: session/load with a random bogus UUID; print the exact
 *       error code + message (the signal TB4 #33 re-binds on).
 *
 * Flags:
 *   --phase=a|b|c|all   (default: all)
 *   --cwd=<dir>         working dir for the session (default: a STABLE temp dir
 *                       so a later standalone --phase=b reuses the same cwd as A)
 *   --session=<id>      run B/C against a known sessionId (else B/C read the id
 *                       persisted by a prior A run)
 *   --command=<bin>     launch command (default: vibe-acp)
 *   --state-file=<path> where A persists {sessionId,cwd} (default below)
 *   --idle-ms=<n>       replay idle-gap in B (default 5000)
 *   --help
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AcpClient } from '../src/main/acp/client'

// ---------------------------------------------------------------------------
// Config / args
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_STATE_FILE = join(tmpdir(), 'vibe-spike-session.txt')
const DEFAULT_CWD = join(tmpdir(), 'vibe-spike-cwd')
const DEFAULT_IDLE_MS = 5000

// Per-phase request timeouts. A real prompt turn can take a while; loads are quick.
const TIMEOUT = {
  initialize: 30_000,
  authStatus: 15_000,
  sessionNew: 30_000,
  prompt: 120_000,
  load: 30_000,
} as const

interface Args {
  phase: 'a' | 'b' | 'c' | 'all'
  cwd: string
  session: string | null
  command: string
  stateFile: string
  idleMs: number
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    phase: 'all',
    cwd: DEFAULT_CWD,
    session: null,
    command: 'vibe-acp',
    stateFile: DEFAULT_STATE_FILE,
    idleMs: DEFAULT_IDLE_MS,
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--phase=')) {
      const v = arg.slice('--phase='.length)
      if (v !== 'a' && v !== 'b' && v !== 'c' && v !== 'all') {
        throw new Error(`--phase must be one of a|b|c|all (got "${v}")`)
      }
      out.phase = v
    } else if (arg.startsWith('--cwd=')) out.cwd = arg.slice('--cwd='.length)
    else if (arg.startsWith('--session=')) out.session = arg.slice('--session='.length)
    else if (arg.startsWith('--command=')) out.command = arg.slice('--command='.length)
    else if (arg.startsWith('--state-file=')) out.stateFile = arg.slice('--state-file='.length)
    else if (arg.startsWith('--idle-ms=')) out.idleMs = Number(arg.slice('--idle-ms='.length))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

const HELP = `spike-session-load — live probe for vibe-acp session/load (issue #29)

USAGE
  bun scripts/spike-session-load.ts [--phase=a|b|c|all] [--cwd=<dir>] [--session=<id>]
                                    [--command=<bin>] [--state-file=<path>] [--idle-ms=<n>]

REQUIRES: you must be SIGNED IN to Mistral Vibe (run \`vibe\` once to sign in).
This is LIVE and consumes credits. Default --phase=all runs A -> B -> C.

  --phase=all   create a session (A), resume it in a fresh process (B), probe a
                bogus id (C). Default.
  --phase=a     only create + persist a session id.
  --phase=b     only resume; uses --session, else the id persisted by a prior A.
  --phase=c     only probe a bogus id.
  --cwd=<dir>   session working dir (default: ${DEFAULT_CWD}).
                B must use the SAME cwd as A.
  --session=<id> known sessionId for B/C.
  --idle-ms=<n>  replay idle-gap in B (default ${DEFAULT_IDLE_MS}).
`

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function banner(text: string): void {
  console.log(`\n=== ${text} ===`)
}

function log(text: string): void {
  console.log(text)
}

/** Print a JSON value verbatim, indented, prefixed for copy-paste. */
function dumpJson(label: string, value: unknown): void {
  console.log(`${label}:`)
  console.log(JSON.stringify(value, null, 2))
}

function isRpcError(err: unknown): err is { code: number; message: string; data?: unknown } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'number'
  )
}

/** The -32000 "not signed in" guard — Vibe reserves it for UnauthenticatedError. */
function isUnauthenticated(err: unknown): boolean {
  return isRpcError(err) && err.code === -32000
}

function failNotSignedIn(where: string): never {
  banner('NOT SIGNED IN')
  log(
    `vibe-acp returned -32000 (UnauthenticatedError) at ${where}.\n` +
      `You must be SIGNED IN to run this probe. Run \`vibe\` to sign in, then retry.`,
  )
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Connection wrapper (reuses the app's AcpClient transport)
// ---------------------------------------------------------------------------

interface NotificationRecord {
  sessionUpdate: string
  raw: unknown
}

class Probe {
  readonly client: AcpClient
  /** Every session/update notification seen, in order. */
  readonly notifications: NotificationRecord[] = []
  /** Timestamp (ms) of the last inbound traffic — drives the replay idle-gap. */
  lastActivity = Date.now()
  private exited: { code: number | null; signal: string | null } | null = null

  constructor(command: string, cwd: string) {
    this.client = new AcpClient({ command, cwd, env: process.env })

    this.client.on('notification', (msg: unknown) => {
      this.lastActivity = Date.now()
      const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string } } }
      const sessionUpdate = m.params?.update?.sessionUpdate ?? `(non-update: ${m.method ?? '?'})`
      this.notifications.push({ sessionUpdate, raw: msg })
      log(`  [notification] ${m.method} :: ${sessionUpdate}`)
      dumpJson('  raw', msg)
    })

    // Server-initiated requests. For the trivial prompt in phase A these are
    // unlikely, but serve them defensively so a turn never stalls, and LOG them.
    this.client.on('serverRequest', (msg: unknown) => {
      this.lastActivity = Date.now()
      this.onServerRequest(msg)
    })

    this.client.on('stderr', (text: string) => {
      const trimmed = text.trimEnd()
      if (trimmed) log(`  [stderr] ${trimmed}`)
    })
    this.client.on('error', (err: Error) => log(`  [client error] ${err.message}`))
    this.client.on('exit', (info: unknown) => {
      const i = info as { code: number | null; signal: string | null }
      this.exited = i
      log(`  [exit] code=${i.code} signal=${i.signal}`)
    })
  }

  private onServerRequest(msg: unknown): void {
    const req = msg as { id?: number | string; method?: string; params?: unknown }
    log(`  [serverRequest] ${req.method} (id=${String(req.id)})`)
    dumpJson('  raw', msg)
    if (req.id === undefined) return

    if (req.method === 'fs/read_text_file') {
      const path = (req.params as { path?: string })?.path
      let content = ''
      try {
        if (path && existsSync(path)) content = readFileSync(path, 'utf8')
      } catch {
        /* respond with empty content rather than wedge the turn */
      }
      this.client.respond(req.id, { content })
    } else if (req.method === 'fs/write_text_file') {
      const p = req.params as { path?: string; content?: string }
      try {
        if (p?.path) writeFileSync(p.path, p.content ?? '')
      } catch {
        /* ignore — best-effort for a probe */
      }
      this.client.respond(req.id, {})
    } else if (req.method === 'session/request_permission') {
      // Auto-allow once so the (trivial) turn can finish unattended.
      this.client.respond(req.id, { outcome: { outcome: 'selected', optionId: 'allow_once' } })
    } else {
      // Unknown server request — answer with method-not-found so we never hang.
      this.client.respondError(req.id, { code: -32601, message: 'method not found (probe)' })
    }
  }

  start(): void {
    this.client.start()
  }

  stop(): void {
    this.client.stop()
  }

  hasExited(): boolean {
    return this.exited !== null
  }

  /** initialize + _auth/status, with the same params the app sends. */
  async initialize(): Promise<void> {
    banner('initialize')
    const init = await withTimeout(
      this.client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          _meta: { 'browser-auth-delegated': true },
        },
        clientInfo: CLIENT_INFO,
      }),
      TIMEOUT.initialize,
      'initialize',
    )
    dumpJson('initialize result', init)

    banner('_auth/status')
    let status: unknown
    try {
      status = await withTimeout(this.client.request('_auth/status'), TIMEOUT.authStatus, '_auth/status')
      dumpJson('_auth/status result', status)
    } catch (err) {
      log(`_auth/status failed (non-fatal): ${describeError(err)}`)
      return
    }
    const authed = (status as { authenticated?: boolean })?.authenticated
    if (authed === false) {
      banner('NOT SIGNED IN')
      log(
        `_auth/status reports authenticated=false. You must be SIGNED IN to run this probe.\n` +
          `Run \`vibe\` to sign in, then retry.`,
      )
      process.exit(2)
    }
  }
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>
}

function describeError(err: unknown): string {
  if (isRpcError(err)) {
    return `JSON-RPC error code=${err.code} message=${JSON.stringify(err.message)} data=${JSON.stringify(err.data ?? null)}`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/** Block until traffic has been idle for `idleMs`, or `maxMs` elapses overall. */
async function waitForIdle(probe: Probe, idleMs: number, maxMs: number): Promise<'idle' | 'timeout'> {
  const start = Date.now()
  for (;;) {
    const sinceActivity = Date.now() - probe.lastActivity
    if (sinceActivity >= idleMs) return 'idle'
    if (Date.now() - start >= maxMs) return 'timeout'
    if (probe.hasExited()) return 'idle'
    await sleep(250)
  }
}

// ---------------------------------------------------------------------------
// State persistence (Phase A -> later B/C)
// ---------------------------------------------------------------------------

interface PersistedState {
  sessionId: string
  cwd: string
  createdAt: string
}

function persistState(file: string, state: PersistedState): void {
  writeFileSync(file, JSON.stringify(state, null, 2))
}

function loadState(file: string): PersistedState | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PersistedState
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** Phase A: create and remember a session in this process, then exit. */
async function phaseA(args: Args): Promise<PersistedState> {
  banner('PHASE A — create & remember a session')
  mkdirSync(args.cwd, { recursive: true })
  log(`cwd: ${args.cwd}`)

  const probe = new Probe(args.command, args.cwd)
  try {
    probe.start()
    await probe.initialize()

    banner('session/new')
    let session: { sessionId: string }
    try {
      session = await withTimeout(
        probe.client.request('session/new', { cwd: args.cwd, mcpServers: [] }),
        TIMEOUT.sessionNew,
        'session/new',
      )
    } catch (err) {
      if (isUnauthenticated(err)) failNotSignedIn('session/new')
      throw err
    }
    dumpJson('session/new result', session)
    const sessionId = session.sessionId
    log(`\n>>> sessionId = ${sessionId}`)

    banner('session/prompt (trivial)')
    log('prompt text: "Reply with the word: ok"')
    try {
      const result = await withTimeout(
        probe.client.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: 'Reply with the word: ok' }],
        }),
        TIMEOUT.prompt,
        'session/prompt',
      )
      dumpJson('session/prompt result (turn end)', result)
    } catch (err) {
      if (isUnauthenticated(err)) failNotSignedIn('session/prompt')
      throw err
    }

    const state: PersistedState = { sessionId, cwd: args.cwd, createdAt: new Date().toISOString() }
    persistState(args.stateFile, state)
    banner('PHASE A DONE')
    log(`sessionId : ${sessionId}`)
    log(`cwd       : ${args.cwd}`)
    log(`persisted : ${args.stateFile}`)
    return state
  } finally {
    // Clean exit of THIS process's agent — Phase B uses a brand-new one.
    probe.stop()
  }
}

/** Phase B: resume the saved session in a FRESH process and log any replay. */
async function phaseB(args: Args, sessionId: string, cwd: string): Promise<void> {
  banner('PHASE B — resume in a FRESH process')
  log(`sessionId: ${sessionId}`)
  log(`cwd      : ${cwd}`)
  mkdirSync(cwd, { recursive: true })

  const probe = new Probe(args.command, cwd)
  try {
    probe.start()
    await probe.initialize()

    banner('session/load')
    log(`request params: {"sessionId":"${sessionId}","cwd":"${cwd}","mcpServers":[]}`)
    log('(any replayed session/update notifications are logged below as they arrive)')
    let loadResult: unknown
    let loadError: unknown = null
    try {
      loadResult = await withTimeout(
        probe.client.request('session/load', { sessionId, cwd, mcpServers: [] }),
        TIMEOUT.load,
        'session/load',
      )
      dumpJson('session/load result', loadResult)
    } catch (err) {
      loadError = err
      if (isUnauthenticated(err)) failNotSignedIn('session/load')
      banner('session/load FAILED')
      log(describeError(err))
    }

    // Whether the response resolved or rejected, wait out the replay idle-gap:
    // some agents stream history as notifications that arrive after the result.
    banner(`waiting for replay idle-gap (${args.idleMs}ms idle, ${TIMEOUT.load}ms max)`)
    const outcome = await waitForIdle(probe, args.idleMs, TIMEOUT.load)
    log(`replay wait ended: ${outcome}`)

    // ---- Summary ----
    banner('PHASE B SUMMARY')
    const succeeded = loadError === null
    log(`session/load succeeded?   ${succeeded ? 'YES' : 'NO'}`)
    if (!succeeded) log(`  error: ${describeError(loadError)}`)
    log(`replayed notifications:   ${probe.notifications.length}`)
    if (probe.notifications.length > 0) {
      const byType = new Map<string, number>()
      for (const n of probe.notifications) byType.set(n.sessionUpdate, (byType.get(n.sessionUpdate) ?? 0) + 1)
      log('  by sessionUpdate type:')
      for (const [type, count] of byType) log(`    ${type}: ${count}`)
      log('  => session/load REPLAYS prior history as session/update notifications (shape above).')
    } else {
      log('  => session/load did NOT replay any session/update notifications.')
      log('     (History likely must be rendered from our own JSONL — confirm against the result shape above.)')
    }
  } finally {
    probe.stop()
  }
}

/** Phase C: load an unknown/bogus session id; capture the exact error. */
async function phaseC(args: Args, cwd: string): Promise<void> {
  banner('PHASE C — unknown session id')
  const bogus = randomUUID()
  log(`bogus sessionId: ${bogus}`)
  log(`cwd            : ${cwd}`)
  mkdirSync(cwd, { recursive: true })

  const probe = new Probe(args.command, cwd)
  try {
    probe.start()
    await probe.initialize()

    banner('session/load (bogus id)')
    try {
      const result = await withTimeout(
        probe.client.request('session/load', { sessionId: bogus, cwd, mcpServers: [] }),
        TIMEOUT.load,
        'session/load',
      )
      banner('PHASE C SUMMARY — UNEXPECTED SUCCESS')
      log('session/load with a bogus id did NOT error. Result:')
      dumpJson('result', result)
      log('NOTE: this is surprising — TB4 cannot key resume-failure on an error code here.')
    } catch (err) {
      if (isUnauthenticated(err)) failNotSignedIn('session/load')
      banner('PHASE C SUMMARY — error captured (the signal TB4 re-binds on)')
      if (isRpcError(err)) {
        log(`error.code    = ${err.code}`)
        log(`error.message = ${JSON.stringify(err.message)}`)
        log(`error.data    = ${JSON.stringify(err.data ?? null)}`)
      } else {
        log(`non-RPC error: ${describeError(err)}`)
      }
    }
  } finally {
    probe.stop()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log(HELP)
    return
  }

  log('vibe-acp session/load spike (issue #29) — LIVE, requires a signed-in user.')
  log(`command=${args.command} phase=${args.phase} cwd=${args.cwd}`)

  if (args.phase === 'a') {
    await phaseA(args)
    return
  }

  if (args.phase === 'all') {
    const state = await phaseA(args)
    await phaseB(args, state.sessionId, state.cwd)
    await phaseC(args, state.cwd)
    banner('ALL PHASES COMPLETE')
    return
  }

  // Standalone B or C: resolve sessionId/cwd from --session or persisted state.
  const persisted = loadState(args.stateFile)
  const sessionId = args.session ?? persisted?.sessionId ?? null
  const cwd = args.cwd !== DEFAULT_CWD ? args.cwd : (persisted?.cwd ?? args.cwd)

  if (args.phase === 'b') {
    if (!sessionId) {
      throw new Error(
        `--phase=b needs a sessionId: pass --session=<id> or run --phase=a first ` +
          `(persisted state: ${args.stateFile}).`,
      )
    }
    await phaseB(args, sessionId, cwd)
    return
  }

  if (args.phase === 'c') {
    await phaseC(args, cwd)
    return
  }
}

main().catch((err) => {
  banner('PROBE FAILED')
  console.error(describeError(err))
  process.exit(1)
})
