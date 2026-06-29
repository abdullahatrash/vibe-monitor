# vibe-mistro is a thin orchestrator; agent capabilities belong to Vibe

vibe-mistro is a GUI shell that drives an **external** agent (`vibe-acp`) over ACP. The model loop,
tool selection, and code intelligence (LSP-style lookups, search, edits) are **Vibe's**
responsibility, not ours. We spawn/​supervise the agent, send prompts, render its streamed output,
and answer its permission requests — nothing more. We do **not** run our own language servers, embed
the model, or re-implement agent tooling.

This is the structural difference from opencode: **opencode *is* the agent** (it owns the model loop
and exposes LSP as one of its tools in its core package), with the desktop app as one frontend.
vibe-mistro sits a layer above the agent, like CodexMonitor sits above `codex`. When Vibe uses
code intelligence, it reaches us as ACP tool-call items that we simply display.

## Considered options

- **Own an LSP subsystem from the start (opencode-style)** — rejected. Wrong layer: it duplicates
  tooling that lives inside Vibe, adds a large subsystem (per-language server lifecycle, diagnostics
  plumbing), and serves none of the planned slices. CodexMonitor ships no LSP and is complete.
- **Stay a thin shell** (chosen) — agent capabilities stay in Vibe; we render tool-call output.

## Consequences

- No language-server management code in vibe-mistro. Tool calls (incl. any LSP-backed ones Vibe
  performs) render via the generic tool card.
- **Exception, additive and reversible:** if we later want editor-like features in our *own* file
  viewer (go-to-definition / hover / inline diagnostics) that work independently of the agent, we may
  add an isolated, optional LSP module then. That is a GUI feature, not agent tooling, and does not
  reverse this ADR — it carves out a narrow, explicit exception to it.
