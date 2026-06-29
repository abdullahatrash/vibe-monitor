# Vibe Mistro

A desktop app for orchestrating multiple [Mistral Vibe](https://docs.mistral.ai/vibe/code/cli/install-setup) coding agents across local workspaces — inspired by [CodexMonitor](https://github.com/Dimillian/CodexMonitor), but built on **Electron + TypeScript + Bun** and driven by Vibe's **Agent Client Protocol (ACP)** server (`vibe-acp`) instead of Codex.

> Status: early scaffold. Thin vertical slice (environment detection + ACP transport) in place; features are being ported from CodexMonitor one at a time.

## Architecture

```
┌─────────────────────────────┐
│ Renderer (React + TS)       │   UI: sidebar, threads, conversation, diffs
│  src/renderer               │
└──────────────┬──────────────┘
               │ contextBridge IPC (src/preload)
┌──────────────┴──────────────┐
│ Main process (Electron)     │   Orchestrator (CodexMonitor's Rust/Tauri role)
│  src/main                   │
│   ├─ vibe-detect.ts         │   locate `vibe` / `vibe-acp` on PATH
│   └─ acp/client.ts          │   JSON-RPC 2.0 over stdio ↔ vibe-acp
└──────────────┬──────────────┘
               │ spawn + stdin/stdout
        ┌──────┴──────┐
        │  vibe-acp   │  one process per workspace
        └─────────────┘
```

`vibe-acp` is Vibe's ACP server: it speaks **JSON-RPC 2.0 over stdin/stdout**, the same
transport editors like Zed use. That is the equivalent of Codex's `app-server` protocol
and is what makes a GUI orchestrator possible.

## Requirements

- [Bun](https://bun.sh) (package manager + tooling)
- Node.js (Electron bundles its own; nvm-managed Node is used for native install steps)
- [Mistral Vibe CLI](https://docs.mistral.ai/vibe/code/cli/install-setup) — `vibe` and `vibe-acp` on `PATH`

## Develop

```bash
bun install
bun run dev        # launch Electron + Vite dev server
bun run typecheck  # type-check main + renderer
bun run build      # production build
```

## Roadmap (porting CodexMonitor feature-by-feature)

- [x] Project scaffold (Electron + Vite + React + TS, Bun-managed)
- [x] Environment detection (`vibe` / `vibe-acp`)
- [x] ACP stdio transport (JSON-RPC framing + correlation)
- [ ] ACP handshake: `initialize` → `session/new` → `session/prompt`
- [ ] Conversation view: stream reasoning / tool calls / diffs
- [ ] Tool-call approval prompts (plan / accept-edits / auto-approve)
- [ ] Workspaces sidebar + persistence
- [ ] Multiple concurrent agents / threads, resume sessions
- [ ] Git + GitHub (`gh`) panel
- [ ] File tree, prompt library, settings

## License

MIT
