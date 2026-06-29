# App shell: persistent two-pane layout, a pure nav reducer, and a warm-agent pool

vibe-mistro's UI grew one tracer-bullet at a time into a single stacked column: a header, an
"Environment" card, and one "Workspace" card that swaps its whole contents based on
`connect.status` (cold list ↔ connecting ↔ sign-in ↔ the live `ConnectedWorkspace`). That
shape fused two concerns that a real app shell must separate:

- **Navigation** — *which* Workspace and Thread the user is looking at.
- **Connection lifecycle** — whether that Workspace's `vibe-acp` agent is spawned, signed in,
  and hosting ACP sessions.

Because they were fused, switching Workspaces tore the agent down and re-ran the handshake, and
a Workspace's live turn died the moment you navigated away. That undercuts the persistent
sidebar we want (Workspace switcher + a thread list that's always there + a conversation
outlet — the t3code `AppSidebarLayout > Outlet` shape, see `docs/t3code-reference.md` §4).

This ADR fixes the shell's structural primitives. It does **not** prescribe visual design
(that lives in `docs/design/brand.md`) or the per-slice mechanics (the epic's tracer bullets).

## Decision

1. **A persistent two-pane shell.** A top-level `<Shell>` renders a left sidebar (Workspace
   switcher pinned at top + a unified Thread list for the selected Workspace + a New-thread
   control) and a conversation **outlet** on the right. The sidebar is always mounted; only the
   outlet's content swaps. The Thread list **unifies cold and live Threads** into one list per
   Workspace — cold Threads come from the JSON metadata / JSONL (ADR-0005), live Threads from
   the warm agent — distinguished by a streaming/live indicator, not by living in separate views.

2. **Navigation is a pure reducer; no router, no UI-store library.** Selection state
   (`selectedWorkspaceId`, `selectedThreadId`, and the warm-agent registry) lives in a single
   pure reducer at the shell root, mirroring `src/renderer/src/conversation/reducer.ts`
   (ADR-0001). No URL routing, no TanStack Router, no Zustand. Our own reference notes already
   flag those as overkill at this scale ("a plain `useReducer` + IPC `useEffect` is fine" —
   `docs/t3code-reference.md` §4). A router earns its place only if deep-linking / history is
   ever required; a UI store earns its place only when prop-drilling genuinely hurts.

3. **One warm `vibe-acp` agent per OPEN Workspace — a bounded pool, not one-at-a-time.** The
   main process keeps an **agent pool keyed by Workspace** (`workspaceId`/dir). Selecting a
   Workspace **lazily spawns** its agent on first need and then **keeps it warm**, so switching
   back is instant and a Workspace's Threads keep streaming while the user is looking elsewhere.
   This is the model that cashes in the multi-Thread-per-agent work (one agent hosts many ACP
   sessions, demuxed by `sessionId` — TB5 of the persistence epic). The pool is **bounded**:
   evict an agent after an idle timeout and cap the number of simultaneously-warm agents
   (exact N / M tuned in a hardening slice); eviction disposes the child cleanly and persists
   nothing new (metadata + JSONL already survive — ADR-0005), so an evicted Workspace re-warms
   transparently on next select. Navigation never blocks on connection: selecting a not-yet-warm
   or not-signed-in Workspace shows its connect/sign-in state **inline in the outlet**, while the
   sidebar stays put.

## Why

- **Decoupling nav from connection** is the whole point of a persistent shell — without it the
  sidebar is a lie (it can't stay put across a teardown). Making selection a pure reducer keeps
  it testable and matches the one state pattern we already trust.
- **A warm pool over one-at-a-time:** the alternative (tear down on every switch) is simpler but
  re-handshakes and re-runs auth detection on each Workspace change and **kills background live
  turns** — directly at odds with an always-there sidebar. We already key agents by id and own
  best-effort disposal, so the pool is an incremental lifecycle layer, not a rewrite. We bound it
  precisely because unbounded warm children would leak processes/memory.
- **No router / no Zustand now:** both are real dependencies with real surface (route-tree
  codegen; a second state system). We have no deep-linking requirement in a single-window
  desktop app, and one reducer is enough. Deferring keeps the seam clean and the decision cheap
  to revisit — adding either later is local, removing them is not.

## Alternatives considered

- **One agent at a time** (closest to today): simplest lifecycle, fewest processes; rejected
  because slow switching + dead background turns defeat the shell's purpose.
- **Real router (TanStack/React Router)** with `_chat.$workspaceId.$threadId` routes (t3code's
  approach): buys deep-linking/history we don't need yet; deferred, not foreclosed.
- **Zustand UI store** split from server state (t3code's split): clean as panels multiply;
  deferred until prop-drilling or reload-persistence actually demands it.
- **An `AgentPool` seam + measure-then-decide spike:** adds an indirection layer before we know
  we need tuning; we instead commit to the warm pool and tune N/M in a dedicated hardening slice.

## Consequences

- Main gains an **agent-pool / Workspace-warm-set** module (lazy spawn, reuse-by-Workspace,
  idle-evict, cap, clean dispose) — the lifecycle owner that the per-connection `WorkspaceAgent`
  plugs into. The existing `disposeAgentsForWorkspace` dedup logic folds into it.
- The renderer gains a `<Shell>` + a **nav reducer**; the current `connect.status` view-swap in
  `App.tsx` is replaced by per-Workspace inline connection state inside the outlet.
- Connection/auth states (connecting, not-signed-in, mid-session expiry, error) move from
  full-view swaps to **inline-in-outlet** while the sidebar persists.
- Bounded warmth means a Workspace can be evicted under the cap/idle policy and silently
  re-warm; nothing user-visible is lost because history is read from our own store (ADR-0005).
- Builds on: ADR-0001 (renderer owns conversation state; Workspace/Thread/ACP-session layering),
  ADR-0005 (persistence; one agent hosts many sessions). Does not change the auth (ADR-0003) or
  fs (ADR-0004) models.
