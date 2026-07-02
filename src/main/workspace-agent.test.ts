import { describe, it, expect } from 'vitest'
import {
  AUTH_HINT,
  SessionLoadError,
  SPAWN_HINT,
  WorkspaceAgent,
  WorkspaceAgentError,
} from './workspace-agent'
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

  it('surfaces signOutAvailable from _auth/status (gates the sign-out control)', async () => {
    const fakeIn = makeCapturingFake()
    const signedIn = await startWithAuthStatus(fakeIn, {
      authenticated: true,
      authState: 'os_keyring',
      signOutAvailable: true,
    })
    expect(signedIn.signOutAvailable).toBe(true)

    const fakeOut = makeCapturingFake()
    const signedOut = await startWithAuthStatus(fakeOut, {
      authenticated: false,
      authState: 'signed_out',
      signOutAvailable: false,
    })
    expect(signedOut.signOutAvailable).toBe(false)
  })
})

describe('WorkspaceAgent.refreshAuthStatus() (#79)', () => {
  it('re-queries _auth/status and folds signed_out → signed-in (observe, no re-sign-in)', async () => {
    const fake = makeCapturingFake()
    const agent = await startWithAuthStatus(fake, {
      authenticated: false,
      authState: 'signed_out',
      signOutAvailable: false,
    })
    expect(agent.authState).toBe('not-signed-in')

    // Simulates an out-of-band `vibe` CLI sign-in: a fresh _auth/status now reports
    // authenticated, with no `authenticate` round-trip in between.
    const refreshed = agent.refreshAuthStatus()
    await new Promise((r) => setTimeout(r, 0))
    const statusReqs = sent(fake).filter((m) => m.method === '_auth/status')
    // No sign-in flow was driven — only the start-time detect + this re-check.
    expect(statusReqs.length).toBe(2)
    expect(sent(fake).some((m) => m.method === 'authenticate')).toBe(false)
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: statusReqs[statusReqs.length - 1]?.id,
        result: { authenticated: true, authState: 'os_keyring', signOutAvailable: true },
      }) + '\n',
    )

    expect(await refreshed).toBe('signed-in')
    expect(agent.authState).toBe('signed-in')
    expect(agent.signOutAvailable).toBe(true)
  })

  it('rejects (no wedge) when the re-query fails', async () => {
    const fake = makeCapturingFake()
    const agent = await startWithAuthStatus(fake, {
      authenticated: false,
      authState: 'signed_out',
      signOutAvailable: false,
    })

    const refreshed = agent.refreshAuthStatus()
    const settled = refreshed.catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 0))
    const statusReqs = sent(fake).filter((m) => m.method === '_auth/status')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: statusReqs[statusReqs.length - 1]?.id,
        error: { code: -32603, message: 'internal' },
      }) + '\n',
    )

    await settled
    // The failed re-check leaves the cached state untouched — never wedged.
    expect(agent.authState).toBe('not-signed-in')
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

  it('rejects (recoverably) when complete reports an in-band persist failure', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const signingIn = agent.signIn(DELEGATED)
    signingIn.catch(() => {}) // avoid an unhandled rejection before we assert

    await new Promise((r) => setTimeout(r, 0))
    const startReq = authSent(fake).find((m) => m.params?.action === 'start')
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: startReq?.id, result: startResult() }) + '\n')

    await new Promise((r) => setTimeout(r, 0))
    const completeReq = authSent(fake).find((m) => m.params?.action === 'complete')
    // Vibe reports a failed credential save IN-BAND: `status:"completed"` with a
    // persistResult error and NO JSON-RPC error (api_key_persistence.py). The
    // browser said "signed in" but nothing reached env/keyring — swallowing this
    // (the pre-fix behavior) strands the user at a vague "did not complete".
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: completeReq?.id,
        result: {
          _meta: {
            [DELEGATED]: {
              attemptId: ATTEMPT_ID,
              persistResult: 'env_var_error:MISTRAL_API_KEY',
              status: 'completed',
            },
          },
        },
      }) + '\n',
    )

    const err = await signingIn.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toContain('could not save the credential')
    expect((err as WorkspaceAgentError).message).toContain('env_var_error:MISTRAL_API_KEY')
    expect((err as WorkspaceAgentError).hint).toBe(AUTH_HINT)
    // No _auth/status round-trip after a failed persist — state stays signed-out.
    expect(agent.authState).toBe('not-signed-in')
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
        // Vibe's real reason for a lapsed poll window (browser_sign_in.py: TIMED_OUT),
        // surfaced as InvalidRequestError(-32602).
        error: { code: -32602, message: 'Browser sign-in timed out.' },
      }) + '\n',
    )

    const err = await signingIn.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    // Vibe's specific reason AND the JSON-RPC code are preserved (not collapsed into
    // a generic "Sign-in failed") — the whole point of #76 part A.
    expect((err as WorkspaceAgentError).message).toMatch(/Browser sign-in timed out\./)
    expect((err as WorkspaceAgentError).message).toContain('(code -32602)')
    expect((err as WorkspaceAgentError).code).toBe(-32602)
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

  it('rejects an unsupported methodId with a clear message (no requests sent)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    // Neither captured method (browser-auth-delegated / browser-auth): refused
    // up front so we never send a request the agent can't service.
    const err = await agent.signIn('api-key').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/not supported/i)
    expect(authSent(fake)).toEqual([])
  })
})

// --- #17: browser-auth blocking fallback ------------------------------------

const BLOCKING = 'browser-auth'

/** The blocking `browser-auth` success response (acp-capture §8) — verbatim. */
function blockingResult(): unknown {
  return { _meta: { [BLOCKING]: { persistResult: 'completed', status: 'completed' } } }
}

describe('WorkspaceAgent — sign in (browser-auth blocking fallback)', () => {
  it('sends a single blocking authenticate({methodId:"browser-auth"}) then re-queries status → signed-in', async () => {
    const fake = makeCapturingFake()
    const opened: string[] = []
    const agent = await connectSignedOut(fake, (url) => opened.push(url))

    const signingIn = agent.signIn(BLOCKING)

    // A single blocking authenticate is sent immediately; the AGENT opens the
    // browser and blocks until the user finishes.
    await new Promise((r) => setTimeout(r, 0))
    const authReqs = authSent(fake)
    expect(authReqs).toHaveLength(1)
    // ONLY the methodId crosses the wire — no delegated-shaped action/attemptId.
    expect(authReqs[0]?.params).toEqual({ methodId: BLOCKING })
    expect(authReqs[0]?.params?.action).toBeUndefined()
    expect(authReqs[0]?.params?.attemptId).toBeUndefined()
    // The agent drives its own browser — the client never opens a URL here.
    expect(opened).toEqual([])

    // The agent unblocks with the captured success meta (we discard it — ADR-0003).
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: authReqs[0]?.id, result: blockingResult() }) + '\n')

    // It then re-queries _auth/status to confirm signed-in.
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

  it('rejects (recoverably) when the blocking authenticate fails — no wedge', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const signingIn = agent.signIn(BLOCKING)
    signingIn.catch(() => {}) // avoid an unhandled rejection before we assert

    await new Promise((r) => setTimeout(r, 0))
    const authReq = authSent(fake)[0]
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: authReq?.id,
        error: { code: -32603, message: 'browser flow failed' },
      }) + '\n',
    )

    await expect(signingIn).rejects.toBeInstanceOf(WorkspaceAgentError)
    // The failure leaves auth state untouched (still signed-out) — never wedged,
    // and it never re-queries status after the failed authenticate.
    expect(agent.authState).toBe('not-signed-in')
    expect(sent(fake).some((m) => m.method === '_auth/status' && m.id! > authReq!.id!)).toBe(false)
  })

  it('rejects when the process exits while the blocking authenticate is in flight (no wedge)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedOut(fake, () => {})

    const signingIn = agent.signIn(BLOCKING)
    signingIn.catch(() => {})

    // The blocking call can't be cancelled over ACP; its no-wedge property
    // relies on AcpClient.rejectAllPending firing on `exit`. Die mid-flight.
    await new Promise((r) => setTimeout(r, 0))
    expect(authSent(fake)).toHaveLength(1)
    fake.emitExit(1)

    await expect(signingIn).rejects.toBeInstanceOf(WorkspaceAgentError)
  })
})

/** Drive start() to a ready, signed-in agent (signOut available). */
async function connectSignedIn(fake: CapturingFake): Promise<WorkspaceAgent> {
  return startWithAuthStatus(fake, {
    authenticated: true,
    authState: 'os_keyring',
    signOutAvailable: true,
  })
}

describe('WorkspaceAgent — mid-session expiry (-32000)', () => {
  it('tags an openThread -32000 as not-signed-in and flips the cached auth state', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedIn(fake)
    expect(agent.authState).toBe('signed-in')

    const opening = agent.openThread()
    const settled = opening.catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 0))
    const sessReq = sent(fake).find((m) => m.method === 'session/new')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: sessReq?.id,
        error: { code: -32000, message: 'Missing API key for mistral provider.' },
      }) + '\n',
    )

    const err = await settled
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).authState).toBe('not-signed-in')
    // Expiry detected: the agent now reports not-signed-in so the caller can
    // keep it alive and route to the sign-in panel.
    expect(agent.authState).toBe('not-signed-in')
  })

  it('tags a prompt -32000 (turn expiry) as not-signed-in without killing the agent', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const turn = agent.prompt(SESSION_ID, 'hi')
    const settled = turn.catch((e: unknown) => e)
    const promptReq = sent(fake).find((m) => m.method === 'session/prompt')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptReq?.id,
        error: { code: -32000, message: 'Missing API key for mistral provider.' },
      }) + '\n',
    )

    const err = await settled
    expect((err as WorkspaceAgentError).authState).toBe('not-signed-in')
    expect(agent.authState).toBe('not-signed-in')
  })
})

describe('WorkspaceAgent — sign out (_auth/signOut)', () => {
  it('sends _auth/signOut, re-queries status, and transitions signed-in → not-signed-in', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedIn(fake)

    const out = agent.signOut()

    await new Promise((r) => setTimeout(r, 0))
    const signOutReq = sent(fake).find((m) => m.method === '_auth/signOut')
    expect(signOutReq).toBeDefined() // extension method, leading underscore on the wire
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: signOutReq?.id, result: {} }) + '\n')

    await new Promise((r) => setTimeout(r, 0))
    const statusReqs = sent(fake).filter((m) => m.method === '_auth/status')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: statusReqs[statusReqs.length - 1]?.id,
        result: { authenticated: false, authState: 'signed_out', signOutAvailable: false },
      }) + '\n',
    )

    await expect(out).resolves.toBe('not-signed-in')
    expect(agent.authState).toBe('not-signed-in')
    expect(agent.signOutAvailable).toBe(false)
  })

  it('refuses (and sends nothing) when signOutAvailable is false', async () => {
    const fake = makeCapturingFake()
    const agent = await startWithAuthStatus(fake, {
      authenticated: true,
      authState: 'os_keyring',
      signOutAvailable: false,
    })

    const err = await agent.signOut().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/not available/i)
    expect(sent(fake).some((m) => m.method === '_auth/signOut')).toBe(false)
  })

  it('rejects with a clear message when the keyring removal fails (-32603)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectSignedIn(fake)

    const out = agent.signOut()
    const settled = out.catch((e: unknown) => e)

    await new Promise((r) => setTimeout(r, 0))
    const signOutReq = sent(fake).find((m) => m.method === '_auth/signOut')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: signOutReq?.id,
        error: { code: -32603, message: 'keyring error' },
      }) + '\n',
    )

    const err = await settled
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/sign-out failed/i)
    // Preserves the keyring reason + code (#76 part A), not a bare "Sign-out failed".
    expect((err as WorkspaceAgentError).message).toContain('keyring error')
    expect((err as WorkspaceAgentError).message).toContain('(code -32603)')
    expect((err as WorkspaceAgentError).code).toBe(-32603)
    // Failed sign-out leaves the session signed-in — never wedged.
    expect(agent.authState).toBe('signed-in')
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
  params?: {
    sessionId?: string
    prompt?: Array<{ type: string; text: string }>
    // Agent-control setters (#66): the per-axis params.
    modeId?: string
    modelId?: string
    configId?: string
    value?: string
  }
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

describe('WorkspaceAgent.setTitle() (rename sync)', () => {
  it('sends the _session/set_title EXT method with { sessionId, title } and resolves on {}', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const renaming = agent.setTitle(SESSION_ID, 'Refactor auth')
    const req = sent(fake).find((m) => m.method === '_session/set_title')
    expect(req).toBeDefined()
    expect(req?.params?.sessionId).toBe(SESSION_ID)
    expect((req?.params as { title?: string }).title).toBe('Refactor auth')

    // Agent acks with an empty result — the sync resolves (best-effort at the caller).
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await expect(renaming).resolves.toBeUndefined()
  })

  it('maps an error result to a WorkspaceAgentError (so the handler can log it)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const renaming = agent.setTitle(SESSION_ID, 'x').catch((e: unknown) => e)
    const req = sent(fake).find((m) => m.method === '_session/set_title')
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: req?.id, error: { code: -32602, message: 'bad' } }) + '\n',
    )
    expect(await renaming).toBeInstanceOf(WorkspaceAgentError)
  })
})

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

  it('prepends image blocks with snake_case mime_type + bare base64 before the text block (#100)', () => {
    const fake = makeCapturingFake()
    return connect(fake).then((agent) => {
      void agent.prompt(SESSION_ID, 'what is this?', [
        { data: 'aGVsbG8=', mimeType: 'image/png' },
        { data: '/9j/4AAQ', mimeType: 'image/jpeg' },
      ])
      const promptReq = sent(fake).find((m) => m.method === 'session/prompt')
      // acp-capture §11: field is snake_case `mime_type` with BARE base64 in `data`
      // (the ACP-conventional camelCase `mimeType` is silently accepted but leaves
      // the model blind). Image blocks come BEFORE the text block.
      expect(promptReq?.params?.prompt).toEqual([
        { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
        { type: 'image', data: '/9j/4AAQ', mime_type: 'image/jpeg' },
        { type: 'text', text: 'what is this?' },
      ])
    })
  })

  it('rejects when prompting an unknown sessionId', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    await expect(agent.prompt('nope', 'hi')).rejects.toBeInstanceOf(WorkspaceAgentError)
  })

  it('preserves a non-auth app code (e.g. -31008 images-unsupported) on the error (#100)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const turn = agent.prompt(SESSION_ID, 'what is this?', [{ data: 'aGk=', mimeType: 'image/png' }])
    const promptReq = sent(fake).find((m) => m.method === 'session/prompt')
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: promptReq?.id,
        error: { code: -31008, message: 'Model `devstral-small` does not support images. Switch model…' },
      }) + '\n',
    )
    const err = await turn.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    // The renderer special-cases this code into a "switch to a vision model" hint.
    expect((err as WorkspaceAgentError).code).toBe(-31008)
    expect((err as WorkspaceAgentError).authState).toBeNull()
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

  it('cancel() writes a `session/cancel` NOTIFICATION (no id) with {sessionId} (#103)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    agent.cancel(SESSION_ID)

    const cancel = sent(fake).find((m) => m.method === 'session/cancel')
    expect(cancel).toBeDefined()
    expect(cancel?.params?.sessionId).toBe(SESSION_ID)
    // It's a NOTIFICATION (acp-capture §12) — no JSON-RPC id, no response expected.
    expect(cancel?.id).toBeUndefined()
  })
})

// --- TB6: best-effort session close (#35) -----------------------------------

/**
 * Drive start() + openThread() to a ready agent whose `initialize` advertises
 * (or omits) the `sessionCapabilities.close` capability — the gate `closeSession`
 * checks before sending `session/close`.
 */
async function connectWithCaps(fake: CapturingFake, advertiseClose: boolean): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child })
  const started = agent.start()
  fake.feed(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: advertiseClose ? { sessionCapabilities: { close: {}, fork: {}, list: {} } } : {},
      },
    }) + '\n',
  )
  await new Promise((r) => setTimeout(r, 0))
  fake.feed(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) + '\n',
  )
  await started
  const opened = agent.openThread()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: SESSION_ID } }) + '\n')
  await opened
  return agent
}

describe('WorkspaceAgent.closeSession() (TB6 #35)', () => {
  it('sends session/close for a live session when the agent advertises the capability', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, true)

    const closing = agent.closeSession(SESSION_ID)
    const closeReq = sent(fake).find((m) => m.method === 'session/close')
    expect(closeReq).toBeDefined()
    expect(closeReq?.params?.sessionId).toBe(SESSION_ID)

    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: closeReq?.id, result: {} }) + '\n')
    await expect(closing).resolves.toBeUndefined()
  })

  it('is a no-op for an UNKNOWN session (no live Thread to close)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, true)

    await expect(agent.closeSession('no-such-session')).resolves.toBeUndefined()
    expect(sent(fake).some((m) => m.method === 'session/close')).toBe(false)
  })

  it('does NOT send session/close when the agent never advertised the capability', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, false)

    await expect(agent.closeSession(SESSION_ID)).resolves.toBeUndefined()
    expect(sent(fake).some((m) => m.method === 'session/close')).toBe(false)
  })

  it('swallows a session/close error (best-effort — never blocks deletion)', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, true)

    const closing = agent.closeSession(SESSION_ID)
    const closeReq = sent(fake).find((m) => m.method === 'session/close')
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: closeReq?.id, error: { code: -32603, message: 'boom' } }) + '\n',
    )
    await expect(closing).resolves.toBeUndefined()
  })
})

// --- TB5: graceful disposal on eviction (#50) -------------------------------

describe('WorkspaceAgent.disposeGracefully() (TB5 #50)', () => {
  it('best-effort closes EACH hosted session (where advertised) THEN terminates', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, true) // hosts SESSION_ID, close advertised

    const disposing = agent.disposeGracefully()
    await new Promise((r) => setTimeout(r, 0))
    const closeReq = sent(fake).find((m) => m.method === 'session/close')
    expect(closeReq?.params?.sessionId).toBe(SESSION_ID) // close attempted first
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: closeReq?.id, result: {} }) + '\n')

    await expect(disposing).resolves.toBeUndefined()
    // THEN terminated: the session is no longer hosted and the agent is stopped
    // (an uninitialized agent rejects further work).
    expect(agent.hasSession(SESSION_ID)).toBe(false)
    await expect(agent.prompt(SESSION_ID, 'x')).rejects.toThrow(/not initialized/i)
  })

  it('terminates WITHOUT sending session/close when the capability is not advertised', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, false) // hosts SESSION_ID, NO close capability

    await expect(agent.disposeGracefully()).resolves.toBeUndefined()

    expect(sent(fake).some((m) => m.method === 'session/close')).toBe(false)
    expect(agent.hasSession(SESSION_ID)).toBe(false) // still terminated
  })

  it('never rejects, and still terminates, when a session/close errors', async () => {
    const fake = makeCapturingFake()
    const agent = await connectWithCaps(fake, true)

    const disposing = agent.disposeGracefully()
    await new Promise((r) => setTimeout(r, 0))
    const closeReq = sent(fake).find((m) => m.method === 'session/close')
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: closeReq?.id, error: { code: -32603, message: 'boom' } }) + '\n',
    )

    await expect(disposing).resolves.toBeUndefined() // swallowed — terminate runs in finally
    expect(agent.hasSession(SESSION_ID)).toBe(false)
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

/**
 * Yield the event loop until `done()` is true or a tick budget runs out. Write
 * confinement (ADR-0004) is symlink-resolved, so serving a write now performs
 * several sequential `realpath` round-trips that settle over multiple event-loop
 * ticks — a single `setTimeout(0)` is racy. Poll the observable outcome instead.
 */
async function waitFor(done: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !done(); i++) await new Promise((r) => setTimeout(r, 0))
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
    await waitFor(() => writes.length > 0)

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
    await waitFor(() => sent(fake).some((m) => m.id === 0 && m.error !== undefined))

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

// --- TB4: session/load resume + replay suppression (#33) ---------------------

/** A session id NOT opened by `connect` — the agent must `session/load` to host it. */
const LOAD_SESSION_ID = 'aaaa1111-bbbb-2222-cccc-333344445555'

/** A `session/update` notification for a session (a replayed-history chunk). */
function sessionUpdate(sessionId: string): string {
  return (
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replay' }, messageId: 'a1' },
      },
    }) + '\n'
  )
}

/** Whether an emitted `event` payload is a `session/update` notification. */
function isSessionUpdate(e: unknown): boolean {
  return (e as { method?: string } | null)?.method === 'session/update'
}

/** The `session/load` request the agent sent, parsed loosely (cwd/mcpServers). */
function loadRequest(fake: CapturingFake): { id?: number; params?: { sessionId?: string; cwd?: string; mcpServers?: unknown[] } } | undefined {
  return fake.writes
    .map((w) => JSON.parse(w) as { id?: number; method?: string; params?: { sessionId?: string; cwd?: string; mcpServers?: unknown[] } })
    .find((m) => m.method === 'session/load')
}

/** Drive a ready agent whose initialize advertises (or omits) `loadSession`. */
async function connectWithLoadSession(fake: CapturingFake, advertise: boolean): Promise<WorkspaceAgent> {
  const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child })
  const started = agent.start()
  fake.feed(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: advertise ? { loadSession: true } : {} },
    }) + '\n',
  )
  await new Promise((r) => setTimeout(r, 0))
  fake.feed(
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) + '\n',
  )
  await started
  return agent
}

describe('WorkspaceAgent.loadThread() — resume (TB4 #33)', () => {
  it('sends session/load {sessionId,cwd,mcpServers:[]}, registers the session, and resolves to its info', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    expect(agent.hasSession(LOAD_SESSION_ID)).toBe(false)

    const loading = agent.loadThread(LOAD_SESSION_ID)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)
    expect(req?.params).toEqual({ sessionId: LOAD_SESSION_ID, cwd: '/abs/workspace', mcpServers: [] })

    // The result mirrors session/new but carries NO sessionId (acp-capture §9).
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: { modes: null, models: null } }) + '\n')
    const info = await loading
    expect(info.sessionId).toBe(LOAD_SESSION_ID) // kept the id we loaded
    expect(agent.hasSession(LOAD_SESSION_ID)).toBe(true) // now hosted -> next prompt reuses it
  })

  it('SUPPRESSES the wire-replayed session/update during load, then forwards live ones (no double history)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    const events: unknown[] = []
    agent.on('event', (e) => events.push(e))

    const loading = agent.loadThread(LOAD_SESSION_ID)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)

    // A replayed-history notification arrives BETWEEN the request and its result —
    // we already own this history in our JSONL, so it must NOT be emitted outward.
    fake.feed(sessionUpdate(LOAD_SESSION_ID))
    expect(events.filter(isSessionUpdate)).toHaveLength(0)

    // The result resolves (the "resume complete" signal) — the gate clears.
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await loading

    // A notification AFTER resume forwards normally (live streaming resumes).
    fake.feed(sessionUpdate(LOAD_SESSION_ID))
    expect(events.filter(isSessionUpdate)).toHaveLength(1)
  })

  it('does NOT suppress notifications for a DIFFERENT session while one is loading', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    const events: unknown[] = []
    agent.on('event', (e) => events.push(e))

    const loading = agent.loadThread(LOAD_SESSION_ID)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)

    // The gate is per-session: a sibling session's live event still flows through.
    fake.feed(sessionUpdate(SESSION_ID))
    expect(events.filter(isSessionUpdate)).toHaveLength(1)

    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await loading
  })

  it('DROPS a session/update with no usable sessionId DURING a load (fail-safe), then forwards it after', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)
    const events: unknown[] = []
    agent.on('event', (e) => events.push(e))

    // A malformed replay with no sessionId can't be attributed — drop it during the
    // load window rather than risk teeing it (which would double history).
    const noSessionUpdate =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' }, messageId: 'a1' } },
      }) + '\n'

    const loading = agent.loadThread(LOAD_SESSION_ID)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)
    fake.feed(noSessionUpdate)
    expect(events.filter(isSessionUpdate)).toHaveLength(0) // dropped during the load

    // Once the load settles (no load in flight), such a notification forwards again.
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await loading
    fake.feed(noSessionUpdate)
    expect(events.filter(isSessionUpdate)).toHaveLength(1)
  })

  it('rejects with SessionLoadError on -32602 "Session not found", leaves the session unhosted, and clears the gate', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const settled = agent.loadThread(LOAD_SESSION_ID).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req?.id,
        error: { code: -32602, message: 'Session not found: x', data: { session_id: 'x' } },
      }) + '\n',
    )

    const err = await settled
    expect(err).toBeInstanceOf(SessionLoadError)
    expect(agent.hasSession(LOAD_SESSION_ID)).toBe(false) // a failed resume hosts nothing

    // The suppression gate cleared on failure too — later notifications forward.
    const events: unknown[] = []
    agent.on('event', (e) => events.push(e))
    fake.feed(sessionUpdate(LOAD_SESSION_ID))
    expect(events.filter(isSessionUpdate)).toHaveLength(1)
  })

  it('maps a -32000 load failure to a not-signed-in WorkspaceAgentError (NOT a SessionLoadError)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const settled = agent.loadThread(LOAD_SESSION_ID).catch((e: unknown) => e)
    await new Promise((r) => setTimeout(r, 0))
    const req = loadRequest(fake)
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req?.id,
        error: { code: -32000, message: 'Missing API key for mistral provider.' },
      }) + '\n',
    )

    const err = await settled
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect(err).not.toBeInstanceOf(SessionLoadError)
    expect((err as WorkspaceAgentError).authState).toBe('not-signed-in')
    expect(agent.authState).toBe('not-signed-in') // flips so the caller routes to sign-in
  })

  it('reflects agentCapabilities.loadSession from initialize (gates the resume path)', async () => {
    const withCap = await connectWithLoadSession(makeCapturingFake(), true)
    expect(withCap.loadSessionAvailable).toBe(true)

    const withoutCap = await connectWithLoadSession(makeCapturingFake(), false)
    expect(withoutCap.loadSessionAvailable).toBe(false)
  })
})

// --- TB2: concurrent + idempotent start() (#47) -----------------------------

describe('WorkspaceAgent.start() — concurrent + idempotent (TB2 #47)', () => {
  it('shares ONE handshake across concurrent start() calls (child spawned once, no double-start throw)', async () => {
    const fake = makeCapturingFake()
    let spawns = 0
    const agent = new WorkspaceAgent({
      workspaceDir: '/abs/workspace',
      spawn: () => {
        spawns++
        return fake.child
      },
    })

    // Two starts race BEFORE the handshake completes — the bug: the warm pool
    // dedups the agent object, but without a shared in-flight start the second
    // hits `AcpClient.start()`'s "already started" throw and stops the child the
    // first is still handshaking on.
    const a = agent.start()
    const b = agent.start()

    // Drive the SINGLE handshake: initialize (id 1) then _auth/status (id 2).
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n')
    await new Promise((r) => setTimeout(r, 0))
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) + '\n',
    )

    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined])
    expect(spawns).toBe(1) // one child, not two
    expect(sent(fake).filter((m) => m.method === 'initialize')).toHaveLength(1) // one handshake

    // A post-success start() is a no-op: no second spawn, no second initialize.
    await agent.start()
    expect(spawns).toBe(1)
    expect(sent(fake).filter((m) => m.method === 'initialize')).toHaveLength(1)
  })
})

describe('WorkspaceAgent agent controls (#66, acp-capture §10)', () => {
  it('setMode sends session/set_mode {sessionId, modeId} and resolves on the {} result', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const change = agent.setMode(SESSION_ID, 'plan')
    const req = sent(fake).find((m) => m.method === 'session/set_mode')
    expect(req?.params).toEqual({ sessionId: SESSION_ID, modeId: 'plan' })

    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await expect(change).resolves.toBeUndefined()
  })

  it('setModel sends session/set_model {sessionId, modelId} (dedicated method, not set_config_option)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const change = agent.setModel(SESSION_ID, 'devstral-small')
    const req = sent(fake).find((m) => m.method === 'session/set_model')
    expect(req?.params).toEqual({ sessionId: SESSION_ID, modelId: 'devstral-small' })
    // Model has its OWN method — it does NOT flow through set_config_option.
    expect(sent(fake).some((m) => m.method === 'session/set_config_option')).toBe(false)

    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await expect(change).resolves.toBeUndefined()
  })

  it('setReasoningEffort sends session/set_config_option with configId:"thinking" (NOT id)', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const change = agent.setReasoningEffort(SESSION_ID, 'high')
    const req = sent(fake).find((m) => m.method === 'session/set_config_option')
    // The gotcha that cost real guesses: the key is `configId`, NOT `id`.
    expect(req?.params).toEqual({ sessionId: SESSION_ID, configId: 'thinking', value: 'high' })

    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: {} }) + '\n')
    await expect(change).resolves.toBeUndefined()
  })

  it('a setter rejects (mapped) when the agent errors, so the caller can revert', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    const change = agent.setMode(SESSION_ID, 'plan')
    const req = sent(fake).find((m) => m.method === 'session/set_mode')
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: req?.id, error: { code: -32602, message: 'Invalid params' } }) + '\n',
    )
    await expect(change).rejects.toThrow(/Invalid params/)
  })

  it('openThread surfaces the reasoning-effort axis from the thinking configOption', async () => {
    const fake = makeCapturingFake()
    const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child })
    const started = agent.start()
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n')
    await new Promise((r) => setTimeout(r, 0))
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) + '\n',
    )
    await started

    const opened = agent.openThread()
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: {
          sessionId: SESSION_ID,
          configOptions: [
            { id: 'mode' },
            { id: 'model' },
            {
              id: 'thinking',
              currentValue: 'high',
              options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }],
            },
          ],
        },
      }) + '\n',
    )
    const info = await opened
    expect(info.reasoningEffort).toEqual({
      current: 'high',
      options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }],
    })
  })

  it('openThread leaves reasoningEffort null when no thinking configOption is advertised', async () => {
    const fake = makeCapturingFake()
    const agent = await connect(fake)

    // Open a second Thread over the same agent whose result omits configOptions.
    const opened = agent.openThread()
    const req = sent(fake).filter((m) => m.method === 'session/new').at(-1)
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: req?.id, result: { sessionId: 'second' } }) + '\n')
    const info = await opened
    expect(info.reasoningEffort).toBeNull()
  })
})

/**
 * Eager primary session (ADR-0012): one `session/new` opened at connect, whose
 * controls seed a Draft's picker and whose session the first prompt reuses.
 * Consume-once semantics keep a second concurrent Draft minting its own session.
 */
describe('WorkspaceAgent primary session (ADR-0012)', () => {
  const PRIMARY_ID = 'primary-0001'

  /** Drive start() to a ready, signed-in agent WITHOUT opening a Thread. */
  async function startReady(fake: CapturingFake): Promise<WorkspaceAgent> {
    const agent = new WorkspaceAgent({ workspaceDir: '/abs/workspace', spawn: () => fake.child })
    const started = agent.start()
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }) + '\n')
    await new Promise((r) => setTimeout(r, 0))
    fake.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { authenticated: true, authState: 'os_keyring' } }) + '\n',
    )
    await started
    return agent
  }

  it('opens ONE primary session, exposes its controls, and consumes it exactly once', async () => {
    const fake = makeCapturingFake()
    const agent = await startReady(fake)

    // Nothing before the eager open: no controls, nothing to consume.
    expect(agent.primarySessionControls).toBeNull()
    expect(agent.consumePrimarySession()).toBeNull()

    const opening = agent.openPrimarySession()
    // The eager session/new (id 3) — answer with a real Mode control.
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        result: { sessionId: PRIMARY_ID, modes: { currentModeId: 'default', availableModes: [] } },
      }) + '\n',
    )
    await opening

    // Controls readable from the primary session (seed a Draft's picker pre-prompt).
    expect(agent.primarySessionControls).toEqual({
      modes: { currentModeId: 'default', availableModes: [] },
      models: null,
      reasoningEffort: null,
    })
    // Hosted — so the bound Thread's later prompts reuse it (already-hosted path).
    expect(agent.hasSession(PRIMARY_ID)).toBe(true)

    // Idempotent: a second openPrimarySession sends NO second session/new.
    await agent.openPrimarySession()
    expect(sent(fake).filter((m) => m.method === 'session/new')).toHaveLength(1)

    // Consume once: returns the ThreadInfo, then null on any later claim.
    expect(agent.consumePrimarySession()?.sessionId).toBe(PRIMARY_ID)
    expect(agent.consumePrimarySession()).toBeNull()

    // Controls stay readable after consume (learned lists for the connection's life).
    expect(agent.primarySessionControls).not.toBeNull()
  })

  it('two concurrent openPrimarySession calls share ONE session/new (ADR-0012, no race)', async () => {
    const fake = makeCapturingFake()
    const agent = await startReady(fake)

    // Overlapping connects on the SAME agent (e.g. Workspace double-click): both call
    // openPrimarySession before either resolves. They must dedupe to one session/new.
    const first = agent.openPrimarySession()
    const second = agent.openPrimarySession()
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: PRIMARY_ID } }) + '\n')
    await Promise.all([first, second])

    expect(sent(fake).filter((m) => m.method === 'session/new')).toHaveLength(1)
    expect(agent.hasSession(PRIMARY_ID)).toBe(true)
    // Exactly one session to consume, then null.
    expect(agent.consumePrimarySession()?.sessionId).toBe(PRIMARY_ID)
    expect(agent.consumePrimarySession()).toBeNull()
  })

  it('drops the primary session on stop() (eviction) — a re-warm re-opens one', async () => {
    const fake = makeCapturingFake()
    const agent = await startReady(fake)

    const opening = agent.openPrimarySession()
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { sessionId: PRIMARY_ID } }) + '\n')
    await opening
    expect(agent.primarySessionControls).not.toBeNull()

    agent.stop()

    // Torn down with the process (ADR-0012 #6 / ADR-0006): no lingering session.
    expect(agent.primarySessionControls).toBeNull()
    expect(agent.consumePrimarySession()).toBeNull()
    expect(agent.hasSession(PRIMARY_ID)).toBe(false)
  })
})
