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
A Thread starts as a Draft and becomes durable only on its first prompt (see **Draft Thread**).
_Avoid_: chat, conversation, session (in the UI/app layer).

**Draft Thread**:
A newly created Thread that exists only in the renderer and is persisted nowhere. A Thread holds its
minted id from creation, but is written to disk (metadata + transcript) only on its **first prompt** —
the single event that makes a Thread durable. Abandoning a Draft leaves zero residue; the persisted
Thread list contains only prompted Threads. Applies equally to both entry points — the New Thread
button and opening a Workspace.
_Avoid_: unsaved / temporary / phantom / ephemeral thread.

**ACP session**:
The protocol-level handle returned by `session/new` and addressed by `session/*` methods. Lives only
at the main-process / protocol layer; never surfaced in the UI. One `vibe-acp` process hosts many.
_Avoid_: thread, session (unqualified, at the app layer).

**Permission request**:
An agent-initiated request (ACP `request_permission`) to perform a sensitive action mid-turn; the
agent blocks until the user picks a Permission option (allow once / reject once / …). Held in a
pending queue and answered by request id.
_Avoid_: approval, confirmation, prompt (reserve "prompt" for the user's message to the agent).

## Side panel

**Surface**:
One of the expandable areas stacked in the right-hand side panel — Review, Terminal, Browser, Files.
The side panel itself is closed by default and toggled from the window header (or a Surface's
shortcut); open, each Surface shows as a launcher card and at most one is expanded at a time. Review
hosts the git Changes panel; Files hosts the Files browser; Terminal and Browser are reserved (not
yet built).
_Avoid_: tab, view, pane, dock (reserve "dock" for the future embedded terminal's chrome).

**Files browser**:
The Files Surface's content — a searchable tree of the Workspace's files, plus read-only previews of
opened files. With no file open the tree fills the Surface; opening files shows the preview pane beside
the tree, where each opened file is a tab (many open, one visible) topped by a read-only breadcrumb of
its path. Browsing and previewing never change files and never involve the agent.
_Avoid_: file tree (the widget, not the feature), explorer, finder.

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
