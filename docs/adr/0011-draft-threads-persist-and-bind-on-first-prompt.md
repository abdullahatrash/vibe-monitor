# Draft Threads: persist and bind an ACP session only on first prompt

A Thread must leave **zero residue** until the user actually talks to the agent. Creating a Thread —
whether via the New Thread (+) button or by opening a Workspace in the sidebar — produces a **Draft
Thread**: a renderer-only object holding a minted id and nothing else. The Thread becomes durable, and
an ACP session is opened for it, at exactly one moment: its **first prompt**. The persisted Thread list
therefore contains only prompted Threads.

This generalises the decision first made for the + button (commit `85e95ef`, "#58: make New-thread a
renderer-only draft until first prompt") to **every** entry point, and pins down the ACP-session
lifecycle that #58 left implicit.

## Decision

1. **First prompt is the single durability trigger.** No metadata record and no transcript file is
   written for a Thread until its first prompt binds it (via the existing `mintAndBind` path). The
   renderer mints the Thread id up front and preserves it across the bind, so the URL/selection is
   stable while the Thread is still a Draft.
2. **No eager `session/new`.** Opening a Workspace does **not** call `agent.openThread()`. The ACP
   session is created together with the first-prompt persistence, not on select. Clicking around
   Workspaces creates no sessions on `vibe-acp`.
3. **Both entry points behave identically.** The Workspace-first-open path creates a renderer-only
   Draft (same path as the + button) instead of the old eager `openThread()` + `recordThread()`.
4. **Workspace metadata still persists on open.** Selecting a Workspace upserts the Workspace record
   (dir, `lastOpenedAt`) and may warm its agent process (ADR-0006). Only the **Thread** write defers.
   Workspace durability and Thread durability are separate rules.

## Why

The draft model already existed for one door but was violated at the other: opening a Workspace ran
`agent.openThread()` + `recordThread()` and wrote an empty Thread to `metadata.json` with no user
interaction — directly contradicting #58's stated goal that "the sidebar only ever lists prompted
Threads." The principle lived only in a commit message, which was not enough to stop a second entry
point from regressing it. Recording it as an ADR and as a glossary term (**Draft Thread**, CONTEXT.md)
gives it a durable home and a name.

## Considered options

- **Eager `session/new` on Workspace-open, defer only the record** — rejected. First prompt is
  marginally faster because the session already exists, but every Workspace click opens a real ACP
  session on `vibe-acp` that is usually abandoned (session churn / orphans), and the two entry points
  keep diverging at the protocol layer — so the store we intend to harden would still be fed by two
  different session lifecycles.
- **Draft everywhere; open session + persist on first prompt** (chosen) — one persistence rule and one
  session rule through both doors. First prompt pays a `session/new` handshake, but on an already-warm
  process (ADR-0006) that is a handshake, not a spawn.

## Consequences

- The `startThread` normal branch no longer opens-and-records a Thread; Workspace-open yields a
  renderer-only Draft. `session/new` + persistence happen on first prompt through `mintAndBind`.
- A Draft abandoned before its first prompt leaves nothing on disk and nothing on the agent.
- First prompt carries the `session/new` round-trip. Acceptable: the process is warm; only the session
  handshake is on the critical path.
- **The first draft's agent-controls picker is empty until its first prompt.** vibe-acp advertises the
  Mode/Model/Reasoning-effort option lists ONLY in the `session/new` / `session/load` response — never at
  `initialize`/`agentCapabilities` (`docs/acp-capture.md:23-35`, `workspace-agent.ts:474-476`). With no
  eager session there is nothing to populate the picker from until the first prompt binds one. This is
  NOT a new regression: the Continue flow already behaves identically (`continueConnection` hard-codes
  null controls until the lazy resume, `index.ts`). A future enhancement — an agent-level controls cache
  seeded from the first `session/new` and reused for later drafts/continues — would populate the picker
  after any Thread has run once in the Workspace; the very first Thread (no session yet) is unavoidable.
  Deliberately deferred (not part of this change).
- The persisted Thread list is guaranteed to contain only prompted Threads — the invariant a future
  reader can rely on, and the reason not to "optimise" by re-introducing eager open (that is the
  rejected option above).
- Complements ADR-0005 (which owns the *storage engine* choice) and ADR-0006 (warm agent pool); it does
  not supersede either.
