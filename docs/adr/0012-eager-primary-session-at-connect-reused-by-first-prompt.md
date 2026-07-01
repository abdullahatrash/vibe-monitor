# Open one primary ACP session per Workspace at connect, reused by the first prompt

**Status: ACCEPTED** (2026-07-01). Amends **ADR-0011** — reverses its decision #2 ("No eager
`session/new`") while preserving its core invariant (#1: no persisted Thread/transcript residue until the
first prompt). Builds on **ADR-0006** (warm agent pool) and **ADR-0007** (agent controls are Vibe-owned,
surfaced only by `session/new`/`session/load`).

## Context

The composer's **Mode / Model / Reasoning-effort** pickers are empty on a fresh Draft — they only appear
after the first prompt. Root cause is protocol-shaped and confirmed against ground truth: vibe-acp
advertises the control option lists ONLY in the `session/new` / `session/load` response, never at
`initialize` (`docs/acp-capture.md:23-35`). We are a **thin orchestrator (ADR-0002)** and deliberately
keep **no** client-side model/mode registry — so with no session there is nothing to populate the picker
from. (Contrast t3code, which shows its pickers pre-prompt precisely because it *owns* a client-side
provider/model registry — `ServerProviderModel[]` from its contracts layer — a design we rejected under
ADR-0002 because Vibe owns the lists and they are per-account, e.g. vision only on `mistral-medium-3.5`.)

ADR-0011 anticipated this exact gap and deferred it: "the very first Thread (no session yet) is
unavoidable." **#153** shipped the enhancement it predicted — a per-Workspace controls cache — which makes
the picker appear on drafts **after** a Workspace has bound at least once. But the **first-ever draft** in a
Workspace (or after a cache-clear) is still bare, and that is the moment a user most often meets the app.
This ADR closes that last gap by giving every Draft a real session's controls to read from, immediately.

## Decision

1. **One primary ACP session per Workspace, opened at connect.** When a Workspace connects and its agent
   is warm (ADR-0006), open a single `session/new` and keep its `sessionId` + reported controls on the
   connection as the Workspace's **primary session**. This seeds `connectionControlsOf(conn)` with real,
   account-accurate option lists, so a Draft's picker renders on the first paint — no prompt required.

2. **The first prompt REUSES the primary session; it does not mint a second.** A Draft's first prompt
   binds to the Workspace's unconsumed primary session (marking it consumed) instead of calling a fresh
   `session/new`. In the common case (the user does prompt) the eager session is *the* session the Thread
   uses — not waste. If the primary session is already consumed (a second concurrent Draft, or the first
   Thread already bound), the next first-prompt mints a new session exactly as today.

3. **ADR-0011's residue invariant is preserved unchanged.** First prompt remains the single durability
   trigger: **no metadata record and no transcript file** is written for a Thread until it binds. An idle
   primary ACP session is an in-memory protocol handle on `vibe-acp`, **not** persisted state — the
   metadata Thread list still contains only prompted Threads. Opening/clicking Workspaces still writes zero
   Threads to `metadata.json`.

4. **The connection retains the option lists for the Workspace's lifetime**, independent of which session
   provided them. Once learned (from the primary session, or restored from the #153 cache before it
   responds), every subsequent Draft AND every not-yet-resumed Continue in that Workspace shows the picker —
   not just the first Draft. This also closes the identical picker gap on the Continue flow that ADR-0011
   left open (`continueConnection` hard-codes null controls until the lazy resume).

5. **#153's cache becomes the fast path, not the mechanism.** The cache still seeds the picker instantly on
   connect (surviving restarts, covering the window before the primary `session/new` returns) and the
   eager primary session provides the authoritative, live values that the cache is then refreshed from.
   Belt and suspenders; neither is removed.

6. **Bounded lifetime.** A primary session for a Workspace the user opens but never prompts is torn down
   when its agent is idle-evicted / LRU-capped (ADR-0006) — the same bound that already governs warm
   agents. At most one idle session per warm Workspace.

## Why

The value that was "not worth it" when ADR-0011 was written now is: the app has a final design whose
composer shows the controls up front, and the empty-first-draft picker reads as broken (it prompted this
ADR). The two reasons ADR-0011 gave for rejecting eager `session/new` are answered rather than ignored:

- **"Session churn / usually-abandoned sessions."** ADR-0011's rejected option opened a session on *every*
  Workspace click and *deferred only the record*, so the session was pure overhead. Decision #2 here makes
  the eager session **the first Thread's session** (reuse), so in the prompted case there is no extra
  session at all — the handshake simply moves from first-prompt to connect. Only the opened-but-never-
  prompted Workspace leaves one idle session, and #6 bounds that. Churn is per-Workspace-connect, not
  per-click.
- **"Two entry points diverge at the protocol layer."** They still converge: a Draft from either door (the
  + button or Workspace-open) reuses the same per-Workspace primary session on its first prompt. One
  session rule, one persistence rule, both doors.

Net: the first-prompt latency *improves* (session already open), the picker is populated everywhere, and
the only new cost is a bounded idle session in the abandon case — which is strictly less residue than the
pre-ADR-0011 world (no empty Thread, no metadata write).

## Considered options

- **Keep ADR-0011 + the #153 cache only (status quo)** — rejected as insufficient: the first-ever draft in
  a Workspace stays bare, which is the exact complaint. The cache cannot invent options with no session.
- **Client-side model/mode registry (the t3code approach)** — rejected: violates ADR-0002 (thin
  orchestrator; Vibe owns the lists) and would drift from Vibe's real, per-account, per-version option sets
  (models differ by account; modes/effort can change across vibe-acp versions). A hardcoded list would lie.
- **Eager session at connect, WITHOUT reuse (mint a fresh one on first prompt anyway)** — rejected: that is
  ADR-0011's rejected "defer only the record" option verbatim — real churn, an abandoned session every
  connect. Reuse (#2) is what makes this defensible.
- **Eager `initialize`-only probe for controls** — impossible: `initialize` carries no model/mode data
  (`acp-capture.md:23-35`).
- **Open the primary session lazily on first *Workspace select* rather than connect** — folded in: "at
  connect" here means when the agent is warm and the Workspace is selected; a background/never-selected
  Workspace need not pay it. Implementation may open it on first select of a connected Workspace.

## Consequences

- **`thread-binding.ts` gains a reuse branch.** A Draft's first prompt checks for the Workspace's unconsumed
  primary `sessionId` and binds to it (persist + `mintAndBind` semantics unchanged apart from the session
  source); absent/consumed → mint as today. A "consumed" flag lives on the connection/primary-session state.
- **Connect grows a `session/new`.** Selecting a connected Workspace opens one session and threads its
  controls onto the connection (App seeds `configFor`/draft controls from it, same shape #75/#153 already
  consume). One extra round-trip on connect, on an already-warm process (a handshake, not a spawn).
- **The first draft's picker is populated on first paint** (from the #153 cache if present, then reconciled
  to the primary session's live values). The first-ever Draft in a never-prompted Workspace now shows the
  picker too — the case ADR-0011 called "unavoidable" becomes avoidable, at the cost of one bounded session.
- **Continue-flow picker gap also closes:** a reopened, not-yet-resumed Thread shows the Workspace's option
  lists instead of null controls.
- **One idle ACP session per opened-but-never-prompted Workspace**, torn down on agent eviction (ADR-0006).
  This is the entire new cost, and it is bounded by the existing warm-agent policy.
- **Eviction / re-warm:** when an evicted Workspace is re-selected, the primary session is re-opened on
  re-warm (transparent, like agent re-warm today). The #153 cache covers the picker during the gap.
- **Supersedes ADR-0011 decision #2 only.** ADR-0011 decisions #1 (first-prompt durability trigger), #3
  (both entry points identical), and #4 (Workspace metadata persists on open) remain in force. ADR-0005
  (storage engine) and ADR-0006 (warm pool) are unaffected.

## Rollout

A single tracer-bullet slice (renderer + main): (1) open the primary session on connect and thread its
controls onto the connection; (2) `thread-binding` reuse branch + consumed flag; (3) keep #153 as the
instant-paint cache. Behavior-identical to today except the picker now shows pre-prompt and the first
prompt reuses the primary session. Gates: `bun run lint && bun run typecheck && bun run build && bun run test`.
Live-smoke: open a never-prompted Workspace → New chat → pickers present immediately; send first prompt →
it reuses the primary session (no second `session/new`); open a second concurrent Draft → its first prompt
mints its own session.
