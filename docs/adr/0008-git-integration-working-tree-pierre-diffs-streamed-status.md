# Git integration operates on the Workspace working tree (not worktree-per-Thread), renders diffs via `@pierre/diffs`, and streams status

vibe-mistro's git/GitHub integration is a **panel over the Workspace's single working tree** (the
CodexMonitor model), NOT a worktree-per-Thread isolation model (t3code). Git runs in **main**, shelling
out to `git`/`gh` via `child_process` (ADR-0002 thin-orchestrator; `docs/conventions.md`). The first
slice is **read-only**: a streamed git **status** + working-tree **diff review** in a collapsible right
**"Changes" panel** scoped to the active Workspace.

## Decisions

- **Operate on the Workspace working tree, not worktree-per-Thread.** A Workspace is a directory with one
  `vibe-acp` process; its many Threads share one working tree (CONTEXT.md), and the Changes panel observes
  that tree. We rejected t3code's worktree-per-Thread (each Thread = a branch in `worktrees/<repo>/<branch>`,
  agent cwd = worktree) as the foundation — it's a domain overhaul. It generalizes cleanly later (the
  "working tree" simply becomes a worktree's tree), so worktree-per-Thread isolation (for collision-free
  parallel agents) stays a deferred, separate epic, not a prerequisite.
- **Git in main via `child_process`** (`git`, later `gh`) — auth/SSH "just work". No `git2` /
  isomorphic-git / simple-git.
- **Read-only first slice; scope ladder.** Slice 1 = status + working-tree diff review. Follow-on slices:
  commit, then branches, then `gh` PR *surfacing*. Deferred (earn-in later): multi-repo aggregation, a
  full PR/issue *browser*, "Ask PR", init/create-repo.
- **Diffs via `@pierre/diffs`** (renderer, React 19): worker-pool `DiffsHighlighter` with stacked/split
  modes, mirroring the essentials of t3code's `DiffPanel` (minus review-comment annotations). The portable
  data contract: main returns **raw unified-diff text + a `diffHash`** (content hash); the renderer parses.
  v1 shows the **working-tree source only** (`git diff` for tracked + `git diff --no-index` for untracked);
  the `branch-range`/base-ref source is deferred (pairs with branches/PRs).
- **Status is streamed, not pulled.** A subscribe/unsubscribe IPC channel per active Workspace emits
  `snapshot` / `localUpdated` / `remoteUpdated` (mirrors t3code's `VcsStatusStreamEvent`). `localUpdated`
  is driven by a **debounced fs watcher** on the Workspace (ignoring `.git/` + churn dirs), backed by
  event triggers (turn-complete, select, manual refresh). `remoteUpdated` comes from a **cached background
  `git fetch`** (~15s TTL) computing ahead/behind. `git:diff` stays request/response.
- **Active-Workspace-only streaming.** Subscribe on select, unsubscribe on switch-away — bounds the panel
  to one fs watcher + one background fetch (same resource discipline as the warm-agent cap, ADR-0006). A
  background-Workspace "changed files" badge would need broader streaming and is deferred.
- **v1 is purely observational.** No writes; concurrency with the agent's own `git` tool-calls (the agent
  can commit mid-turn, gated by a Permission request) is deferred to the write slice's own design.
- **Degrade when not a repo.** "A Workspace need not be a git repo" (CONTEXT.md) — a non-repo Workspace
  shows no Changes panel (an empty/absent state, not an error).

## Considered alternatives

- **Worktree-per-Thread (t3code).** Rejected as the foundation: reshapes the Workspace/Thread/cwd model
  for a benefit (parallel-agent isolation) that isn't required to ship a useful git panel. Deferred as its
  own epic; the working-tree choice doesn't preclude it.
- **A lightweight in-house unified-diff view.** Rejected in favor of `@pierre/diffs` now — syntax
  highlighting + split view from the outset (deliberate quality call); the raw-patch+hash data contract is
  identical either way, so the choice is isolated to the renderer.
- **Pull / one-shot `git:status`.** Rejected in favor of streamed status + fs watcher — truly-live status
  that catches agent edits, the agent's own git commands, and the user's editor edits.
