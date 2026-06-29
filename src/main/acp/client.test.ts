import { describe, it, expect } from 'vitest'
import { AcpClient, type ChildProcessLike, type SpawnFn } from './client'

/**
 * Seam B: drive the transport with an injected fake child process — no real
 * `vibe-acp`. We feed stdout lines and capture stdin writes. Shapes are
 * verbatim from docs/acp-capture.md.
 */

interface FakeChild {
  child: ChildProcessLike
  /** Raw stdin writes captured from the client. */
  writes: string[]
  /** Push a chunk to the client's stdout reader. */
  feed: (chunk: string) => void
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void
  emitError: (err: Error) => void
}

function makeFakeChild(): FakeChild {
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
    stderr: {
      setEncoding: () => {},
      on: () => {},
    },
    stdin: {
      write: (data) => {
        writes.push(data)
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: 'error' | 'exit', listener: (...args: any[]) => void) => {
      if (event === 'exit') {
        exitListeners.push(listener)
      } else {
        errorListeners.push(listener)
      }
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

function setup(): { fake: FakeChild; client: AcpClient } {
  const fake = makeFakeChild()
  const spawnFn: SpawnFn = () => fake.child
  const client = new AcpClient({ command: 'vibe-acp', spawn: spawnFn })
  client.start()
  return { fake, client }
}

// --- Verbatim capture shapes (docs/acp-capture.md) -------------------------

const initializeResult = {
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { audio: false, embeddedContext: true, image: true },
    sessionCapabilities: { close: {}, fork: {}, list: {} },
  },
  agentInfo: { name: '@mistralai/mistral-vibe', title: 'Mistral Vibe', version: '2.18.0' },
  protocolVersion: 1,
}

const sessionNewResult = {
  sessionId: '8b7044cf-19d1-7a23-8da1-929c81b23170',
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default', description: 'Requires approval for tool executions' },
      { id: 'plan', name: 'Plan', description: 'Read-only agent for exploration and planning' },
    ],
  },
  models: {
    currentModelId: 'mistral-medium-3.5',
    availableModels: [{ modelId: 'mistral-medium-3.5', name: 'mistral-medium-3.5' }],
  },
}

const sessionUpdate = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: '8b7044cf-19d1-7a23-8da1-929c81b23170',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
      messageId: 'm1',
    },
  },
}

const fsReadRequest = {
  jsonrpc: '2.0',
  id: 0,
  method: 'fs/read_text_file',
  params: { path: '/abs/file.ts', limit: 2001, sessionId: '8b7044cf-19d1-7a23-8da1-929c81b23170' },
}

interface RpcLine {
  id?: number
  method?: string
  params?: { update?: { sessionUpdate?: string } }
}

describe('AcpClient transport (Seam B)', () => {
  it('correlates initialize and session/new responses by id', async () => {
    const { fake, client } = setup()

    const initPromise = client.request<typeof initializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'vibe-monitor', version: '0.0.1' },
    })
    const sessionPromise = client.request<typeof sessionNewResult>('session/new', {
      cwd: '/abs',
      mcpServers: [],
    })

    // Requests are framed as newline-delimited JSON with sequential ids.
    expect(fake.writes).toHaveLength(2)
    const sent = fake.writes.map((w) => {
      expect(w.endsWith('\n')).toBe(true)
      return JSON.parse(w) as RpcLine
    })
    expect(sent[0]).toMatchObject({ id: 1, method: 'initialize' })
    expect(sent[1]).toMatchObject({ id: 2, method: 'session/new' })

    // Respond out of order to prove correlation is by id, not arrival order.
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, result: sessionNewResult }) + '\n')
    fake.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: initializeResult }) + '\n')

    const session = await sessionPromise
    const init = await initPromise
    expect(session.sessionId).toBe('8b7044cf-19d1-7a23-8da1-929c81b23170')
    expect(init.protocolVersion).toBe(1)
  })

  it('emits session/update notifications on the notification event', () => {
    const { fake, client } = setup()
    const received: RpcLine[] = []
    client.on('notification', (m: RpcLine) => received.push(m))

    fake.feed(JSON.stringify(sessionUpdate) + '\n')

    expect(received).toHaveLength(1)
    expect(received[0].method).toBe('session/update')
    expect(received[0].params?.update?.sessionUpdate).toBe('agent_message_chunk')
  })

  it('emits agent->client requests on the serverRequest event', () => {
    const { fake, client } = setup()
    const received: RpcLine[] = []
    client.on('serverRequest', (m: RpcLine) => received.push(m))

    fake.feed(JSON.stringify(fsReadRequest) + '\n')

    expect(received).toHaveLength(1)
    expect(received[0].method).toBe('fs/read_text_file')
    expect(received[0].id).toBe(0)
  })

  it('frames a message split across two chunks', () => {
    const { fake, client } = setup()
    const received: RpcLine[] = []
    client.on('notification', (m: RpcLine) => received.push(m))

    const line = JSON.stringify(sessionUpdate)
    fake.feed(line.slice(0, 24))
    expect(received).toHaveLength(0) // no newline yet → no dispatch
    fake.feed(line.slice(24) + '\n')

    expect(received).toHaveLength(1)
    expect(received[0].method).toBe('session/update')
  })

  it('frames two messages arriving in a single chunk', () => {
    const { fake, client } = setup()
    const notifications: RpcLine[] = []
    const serverRequests: RpcLine[] = []
    client.on('notification', (m: RpcLine) => notifications.push(m))
    client.on('serverRequest', (m: RpcLine) => serverRequests.push(m))

    fake.feed(JSON.stringify(fsReadRequest) + '\n' + JSON.stringify(sessionUpdate) + '\n')

    expect(serverRequests).toHaveLength(1)
    expect(serverRequests[0].method).toBe('fs/read_text_file')
    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('session/update')
  })
})
