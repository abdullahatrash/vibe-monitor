# Conversation state lives in the renderer; Workspace/Thread/ACP-session layering

The renderer owns the canonical conversation state (a reducer of typed conversation items, keyed by
Thread); the main process is a thin protocol layer that spawns/​supervises `vibe-acp` and forwards
raw ACP `session/update` events without interpreting them. We layer the domain as **Workspace** (a
directory + its one `vibe-acp` process) → **Thread** (a user-facing conversation = one **ACP
session**, the protocol handle from `session/new`). Agent-initiated **permission requests**
(`request_permission`) are queued in the renderer and answered back through main by their JSON-RPC
**request id**.

## Considered options

- **Main owns state, renderer mirrors** — rejected. More robust for multi-window, persistence, and a
  future remote backend, but heavier and unnecessary now; CodexMonitor proves a renderer-owned
  reducer scales for this app.
- **Renderer owns state** (chosen) — simplest, least IPC, matches CodexMonitor's proven model.

## Consequences

- Conversation state is lost on window reload and cannot be shared across windows. Acceptable for
  now; revisit if/when we add multiple windows, durable thread history, or the remote-backend slice —
  any of those may require promoting main to the source of truth (supersede this ADR then).
- "ACP session" stays out of the UI vocabulary; the UI speaks "Thread" (see CONTEXT.md).
