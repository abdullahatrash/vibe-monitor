/**
 * Spike probe for GitHub issue #65 — verify how `vibe-acp` CHANGES a config option
 * (Mode / Model / Reasoning effort) mid-session, and whether the change survives a
 * `session/load`.
 *
 * HITL / LIVE: this drives the user's REAL Mistral account. It calls only
 * `initialize` / `_auth/status` (read) / `session/new` / candidate config-setter
 * methods / `session/load`. It deliberately sends NO `session/prompt`, so the agent
 * never acts on the workspace — it just creates a session, flips config options, and
 * resumes. Safe under the house security rules (no `authenticate`/`_auth/signOut`,
 * no keychain access). Run it yourself, signed in:
 *
 *     bun build scripts/spike-config-option.ts --target=node --outfile=/tmp/spike-config.mjs && node /tmp/spike-config.mjs
 *
 * (Built to a node target, NOT run under bun — Bun's child_process doesn't deliver
 * stdin.write to a piped child, which the AcpClient transport relies on.)
 *
 * It reuses the app's own transport (`src/main/acp/client.ts::AcpClient`) so the
 * JSON-RPC framing is byte-identical to production, and sends the same `initialize`
 * params as `src/main/workspace-agent.ts`.
 *
 * Three questions (issue #65):
 *   Q1 — the change method: which `(method, params)` actually changes a config option?
 *        We try a list of candidates and read the JSON-RPC error code to tell
 *        method-not-found (-32601) from wrong-params (-32602) from success.
 *   Q2 — persistence: after setting a non-default Mode, does a FRESH-process
 *        `session/load` report the new Mode, or reset to default?
 *   Q3 — notification: does a successful change emit a `session/update`
 *        (e.g. `current_mode_update`)? We log every notification around each attempt.
 *
 * Flags: --cwd=<dir>  --command=<bin>  --idle-ms=<n>  --help
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_CWD = join(tmpdir(), 'vibe-spike-config-cwd')
const TIMEOUT = { initialize: 30_000, authStatus: 15_000, sessionNew: 30_000, setOption: 30_000, prompt: 120_000, load: 30_000 } as const

interface Args {
  cwd: string
  command: string
  idleMs: number
  skipQ2: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: DEFAULT_CWD, command: 'vibe-acp', idleMs: 2000, skipQ2: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--skip-q2') out.skipQ2 = true
    else if (arg.startsWith('--cwd=')) out.cwd = arg.slice('--cwd='.length)
    else if (arg.startsWith('--command=')) out.command = arg.slice('--command='.length)
    else if (arg.startsWith('--idle-ms=')) out.idleMs = Number(arg.slice('--idle-ms='.length))
  }
  return out
}

// --- logging helpers ---------------------------------------------------------
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
  if (isRpcError(err)) return `JSON-RPC error code=${err.code} message=${JSON.stringify(err.message)} data=${JSON.stringify(err.data ?? null)}`
  if (err instanceof Error) return err.message
  return String(err)
}
function isUnauthenticated(err: unknown): boolean {
  return isRpcError(err) && err.code === -32000
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
/** The `sessionUpdate` discriminator of a `session/update` notification, for terse logging. */
function notifKind(msg: unknown): string {
  const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string } } }
  if (m?.method === 'session/update') return m.params?.update?.sessionUpdate ?? 'session/update(?)'
  return m?.method ?? 'unknown'
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// A live capture of notifications, so each attempt can report what (if anything) the
// agent streamed back. The caller drains `taken()` after each candidate attempt.
class NotificationSink {
  private buffer: unknown[] = []
  push(msg: unknown): void {
    this.buffer.push(msg)
  }
  taken(): unknown[] {
    const out = this.buffer
    this.buffer = []
    return out
  }
}

interface SessionConfig {
  sessionId: string
  modes: { currentModeId: string; availableModes: { id: string; name?: string }[] } | null
  models: { currentModelId: string; availableModels: { modelId: string; name?: string }[] } | null
  configOptions: { id: string; currentValue?: unknown; options?: { value: unknown }[] }[] | null
}

function startClient(args: Args, sink: NotificationSink): AcpClient {
  const client = new AcpClient({ command: args.command, cwd: args.cwd, env: process.env })
  client.on('notification', (msg: unknown) => {
    sink.push(msg)
    dumpJson('  [notification]', msg)
  })
  client.on('serverRequest', (msg: unknown) => dumpJson('  [serverRequest — NOT answered by probe]', msg))
  client.on('stderr', (text: string) => process.stderr.write(`  [stderr] ${text}`))
  client.on('error', (err: Error) => log(`  [client error] ${err.message}`))
  client.on('exit', (info: unknown) => dumpJson('  [exit]', info))
  client.start()
  return client
}

async function initialize(client: AcpClient): Promise<void> {
  banner('initialize')
  const init = await withTimeout(
    client.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: CLIENT_INFO,
    }),
    TIMEOUT.initialize,
    'initialize',
  )
  dumpJson('initialize result', init)

  banner('_auth/status')
  try {
    const status = (await withTimeout(client.request('_auth/status'), TIMEOUT.authStatus, '_auth/status')) as {
      authenticated?: boolean
    }
    dumpJson('_auth/status result', status)
    if (status?.authenticated === false) {
      log('\n!! _auth/status reports authenticated=false. SIGN IN (run `vibe`) and retry. Exiting.')
      process.exit(2)
    }
  } catch (err) {
    log(`_auth/status failed (non-fatal): ${describeError(err)}`)
  }
}

async function newSession(client: AcpClient, cwd: string): Promise<SessionConfig> {
  banner('session/new')
  let result: Record<string, unknown>
  try {
    result = (await withTimeout(
      client.request('session/new', { cwd, mcpServers: [] }),
      TIMEOUT.sessionNew,
      'session/new',
    )) as Record<string, unknown>
  } catch (err) {
    if (isUnauthenticated(err)) {
      log('\n!! session/new returned -32000 (unauthenticated). SIGN IN and retry. Exiting.')
      process.exit(2)
    }
    throw err
  }
  dumpJson('session/new result', result)
  return {
    sessionId: result.sessionId as string,
    modes: (result.modes as SessionConfig['modes']) ?? null,
    models: (result.models as SessionConfig['models']) ?? null,
    configOptions: (result.configOptions as SessionConfig['configOptions']) ?? null,
  }
}

/** Pick an available value different from the current one, for a given axis. */
function pickAltMode(cfg: SessionConfig): { current: string; alt: string } | null {
  if (!cfg.modes) return null
  const current = cfg.modes.currentModeId
  const alt = cfg.modes.availableModes.map((m) => m.id).find((id) => id !== current)
  return alt ? { current, alt } : null
}
function pickAltModel(cfg: SessionConfig): { current: string; alt: string } | null {
  if (!cfg.models) return null
  const current = cfg.models.currentModelId
  const alt = cfg.models.availableModels.map((m) => m.modelId).find((id) => id !== current)
  return alt ? { current, alt } : null
}
function pickAltThinking(cfg: SessionConfig): { current: unknown; alt: unknown } | null {
  const opt = cfg.configOptions?.find((o) => o.id === 'thinking')
  if (!opt?.options) return null
  const current = opt.currentValue
  const alt = opt.options.map((o) => o.value).find((v) => v !== current)
  return alt !== undefined ? { current, alt } : null
}

interface Attempt {
  method: string
  params: unknown
}

/** Run one candidate, classify the outcome, drain notifications. */
async function tryAttempt(
  client: AcpClient,
  sink: NotificationSink,
  idleMs: number,
  attempt: Attempt,
): Promise<{ ok: boolean; code: number | null; result?: unknown; error?: unknown; notes?: unknown[] }> {
  log(`\n--- attempt: ${attempt.method}  params=${JSON.stringify(attempt.params)}`)
  try {
    const result = await withTimeout(client.request(attempt.method, attempt.params), TIMEOUT.setOption, attempt.method)
    log(`  => SUCCESS`)
    dumpJson('  result', result)
    await sleep(idleMs)
    const notes = sink.taken()
    log(`  notifications during/after: ${notes.length} (kinds: ${notes.map(notifKind).join(', ') || 'none'})`)
    return { ok: true, code: null, result, notes }
  } catch (err) {
    const code = isRpcError(err) ? err.code : null
    log(`  => FAILED  ${describeError(err)}`)
    if (code === -32601) log(`     (-32601 = method not found — this method name does NOT exist)`)
    else if (code === -32602) log(`     (-32602 = invalid params — method EXISTS, param shape is wrong)`)
    await sleep(idleMs)
    sink.taken()
    return { ok: false, code, error: err }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log('spike-config-option — verify vibe-acp config-option change method (#65). Flags: --cwd --command --idle-ms')
    return
  }
  mkdirSync(args.cwd, { recursive: true })
  log(`cwd=${args.cwd}  command=${args.command}  idleMs=${args.idleMs}`)

  const sink = new NotificationSink()
  const client = startClient(args, sink)
  await initialize(client)
  const cfg = await newSession(client, args.cwd)
  // Drain notifications that arrive shortly AFTER session/new (vibe streams an
  // `available_commands_update` here) so Q3 can attribute later notifications to the
  // actual config change, not to session/new.
  await sleep(args.idleMs)
  const postNew = sink.taken()
  log(`\npost-session/new notifications: ${postNew.length} (kinds: ${postNew.map(notifKind).join(', ') || 'none'})`)

  const mode = pickAltMode(cfg)
  const model = pickAltModel(cfg)
  const thinking = pickAltThinking(cfg)
  banner('targets')
  dumpJson('mode', mode)
  dumpJson('model', model)
  dumpJson('thinking', thinking)
  if (!mode) {
    log('No alternate mode available — cannot probe a mode change. Exiting.')
    client.stop()
    return
  }

  const sid = cfg.sessionId

  // Generic: try candidates in order, return the first that succeeds (+ its notes).
  async function findMethod(label: string, candidates: Attempt[]): Promise<{ winner: Attempt | null; notes: unknown[] }> {
    banner(`Q1 — ${label}`)
    for (const c of candidates) {
      const r = await tryAttempt(client, sink, args.idleMs, c)
      if (r.ok) return { winner: c, notes: r.notes ?? [] }
      if (r.code === -32602) log(`  ^ NOTE: ${c.method} EXISTS (wrong params) — fix the param shape, not the name.`)
    }
    return { winner: null, notes: [] }
  }

  // Q1 — MODE setter.
  const modeProbe = await findMethod('mode setter', [
    { method: 'session/set_mode', params: { sessionId: sid, modeId: mode.alt } },
    { method: 'set_config_option', params: { sessionId: sid, id: 'mode', value: mode.alt } },
    { method: 'session/set_config_option', params: { sessionId: sid, id: 'mode', value: mode.alt } },
  ])

  // Q1 — MODEL setter (try the ACP-symmetric name first, then the configOption forms).
  const modelProbe = model
    ? await findMethod('model setter', [
        { method: 'session/set_model', params: { sessionId: sid, modelId: model.alt } },
        { method: 'session/set_config_option', params: { sessionId: sid, id: 'model', value: model.alt } },
        { method: 'set_config_option', params: { sessionId: sid, id: 'model', value: model.alt } },
      ])
    : { winner: null, notes: [] }

  // Q1 — THINKING (reasoning effort) setter.
  // `session/set_config_option` returned -32602 (exists, wrong params) for {id,value};
  // sweep param-shape variants to find the right one. (NOT session/set_model — that
  // false-positives by accepting any string as a modelId.)
  const thinkingProbe = thinking
    ? await findMethod('reasoning-effort (thinking) setter', [
        // Verified from the vibe-acp source (acp/schema.py SetSessionConfigOptionSelectRequest):
        // params are { sessionId, configId, value } — `configId`, NOT `id`.
        { method: 'session/set_config_option', params: { sessionId: sid, configId: 'thinking', value: thinking.alt } },
      ])
    : { winner: null, notes: [] }

  banner('Q1 RESULT — change methods')
  log(`  mode    : ${modeProbe.winner?.method ?? 'NONE FOUND'}`)
  log(`  model   : ${modelProbe.winner?.method ?? 'NONE FOUND'}`)
  log(`  thinking: ${thinkingProbe.winner?.method ?? 'NONE FOUND'}`)

  banner('Q3 RESULT — change notifications')
  const kinds = (notes: unknown[]): string => notes.map(notifKind).join(', ') || 'NONE'
  log(`  post-session/new emitted: ${kinds(postNew)}`)
  log(`  after mode change       : ${kinds(modeProbe.notes)}`)
  log(`  after model change      : ${kinds(modelProbe.notes)}`)
  log(`  after thinking change   : ${kinds(thinkingProbe.notes)}`)
  const sawModeNotif = modeProbe.notes.some((n) => notifKind(n).includes('mode'))
  log(`  => current-mode notification on change? ${sawModeNotif ? 'YES' : 'NO — renderer must update optimistically (ADR-0007 fallback)'}`)

  if (args.skipQ2) {
    banner('Q2 — SKIPPED (--skip-q2)')
    client.stop()
    return
  }

  // Q2 — persistence across a FRESH-process session/load. A session only becomes
  // loadable after it has a turn, so send ONE trivial prompt. We set mode to `plan`
  // (read-only) first, so this prompt cannot make the agent touch the workspace.
  banner('Q2 — persist mode via a trivial (read-only) prompt, then reload')
  if (mode.alt !== 'plan' && modeProbe.winner) {
    log('  re-setting mode to read-only "plan" before the prompt (safety)…')
    await tryAttempt(client, sink, args.idleMs, { method: modeProbe.winner.method, params: { sessionId: sid, modeId: 'plan' } })
  }
  const persistedMode = 'plan'
  try {
    log('  sending trivial prompt to persist the session…')
    const promptRes = await withTimeout(
      client.request('session/prompt', {
        sessionId: sid,
        prompt: [{ type: 'text', text: 'Reply with exactly the word: ok' }],
      }),
      TIMEOUT.prompt,
      'session/prompt',
    )
    dumpJson('  session/prompt result (stopReason)', promptRes)
  } catch (err) {
    log(`  session/prompt failed (Q2 may be inconclusive): ${describeError(err)}`)
  }
  sink.taken()
  log('  stopping first agent…')
  client.stop()
  await sleep(500)

  const sink2 = new NotificationSink()
  const client2 = startClient(args, sink2)
  await initialize(client2)
  try {
    const loaded = (await withTimeout(
      client2.request('session/load', { sessionId: sid, cwd: args.cwd, mcpServers: [] }),
      TIMEOUT.load,
      'session/load',
    )) as Record<string, unknown>
    const reloadedMode = (loaded.modes as SessionConfig['modes'])?.currentModeId
    const reloadedModel = (loaded.models as SessionConfig['models'])?.currentModelId
    dumpJson('session/load modes/models', { reloadedMode, reloadedModel })
    banner('Q2 RESULT — persistence across session/load')
    log(`  set mode to "${persistedMode}"; reloaded reports currentModeId="${reloadedMode}"`)
    if (reloadedMode === persistedMode) log('  => PRESERVED — Agent controls stay Vibe-owned/display-only (ADR-0007).')
    else log(`  => NOT preserved (got "${reloadedMode}") — picker caches + re-asserts after load (ADR-0007 fallback).`)
  } catch (err) {
    log(`session/load failed: ${describeError(err)}`)
  } finally {
    client2.stop()
  }

  banner('DONE')
}

main()
  .then(() => {
    setTimeout(() => process.exit(0), 300)
  })
  .catch((err) => {
    console.error(`\nFATAL: ${describeError(err)}`)
    process.exit(1)
  })
