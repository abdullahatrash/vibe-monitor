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

  it('does NOT classify a generic (non-auth) initialize error as unauthenticated', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent)
    // initialize is request id 1.
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'workspace trust required' },
      }) + '\n',
    )

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toBe('workspace trust required')
    expect((err as WorkspaceAgentError).message).not.toMatch(/not signed in/i)
    expect((err as WorkspaceAgentError).hint).toBeNull()
  })

  it('classifies an auth-style initialize error as unauthenticated + AUTH_HINT', async () => {
    const fake = makeFakeChild()
    const agent = makeAgent(fake)

    const pending = startAndCatch(agent)
    fake.feed(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32000, message: 'authentication required' },
      }) + '\n',
    )

    const err = await pending
    expect(err).toBeInstanceOf(WorkspaceAgentError)
    expect((err as WorkspaceAgentError).message).toMatch(/not signed in/i)
    expect((err as WorkspaceAgentError).message).toContain('authentication required')
    expect((err as WorkspaceAgentError).hint).toBe(AUTH_HINT)
  })
})

// --- TB2: prompt + fs/read serving (a writes-capturing fake) ----------------

interface CapturingFake extends FakeChild {
  writes: string[]
}

function makeCapturingFake(): CapturingFake {
  const stdoutListeners: Array<(chunk: string) => void> = []
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
    on: () => {},
    kill: () => {},
  }
  return {
    child,
    writes,
    feed: (chunk) => stdoutListeners.forEach((l) => l(chunk)),
    emitExit: () => {},
    emitError: () => {},
  }
}

interface SentRpc {
  id?: number
  method?: string
  params?: { sessionId?: string; prompt?: Array<{ type: string; text: string }> }
  result?: { content?: string }
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
  await started
  const opened = agent.openThread()
  fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: SESSION_ID } }) + '\n')
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
