import { describe, it, expect } from 'vitest'
import { AUTH_HINT, SPAWN_HINT, WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'
import type { ChildProcessLike, SpawnFn } from './acp/client'

/**
 * Exercise the riskiest WorkspaceAgent logic with an injected fake child:
 * start() racing against early failure, and error classification. No real
 * vibe-acp.
 */

interface FakeChild {
  child: ChildProcessLike
  feed: (chunk: string) => void
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void
  emitError: (err: Error) => void
}

function makeFakeChild(): FakeChild {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const errorListeners: Array<(err: Error) => void> = []

  const child: ChildProcessLike = {
    stdout: {
      setEncoding: () => {},
      on: (_event, listener) => {
        stdoutListeners.push(listener)
      },
    },
    stderr: { setEncoding: () => {}, on: () => {} },
    stdin: { write: () => {} },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: 'error' | 'exit', listener: (...args: any[]) => void) => {
      if (event === 'exit') exitListeners.push(listener)
      else errorListeners.push(listener)
    },
    kill: () => {},
  }

  return {
    child,
    feed: (chunk) => stdoutListeners.forEach((l) => l(chunk)),
    emitExit: (code, signal = null) => exitListeners.forEach((l) => l(code, signal)),
    emitError: (err) => errorListeners.forEach((l) => l(err)),
  }
}

function makeAgent(fake: FakeChild): WorkspaceAgent {
  const spawnFn: SpawnFn = () => fake.child
  return new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: spawnFn })
}

/** Run start() and capture its rejection (or null on resolve). */
async function startAndCatch(agent: WorkspaceAgent): Promise<unknown> {
  return agent.start().then(
    () => null,
    (err) => err,
  )
}

describe('WorkspaceAgent.start()', () => {
  it('rejects with SPAWN_HINT when the process exits early', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent) // sends initialize, then awaits the race
    fake.emitExit(1)

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/exited before it was ready/)
    expect((err as WorkspaceAgentError).hint).toBe(SPAWN_HINT)
  })

  it('maps an ENOENT spawn error to a missing-binary message + SPAWN_HINT', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent)
    fake.emitError(Object.assign(new Error('spawn vibe-acp ENOENT'), { code: 'ENOENT' }))

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toBe('`vibe-acp` was not found on your PATH.')
    expect((err as WorkspaceAgentError).hint).toBe(SPAWN_HINT)
  })

  it('does NOT classify a generic (non--32000) initialize error as unauthenticated', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent)
    // A genuine non-auth failure (internal error). The discriminator is the
    // JSON-RPC code, not the message — so this must NOT read as not-signed-in.
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'internal error' },
      }) + '\n',
    )

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toBe('internal error')
    expect((err as WorkspaceAgentError).message).not.toMatch(/not signed in/i)
    expect((err as WorkspaceAgentError).hint).toBeNull()
  })

  it('classifies a -32000 error as unauthenticated + AUTH_HINT (by code, not message)', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent)
    // The real UnauthenticatedError message (docs/acp-capture.md §8) — which the
    // old "sign in / unauthenticated" regex would have MISSED. Code -32000 is
    // the reliable signal.
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'Missing API key for mistral provider.' },
      }) + '\n',
    )

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/not signed in/i)
    expect((err as WorkspaceAgentError).message).toContain('Missing API key for mistral provider.')
    expect((err as WorkspaceAgentError).hint).toBe(AUTH_HINT)
  })
})

// --- Auth detection over the wire (_auth/status) ----------------------------

/** Initialize result carrying the captured browser-auth method (acp-capture §1/§8). */
const INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentInfo: { name: '@mistralai/mistral-vibe', title: 'Mistral Vibe', version: '2.18.0' },
  authMethods: [
    {
      id: 'browser-auth',
      name: 'Sign in through Mistral AI Studio',
      description: 'Sign into Mistral Vibe through your Mistral AI Studio account.',
    },
  ],
}

/**
 * Drive start() to completion over a capturing fake, answering `initialize`
 * (id 1) then `_auth/status` (id 2) with the supplied status result. Returns the
 * ready agent so the test can read its detected `authState`.
 */
async function startWithAuthStatus(
  fake: CapturingFake,
  statusResult: Record<string, unknown>,
): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child })
  const started = agent.start()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT }) + '\n')
  // Let initialize resolve so the agent issues its _auth/status follow-up.
  await new Promise((r) => setTimeout(r, 0))
  const statusReq = sent(fake).find((m) => m.method === '_auth/status')
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: statusReq?.id, result: statusResult }) + '\n')
  await started
  return agent
}

describe('WorkspaceAgent — auth detection (_auth/status)', () => {
  it('queries _auth/status after initialize and reports not-signed-in when signed out', async () => {
    const fake = makeCapturingFake()
    const agent = await startWithAuthStatus(fake, {
      authenticated: false,
      authState: 'signed_out',
      signOutAvailable: false,
    })

    // The extension method is sent verbatim with its leading underscore.
    const statusReq = sent(fake).find((m) => m.method === '_auth/status')
    expect(statusReq).toBeDefined()
    expect(agent.authState).toBe('not-signed-in')
  })

  it('reports signed-in for an authenticated status and exposes the advertised authMethods', async () => {
    const fake = makeCapturingFake()
    const agent = await startWithAuthStatus(fake, {
      authenticated: true,
      authState: 'os_keyring',
      signOutAvailable: true,
    })

    expect(agent.authState).toBe('signed-in')
    // The sign-in method name the renderer renders comes from initialize.
    expect(agent.authMethods).toEqual([
      {
        id: 'browser-auth',
        name: 'Sign in through Mistral AI Studio',
        description: 'Sign into Mistral Vibe through your Mistral AI Studio account.',
      },
    ])
  })
})

// --- TB3: browser-auth-delegated sign-in ------------------------------------

interface InitParams {
  clientCapabilities?: { fs?: unknown; _meta?: Record<string, unknown> }
}

const DELEGATED = 'browser-auth-delegated'
const SIGN_IN_URL =
  'https://console.mistral.ai/codestral/cli/authenticate?process_id=fb067327-aaaa-bbbb-cccc-dddddddddddd'
const ATTEMPT_ID = 'fb067327-aaaa-bbbb-cccc-dddddddddddd'

interface AuthRpc {
  id?: number
  method?: string
  params?: { methodId?: string; action?: string; attemptId?: string }
}

function authSent(fake: CapturingFake): AuthRpc[] {
  return fake.writes.map((w) => JSON.parse(w) as AuthRpc).filter((m) => m.method === 'authenticate')
}

/** Drive start() to a ready, signed-out agent with an injected URL opener. */
async function connectSignedOut(
  fake: CapturingFake,
  openUrl: (url: string) => void,
): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child, openUrl })
  const started = agent.start()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: INITIALIZE_RESULT }) + '\n')
  await new Promise((r) => setTimeout(r, 0))
  fake.feed(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: false, authState: 'signed_out' } }) +
      '\n',
  )
  await started
  return agent
}

/** The delegated `start` response (acp-capture §8) — verbatim shape. */
function startResult(): unknown {
  return {
    _meta: { [DELEGATED]: { attemptId: ATTEMPT_ID, expiresAt: '2026-06-29T11:22:26Z', signInUrl: SIGN_IN_URL } },
  }
}

/** The delegated `complete` response (acp-capture §8). */
function completeResult(): unknown {
  return { _meta: { [DELEGATED]: { attemptId: ATTEMPT_ID, persistResult: 'completed', status: 'completed' } } }
}

describe('WorkspaceAgent — sign in (browser-auth-delegated)', () => {
  it('advertises the browser-auth-delegated capability in initialize', async () => {
    const fake = makeCapturingFake()
    await startWithAuthStatus(fake, { authenticated: false, authState: 'signed_out' })

    // The agent only offers the delegated method if we opt in via
    // clientCapabilities._meta (acp-capture §8).
    const init = fake.writes
      .map((w) => JSON.parse(w) as { method?: string; params?: InitParams })
      .find((m) => m.method === 'initialize')
    expect(init?.params?.clientCapabilities?._meta?.['browser-auth-delegated']).toBe(true)
  })

  it('runs start → open URL → complete → re-detect and resolves signed-in', async () => {
    const fake = makeCapturingFake()
    const opened: string[] = []
    const agent = await connectSignedOut(fake, (url) => opened.push(url))

    const signingIn = agent.signIn(DELEGATED)

    // start is sent immediately (non-blocking); answer it.
    await new Promise((r) => setTimeout(r, 0))
    const startReq = authSent(fake).find((m) => m.params?.action === 'start')
    expect(startReq?.params).toMatchObject({ methodId: DELEGATED, action: 'start' })
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: startReq?.id, result: startResult() }) + '\n')

    // The client opens the returned signInUrl, then long-polls `complete`.
    await new Promise((r) => setTimeout(r, 0))
    expect(opened).toEqual([SIGN_IN_URL])
    const completeReq = authSent(fake).find((m) => m.params?.action === 'complete')
    expect(completeReq?.params).toMatchObject({ methodId: DELEGATED, action: 'complete', attemptId: ATTEMPT_ID })
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: completeReq?.id, result: completeResult() }) + '\n')

    // After complete, it re-queries _auth/status to confirm signed-in.
    await new Promise((r) => setTimeout(r, 0))
    const statusReqs = sent(fake).filter((m) => m.method === '_auth/status')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: statusReqs[statusReqs.length - 1]?.id,
        result: { authenticated: true, authState: 'os_keyring', signOutAvailable: true },
      }) + '\n',
    )

    await expect(signingIn).resolves.toBe('signed-in')
    expect(agent.authState).toBe('signed-in')
  })

  it('rejects (recoverably) when complete fails for an expired/unknown attempt (-32602)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const signingIn = agent.signIn(DELEGATED)
    signingIn.catch(() => {}) // avoid an unhandled rejection before we assert

    await new Promise((r) => setTimeout(r, 0))
    const startReq = authSent(fake).find((m) => m.params?.action === 'start')
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: startReq?.id, result: startResult() }) + '\n')

    await new Promise((r) => setTimeout(r, 0))
    const completeReq = authSent(fake).find((m) => m.params?.action === 'complete')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: completeReq?.id,
        error: { code: -32602, message: 'Invalid request' },
      }) + '\n',
    )

    await expect(signingIn).rejects.toBeInstanceOf(WorkspaceAgentError)
    // The failure leaves auth state untouched (still signed-out) — never wedged.
    expect(agent.authState).toBe('not-signed-in')
  })

  it('rejects when the process exits mid sign-in (no wedge)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const signingIn = agent.signIn(DELEGATED)
    signingIn.catch(() => {})

    // Die while `start` is still in flight.
    fake.emitExit(1)

    await expect(signingIn).rejects.toBeInstanceOf(WorkspaceAgentError)
  })

  it('fails fast with a clear message when start returns no attemptId (sends no complete)', async () => {
    const fake = makeCapturingFake()
    const opened: string[] = []
    const agent = await connectSignedOut(fake, (url) => opened.push(url))

    const signingIn = agent.signIn(DELEGATED)
    const settled = signingIn.catch((e: unknown) => e)

    await new Promise((r) => setTimeout(r, 0))
    const startReq = authSent(fake).find((m) => m.params?.action === 'start')
    // Misshaped start result: no `_meta`, so no attemptId.
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: startReq?.id, result: {} }) + '\n')

    const err = await settled
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/could not start/i)
    // No doomed `complete` with attemptId:undefined, and the browser never opened.
    expect(authSent(fake).some((m) => m.params?.action === 'complete')).toBe(false)
    expect(opened).toEqual([])
  })

  it('rejects a non-delegated methodId with a clear message (no requests sent)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const err = await agent.signIn('browser-auth').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/delegated/i)
    // It never round-trips delegated-shaped requests to the blocking method.
    expect(authSent(fake)).toEqual([])
  })
})

// --- TB2: prompt + fs/read serving (a writes-capturing fake) ----------------

interface CapturingFake extends FakeChild {
  writes: string[]
}

function makeCapturingFake(): CapturingFake {
  const stdoutListeners: Array<(chunk: string) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const errorListeners: Array<(err: Error) => void> = []
  const writes: string[] = []
  const child: ChildProcessLike = {
    stdout: {
      setEncoding: () => {},
      on: (_event, listener) => {
        stdoutListeners.push(listener)
      },
    },
    stderr: { setEncoding: () => {}, on: () => {} },
    stdin: {
      write: (data) => {
        writes.push(data)
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: 'error' | 'exit', listener: (...args: any[]) => void) => {
      if (event === 'exit') exitListeners.push(listener)
      else errorListeners.push(listener)
    },
    kill: () => {},
  }
  return {
    child,
    writes,
    feed: (chunk) => stdoutListeners.forEach((l) => l(chunk)),
    emitExit: (code, signal = null) => exitListeners.forEach((l) => l(code, signal)),
    emitError: (err) => errorListeners.forEach((l) => l(err)),
  }
}

interface SentRpc {
  id?: number
  method?: string
  params?: { sessionId?: string; prompt?: Array<{ type: string; text: string }> }
  result?: { content?: string; outcome?: { outcome?: string; optionId?: string } } | Record<string, never>
  error?: { code?: number; message?: string }
}

function sent(fake: CapturingFake): SentRpc[] {
  return fake.writes.map((w) => JSON.parse(w) as SentRpc)
}

const SESSION_ID = '8b7044cf-19d1-7a23-8da1-929c81b23170'

/** Drive start() + openThread() to a ready agent over the capturing fake. */
async function connect(
  fake: CapturingFake,
  readTextFile?: (path: string) => Promise<string>,
): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({
    workspaceDir: '/abs/workspace',
    spawn: () => fake.child,
    readTextFile,
  })
  const started = agent.start()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n')
  // start() now follows initialize with an _auth/status query (id 2); answer
  // signed-in so the connect flow proceeds. session/new is therefore id 3.
  await new Promise((r) => setTimeout(r, 0))
  fake.feed(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) +
      '\n',
  )
  await started
  const opened = agent.openThread()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: SESSION_ID } }) + '\n')
  await opened
  return agent
}

describe('WorkspaceAgent.prompt()', () => {
  it('sends session/prompt with the ACP prompt shape and resolves on the turn response', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const turn = agent.prompt(SESSION_ID, 'read the readme')
    const promptReq = sent(fake).find((m) => m.method === 'session/prompt')
    expect(promptReq).toBeDefined()
    expect(promptReq?.params?.sessionId).toBe(SESSION_ID)
    expect(promptReq?.params?.prompt).toEqual([{ type: 'text', text: 'read the readme' }])

    // The session/prompt response (id 3) ends the turn.
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptReq?.id,
        result: { stopReason: 'end_turn', usage: { totalTokens: 21047 }, userMessageId: 'u1' },
      }) + '\n',
    )
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('rejects when prompting an unknown sessionId', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    await expect(agent.prompt('nope', 'hi')).rejects.toBeInstanceOf(WorkspaceAgentError)
  })

  it('serves an fs/read_text_file server request by replying {content}', async () => {
    const fake = makeCapturingFake()
    await connect(fake, async () => 'file body')

    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'fs/read_text_file',
        params: { path: '/abs/file.ts', limit: 2001, sessionId: SESSION_ID },
      }) + '\n',
    )
    // Let the async read + respond settle.
    await new Promise((r) => setTimeout(r, 0))

    const reply = sent(fake).find((m) => m.id === 0 && m.result !== undefined)
    expect(reply?.result).toEqual({ content: 'file body' })
  })
})

// --- TB3: fs/write serving + permission responder ---------------------------

/** Drive a ready agent over the capturing fake, with an injected writer. */
async function connectWriting(
  fake: CapturingFake,
  writeTextFile: (path: string, content: string) => Promise<void>,
): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({
    workspaceDir: '/abs/workspace',
    spawn: () => fake.child,
    writeTextFile,
  })
  const started = agent.start()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n')
  // start() follows initialize with an _auth/status query (id 2); session/new is id 3.
  await new Promise((r) => setTimeout(r, 0))
  fake.feed(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) +
      '\n',
  )
  await started
  const opened = agent.openThread()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: SESSION_ID } }) + '\n')
  await opened
  return agent
}

describe('WorkspaceAgent — write + permission (TB3)', () => {
  it('serves an in-Workspace fs/write_text_file by writing and replying {}', async () => {
    const fake = makeCapturingFake()
    const writes: Array<{ path: string; content: string }> = []
    await connectWriting(fake, async (path, content) => {
      writes.push({ path, content })
    })

    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'fs/write_text_file',
        params: { path: '/abs/workspace/note.txt', content: 'hi', sessionId: SESSION_ID },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(writes).toEqual([{ path: '/abs/workspace/note.txt', content: 'hi' }])
    const reply = sent(fake).find((m) => m.id === 0 && m.result !== undefined)
    expect(reply?.result).toEqual({})
  })

  it('rejects an out-of-Workspace fs/write with a JSON-RPC error and no write', async () => {
    const fake = makeCapturingFake()
    let wrote = false
    await connectWriting(fake, async () => {
      wrote = true
    })

    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'fs/write_text_file',
        params: { path: '/etc/passwd', content: 'pwned', sessionId: SESSION_ID },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 0))

    expect(wrote).toBe(false)
    const reply = sent(fake).find((m) => m.id === 0 && m.error !== undefined)
    expect(reply?.error?.code).toBe(-32602)
  })

  it('respondPermission answers by request id with {outcome:{outcome:"selected",optionId}}', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWriting(fake, async () => {})

    // The agent's request id is in its own namespace (starts at 0); echo it back.
    agent.respondPermission(0, 'allow_once')

    const reply = sent(fake).find((m) => m.id === 0 && m.result !== undefined)
    expect(reply?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
  })
})
