# vibe-monitor docs

Reference material gathered before/while building, so the implementation stays clean and
consistent. Read these before adding a feature.

| Doc | What it's for |
|---|---|
| [codexmonitor-reference.md](./codexmonitor-reference.md) | **What we're building.** Complete feature inventory of CodexMonitor + how each subsystem is implemented there (Tauri/Rust), with a translation to our Electron/TS stack. The source of our feature roadmap. |
| [opencode-electron-patterns.md](./opencode-electron-patterns.md) | **How to build it cleanly.** Electron architecture patterns mined from opencode's desktop app (same stack as us): process model, sidecar, typed IPC, persistence, updates, logging, packaging. |
| [vibe-acp-protocol.md](./vibe-acp-protocol.md) | **The backend contract.** Mistral Vibe's `vibe-acp` ACP server — JSON-RPC 2.0 method names, message flow, streaming, and the tool-permission model. Our `AcpClient` implements this. |
| [conventions.md](./conventions.md) | **Our decisions.** The conventions and architecture choices for vibe-monitor, synthesized from the three references above. When the references disagree, this doc is the tiebreaker. |

## TL;DR of the strategy

- **Copy the *concept* from CodexMonitor**, not the code — it's Rust/Tauri, we're TS/Electron.
  Its React frontend patterns (feature-sliced design, thread reducer, event routing) *do*
  translate; its Rust backend maps to our Electron main process.
- **Copy the *Electron mechanics* from opencode** — typed IPC, lazy `electron-store`, shell-env
  PATH resolution, logging, updater, packaging. This is our clean-code template.
- **The backend is different**: Codex uses `codex app-server`; we use Vibe's `vibe-acp`. Both are
  JSON-RPC-over-stdio, so the *transport pattern* carries over but the *methods* differ
  (see [vibe-acp-protocol.md](./vibe-acp-protocol.md)).
