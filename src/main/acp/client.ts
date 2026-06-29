import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

/**
 * Minimal JSON-RPC 2.0 client over stdio for Mistral Vibe's `vibe-acp`
 * (Agent Client Protocol) server.
 *
 * ACP frames messages as newline-delimited JSON: one JSON-RPC object per line
 * on stdin/stdout. This client handles request/response correlation by `id`
 * and re-emits server-initiated requests and notifications as events.
 *
 * NOTE: the concrete ACP method names (`initialize`, `session/new`,
 * `session/prompt`, ...) are wired up feature-by-feature on top of this
 * transport. This class only owns the transport + correlation.
 */

export interface AcpClientOptions {
  /** Command to launch. Defaults to `vibe-acp`. */
  command?: string
  args?: string[]
  /** Working directory for the spawned process. */
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

type JsonRpcId = number | string

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private stdoutBuffer = ''

  constructor(private readonly options: AcpClientOptions = {}) {
    super()
  }

  /** Spawn the vibe-acp process. Throws if it cannot be launched. */
  start(): void {
    if (this.child) throw new Error('AcpClient already started')

    const command = this.options.command ?? 'vibe-acp'
    const child = spawn(command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('stderr', chunk))
    child.on('error', (err) => this.emit('error', err))
    child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      this.rejectAllPending(new Error(`vibe-acp exited (code=${code}, signal=${signal})`))
      this.child = null
    })

    this.child = child
  }

  /** Send a JSON-RPC request and await its response. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('AcpClient not started'))

    const id = this.nextId++
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.writeMessage(child, message)
    })
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    const child = this.child
    if (!child) throw new Error('AcpClient not started')
    this.writeMessage(child, { jsonrpc: '2.0', method, params })
  }

  stop(): void {
    this.child?.kill()
    this.child = null
    this.rejectAllPending(new Error('AcpClient stopped'))
  }

  private writeMessage(child: ChildProcessWithoutNullStreams, message: JsonRpcMessage): void {
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex: number
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.dispatch(line)
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcMessage
    try {
      message = JSON.parse(line)
    } catch {
      this.emit('parseError', line)
      return
    }

    // Response to one of our requests.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (pending) {
        this.pending.delete(message.id)
        if (message.error) pending.reject(message.error)
        else pending.resolve(message.result)
      }
      return
    }

    // Server-initiated request (e.g. tool-call approval) — caller must answer.
    if (message.method && message.id !== undefined) {
      this.emit('serverRequest', message)
      return
    }

    // Notification (streamed updates).
    if (message.method) {
      this.emit('notification', message)
    }
  }

  private rejectAllPending(reason: unknown): void {
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
  }
}
