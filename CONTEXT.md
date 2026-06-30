# vibe-mistro

A desktop app for orchestrating Mistral Vibe coding agents across local projects, driven over
Vibe's Agent Client Protocol (`vibe-acp`).

## Language

**Workspace**:
A local project directory the agent operates in, together with its single `vibe-acp` process.
_Avoid_: project, folder, repo (a workspace need not be a git repo).

**Thread**:
A user-facing conversation with the agent inside a Workspace. Maps one-to-one to an ACP session,
but is our own domain concept (own id, name, persistence). A Workspace can have many Threads.
_Avoid_: chat, conversation, session (in the UI/app layer).

**ACP session**:
The protocol-level handle returned by `session/new` and addressed by `session/*` methods. Lives only
at the main-process / protocol layer; never surfaced in the UI. One `vibe-acp` process hosts many.
_Avoid_: thread, session (unqualified, at the app layer).

**Permission request**:
An agent-initiated request (ACP `request_permission`) to perform a sensitive action mid-turn; the
agent blocks until the user picks a Permission option (allow once / reject once / …). Held in a
pending queue and answered by request id.
_Avoid_: approval, confirmation, prompt (reserve "prompt" for the user's message to the agent).

## Agent controls

The three per-Thread knobs the agent runs under, surfaced from `session/new` and changed mid-Thread.
Sticky per-Thread (set once, holds until changed), not per-turn.

**Mode**:
The agent's collaboration/approval posture for a Thread — one of five: `default` (tool use gated behind
a Permission request), `plan` (read-only, for exploration/planning), `accept-edits` (auto-approves file
edits only), `auto-approve` (auto-approves all tool use), `chat` (read-only conversational). Governs
whether Permission requests fire. Changed via `session/set_mode`; not preserved across a resume.
_Avoid_: collaboration mode, interaction mode, access mode. (Auth "modes" are a separate, unrelated axis.)

**Model**:
Which underlying LLM serves a Thread (e.g. `mistral-medium-3.5`, `devstral-small`, `local`).
_Avoid_: engine, provider.

**Reasoning effort**:
How much the Model deliberates before answering (`off` / `low` / `medium` / `high` / `max`).
_Avoid_: thinking (the ACP wire term), effort (reserve to avoid clashing with reasoning-stream content).

**Agent controls**:
The umbrella for Mode + Model + Reasoning effort together — the composer surface that sets them.
_Avoid_: config options, settings.
