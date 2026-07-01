/**
 * Spike probe for GitHub issue #94-era "composer extras: image attachments" — verify
 * the EXACT `session/prompt` image content-block wire shape `vibe-acp` accepts, and
 * which models actually ingest images.
 *
 * Why a spike: `initialize` advertises `promptCapabilities.image:true` (acp-capture §1)
 * but the ONLY prompt block shape captured (§3) is `{type:"text",text}` — the image
 * block's field names are NOT in capture. CLAUDE.md forbids hardcoding unverified ACP
 * shapes, so we discover it live before building the cross-layer slice.
 *
 * HITL / LIVE: this drives the user's REAL Mistral account and SENDS a prompt (one
 * trivial vision question per attempt — "what color is this image?"). It calls only
 * `initialize` / `_auth/status` (read) / `session/new` / `session/set_mode` (→ read-only
 * `chat`, so the agent cannot touch the workspace) / `session/set_model` /
 * `session/prompt`. NO `authenticate` / `_auth/signOut` / keychain access — safe under
 * the house security rules. Run it yourself, signed in:
 *
 *     bun build scripts/spike-image-block.ts --target=node --outfile=/tmp/spike-image.mjs && node /tmp/spike-image.mjs
 *
 * (Built to a node target, NOT run under bun — Bun's child_process doesn't deliver
 * stdin.write to a piped child, which the AcpClient transport relies on.)
 *
 * Questions:
 *   Q1 — WIRE SHAPE: which image block does the agent accept? We try candidates
 *        (ACP-standard `{type:"image",data,mimeType}` first) and classify each by the
 *        JSON-RPC error code: -32602 = block shape unrecognized (wrong field names);
 *        -31007 = invalid-image (shape RIGHT, data rejected); -31008 = images
 *        unsupported (shape right, model can't); success = shape right + supported.
 *   Q2 — ROUND-TRIP: on success, capture the agent's answer — if it names the image's
 *        colour, the model genuinely ingested the pixels (not silently dropped them).
 *   Q3 — MODEL SUPPORT: if the default model returns -31008, sweep `availableModels`
 *        (via `session/set_model`) to learn which models accept images.
 *
 * Flags: --cwd=<dir>  --command=<bin>  --idle-ms=<n>  --help
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { AcpClient } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_CWD = join(tmpdir(), 'vibe-spike-image-cwd')
const TIMEOUT = { initialize: 30_000, authStatus: 15_000, sessionNew: 30_000, setOption: 30_000, prompt: 120_000 } as const
// The image we send: a solid pure-blue square. Big enough that "what colour" is
// unambiguous, small enough to keep the base64 tiny. The colour is the round-trip tell.
const IMAGE_SIZE = 16
const IMAGE_RGB: [number, number, number] = [0, 0, 255]
const IMAGE_COLOUR_NAME = 'blue'
const VISION_QUESTION = 'This message includes one image: a solid square of a single colour. Reply with EXACTLY that colour as one lowercase word, nothing else.'

interface Args {
  cwd: string
  command: string
  idleMs: number
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: DEFAULT_CWD, command: 'vibe-acp', idleMs: 2500, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--cwd=')) out.cwd = arg.slice('--cwd='.length)
    else if (arg.startsWith('--command=')) out.command = arg.slice('--command='.length)
    else if (arg.startsWith('--idle-ms=')) out.idleMs = Number(arg.slice('--idle-ms='.length))
  }
  return out
}

// --- logging helpers (mirrors spike-config-option.ts) ------------------------
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
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// --- a minimal, dependency-free PNG encoder for a solid RGB square -----------
// PNG = signature + IHDR + IDAT(zlib(scanlines)) + IEND; each chunk carries a CRC32.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
function solidPngBase64(size: number, [r, g, b]: [number, number, number]): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type 2 = truecolour RGB
  // 10..12 = compression/filter/interlace = 0
  const row = Buffer.alloc(1 + size * 3) // leading filter byte (0) + RGB triples
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  const idat = deflateSync(raw)
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
  return png.toString('base64')
}

// --- notification capture: accumulate the agent's answer text ----------------
class AnswerSink {
  private text = ''
  push(msg: unknown): void {
    const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }
    if (m?.method === 'session/update' && m.params?.update?.sessionUpdate === 'agent_message_chunk') {
      this.text += m.params.update.content?.text ?? ''
    }
  }
  taken(): string {
    const out = this.text
    this.text = ''
    return out
  }
}

function startClient(args: Args, sink: AnswerSink): AcpClient {
  const client = new AcpClient({ command: args.command, cwd: args.cwd, env: process.env })
  client.on('notification', (msg: unknown) => sink.push(msg))
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
  const caps = (init as { agentCapabilities?: { promptCapabilities?: unknown } })?.agentCapabilities?.promptCapabilities
  dumpJson('initialize promptCapabilities', caps ?? '(not found — dumping full init below)')
  if (!caps) dumpJson('initialize result', init)

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

interface SessionConfig {
  sessionId: string
  currentModelId: string | null
  availableModelIds: string[]
  hasChatMode: boolean
}

async function newSession(client: AcpClient, cwd: string): Promise<SessionConfig> {
  banner('session/new')
  let result: Record<string, unknown>
  try {
    result = (await withTimeout(client.request('session/new', { cwd, mcpServers: [] }), TIMEOUT.sessionNew, 'session/new')) as Record<string, unknown>
  } catch (err) {
    if (isUnauthenticated(err)) {
      log('\n!! session/new returned -32000 (unauthenticated). SIGN IN and retry. Exiting.')
      process.exit(2)
    }
    throw err
  }
  const models = result.models as { currentModelId?: string; availableModels?: { modelId: string }[] } | undefined
  const modes = result.modes as { availableModes?: { id: string }[] } | undefined
  const cfg: SessionConfig = {
    sessionId: result.sessionId as string,
    currentModelId: models?.currentModelId ?? null,
    availableModelIds: (models?.availableModels ?? []).map((m) => m.modelId),
    hasChatMode: (modes?.availableModes ?? []).some((m) => m.id === 'chat'),
  }
  dumpJson('session config', cfg)
  return cfg
}

/** Classify a single `session/prompt` outcome for a given image block. */
type Outcome =
  | { kind: 'success'; answer: string; stopReason: unknown }
  | { kind: 'invalid-image' } // -31007: shape RIGHT, data rejected
  | { kind: 'unsupported' } // -31008: shape right, model can't do images
  | { kind: 'bad-shape'; code: number | null } // -32602 / other: block unrecognized
  | { kind: 'unauth' }

async function tryImageBlock(
  client: AcpClient,
  sink: AnswerSink,
  sessionId: string,
  idleMs: number,
  block: unknown,
): Promise<Outcome> {
  sink.taken() // clear any residue
  try {
    const res = await withTimeout(
      client.request('session/prompt', { sessionId, prompt: [block, { type: 'text', text: VISION_QUESTION }] }),
      TIMEOUT.prompt,
      'session/prompt',
    )
    await sleep(idleMs)
    return { kind: 'success', answer: sink.taken().trim(), stopReason: (res as { stopReason?: unknown })?.stopReason ?? null }
  } catch (err) {
    const code = isRpcError(err) ? err.code : null
    log(`  => FAILED  ${describeError(err)}`)
    if (code === -31007) return { kind: 'invalid-image' }
    if (code === -31008) return { kind: 'unsupported' }
    if (code === -32000) return { kind: 'unauth' }
    return { kind: 'bad-shape', code }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log('spike-image-block — verify vibe-acp session/prompt image content-block shape. Flags: --cwd --command --idle-ms')
    return
  }
  mkdirSync(args.cwd, { recursive: true })
  log(`cwd=${args.cwd}  command=${args.command}  idleMs=${args.idleMs}`)

  const imageB64 = solidPngBase64(IMAGE_SIZE, IMAGE_RGB)
  log(`generated ${IMAGE_SIZE}x${IMAGE_SIZE} ${IMAGE_COLOUR_NAME} PNG — ${imageB64.length} base64 chars`)

  const sink = new AnswerSink()
  const client = startClient(args, sink)
  await initialize(client)
  const cfg = await newSession(client, args.cwd)
  const sid = cfg.sessionId

  // Safety: switch to read-only `chat` so a prompt can never touch the workspace.
  if (cfg.hasChatMode) {
    try {
      await withTimeout(client.request('session/set_mode', { sessionId: sid, modeId: 'chat' }), TIMEOUT.setOption, 'session/set_mode')
      log('set mode → chat (read-only) for safety')
    } catch (err) {
      log(`set_mode chat failed (continuing): ${describeError(err)}`)
    }
  }

  // Candidate image blocks, ACP-standard first. Each is a distinct hypothesis for the
  // field names; -32602 rules a shape out, -31007/-31008/success rule it IN.
  const dataUri = `data:image/png;base64,${imageB64}`
  const candidates: { label: string; block: Record<string, unknown> }[] = [
    { label: 'A: ACP/MCP standard {type:image, data, mimeType}', block: { type: 'image', data: imageB64, mimeType: 'image/png' } },
    { label: 'B: snake_case {type:image, data, mime_type}', block: { type: 'image', data: imageB64, mime_type: 'image/png' } },
    { label: 'C: nested source {type:image, source:{type:base64, media_type, data}}', block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } } },
    { label: 'D: data-URI {type:image, uri}', block: { type: 'image', uri: dataUri } },
    { label: 'E: resource_link {type:resource_link, uri, mimeType}', block: { type: 'resource_link', uri: dataUri, mimeType: 'image/png' } },
  ]

  // -31008 (model can't do images) is raised BEFORE the block reaches the model, so a
  // model that can't see images tells us nothing about whether the shape delivers pixels.
  // Structural acceptance (attachment counted, no -32602) is necessary but NOT sufficient
  // — shape A was accepted yet the model answered "I cannot see images". The ONLY real
  // acceptance test is: on an image-CAPABLE model, does the answer NAME the colour? So we
  // (Phase 1) find a model that doesn't -31008 on the standard block, then (Phase 2) sweep
  // EVERY candidate shape on it and check the colour round-trip.
  async function setModel(modelId: string): Promise<boolean> {
    try {
      await withTimeout(client.request('session/set_model', { sessionId: sid, modelId }), TIMEOUT.setOption, 'session/set_model')
      return true
    } catch (err) {
      log(`  set_model ${modelId} failed: ${describeError(err)}`)
      return false
    }
  }

  banner('Phase 1 — find an image-accepting model (standard shape A)')
  const shapeA = candidates[0].block
  const modelOrder = [cfg.currentModelId, ...cfg.availableModelIds.filter((m) => m !== cfg.currentModelId)].filter(
    (m): m is string => !!m,
  )
  let visionModel: string | null = null
  const modelVerdicts: Record<string, string> = {}
  for (const modelId of modelOrder) {
    if (!(await setModel(modelId))) {
      modelVerdicts[modelId] = 'set_model failed'
      continue
    }
    log(`\n--- ${modelId}: probe standard shape A`)
    const o = await tryImageBlock(client, sink, sid, args.idleMs, shapeA)
    if (o.kind === 'unauth') {
      log('  => -32000 unauthenticated mid-run. SIGN IN and retry. Exiting.')
      client.stop()
      process.exit(2)
    }
    if (o.kind === 'unsupported') {
      log(`  ${modelId}: -31008 — no image support`)
      modelVerdicts[modelId] = 'NO (-31008)'
      continue
    }
    // success / invalid-image / bad-shape all mean the model at least PARSED an image block.
    modelVerdicts[modelId] = `accepts image blocks (outcome=${o.kind})`
    log(`  ${modelId}: accepts image blocks (outcome=${o.kind}${o.kind === 'success' ? `, answer=${JSON.stringify(o.answer)}` : ''})`)
    visionModel = modelId
    break
  }

  banner('Phase 1 RESULT — model image support')
  for (const [modelId, verdict] of Object.entries(modelVerdicts)) log(`  ${modelId}: ${verdict}`)

  if (!visionModel) {
    banner('RESULT — INCONCLUSIVE')
    log('  No available model accepts image blocks (all -31008). The wire shape cannot be')
    log('  round-trip-verified on this account. availableModels: ' + cfg.availableModelIds.join(', '))
    client.stop()
    return
  }

  // Phase 2 — the real test. Sweep every candidate shape on the image-accepting model; a
  // block DELIVERS pixels only if the answer names the colour. Distinguishes "structurally
  // accepted but blind" (e.g. bare-base64) from a shape that actually reaches the model.
  banner(`Phase 2 — shape sweep on ${visionModel}: does the model NAME the colour "${IMAGE_COLOUR_NAME}"?`)
  await setModel(visionModel)
  const results: { label: string; verdict: string; delivers: boolean }[] = []
  for (const c of candidates) {
    log(`\n--- ${c.label}`)
    const o = await tryImageBlock(client, sink, sid, args.idleMs, c.block)
    let verdict: string
    let delivers = false
    if (o.kind === 'success') {
      delivers = o.answer.toLowerCase().includes(IMAGE_COLOUR_NAME)
      verdict = `success; answer=${JSON.stringify(o.answer)}; ${delivers ? 'NAMED COLOUR ✔ pixels delivered' : 'did NOT name colour ✘ accepted-but-blind'}`
    } else if (o.kind === 'invalid-image') {
      verdict = '-31007 invalid-image (shape recognised, data rejected)'
    } else if (o.kind === 'unsupported') {
      verdict = '-31008 (unexpected on this model)'
    } else if (o.kind === 'unauth') {
      verdict = '-32000 unauthenticated'
    } else {
      verdict = `rejected (bad-shape${o.code != null ? ` code=${o.code}` : ''}) — block unrecognised`
    }
    log(`  => ${verdict}`)
    results.push({ label: c.label, verdict, delivers })
  }

  banner(`RESULT — image block shapes on ${visionModel}`)
  for (const r of results) log(`  ${r.delivers ? '✔' : ' '} ${r.label}\n        ${r.verdict}`)
  const delivering = results.filter((r) => r.delivers)
  banner('VERDICT')
  if (delivering.length > 0) {
    log(`  Wire shape(s) that DELIVER pixels to ${visionModel}: ${delivering.map((r) => r.label).join('; ')}`)
    log('  → build the image attachment slice with the first of these.')
  } else {
    log(`  ${visionModel} PARSES image blocks (attachment counted, no -32602/-31008) but the model`)
    log('  did NOT name the colour for ANY candidate shape — "accepts-but-blind". Either this')
    log("  account's models lack true vision, or the delivery needs a shape we didn't try.")
    log('  Image attachments are wire-plumbable but NOT end-to-end verifiable on this account yet.')
  }

  banner('DONE')
  client.stop()
}

main()
  .then(() => setTimeout(() => process.exit(0), 300))
  .catch((err) => {
    console.error(`\nFATAL: ${describeError(err)}`)
    process.exit(1)
  })
