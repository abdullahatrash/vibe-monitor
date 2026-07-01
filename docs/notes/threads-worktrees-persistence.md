# t3code: Threads, Worktrees & Local Persistence — Findings

> Investigation notes. Line numbers reflect the repo state at time of writing (2026-07-01) and may drift.

## Q1: Is each thread a git worktree?

**No.** A thread is an orchestration/projection entity that belongs to a project
(`projectId`) and carries an **optional, nullable `worktreePath`**. Thread → worktree is a
*zero-or-one* reference (by filesystem path); worktree → threads is *one-to-many*.

### Three possible states for a thread
1. **Own worktree** — dedicated git worktree + temporary branch (`t3code/<hex>`).
2. **Shared worktree** — multiple threads point at the same `worktreePath`.
3. **Local mode** — no worktree; runs in the project root checkout (`workspaceRoot`).

The env-mode toggle (`apps/web/src/components/BranchToolbarEnvModeSelector.tsx`) lets the
user pick **"local"** vs **"worktree"** per thread.

### Key locations
- Thread shell shape (nullable `worktreePath`, `branch`): `packages/contracts/src/orchestration.ts:560`
- Projection column `worktree_path AS "worktreePath"`: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:127,331`
- Worktree prepared only on first message + `sendEnvMode === "worktree"` + no existing path: `apps/web/src/components/ChatView.tsx:3969`
- Server creates worktree then writes path/branch back to thread: `apps/server/src/ws.ts:836` (`gitWorkflow.createWorktree` + `thread.meta.update`)
- Actual git call `git worktree add -b <branch> <path> <ref>`: `apps/server/src/vcs/GitVcsDriverCore.ts:2245`
  - path: `worktreesDir/<repoName>/<sanitizedBranch>`; branch prefix `t3code/<hex>` (`packages/shared/src/git.ts`)
- Fallback to project root when no worktree: `apps/server/src/ws.ts:1448`
  - `workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot`
- Sharing evidence — orphan check skips worktrees still referenced by other threads:
  `apps/web/src/worktreeCleanup.ts:11` (`getOrphanedWorktreePathForThread`)

### Git isolation
Opt-in per thread. "worktree" mode → dedicated worktree/branch (isolated cwd + branch).
"local" / reused path → shares the checkout, no per-thread isolation. The same
`worktreePath` flows into terminal sessions (`apps/server/src/terminal/Manager.ts`) and
setup-script execution (`apps/server/src/project/ProjectSetupScriptRunner.ts:135`).

---

## Q2: How does t3code save threads & conversations locally?

**One SQLite file, event-sourced (CQRS).** Default path: **`~/.t3/userdata/state.sqlite`**
(+ `-wal` / `-shm` sidecars, WAL mode).

### Storage engine
SQLite via Effect's `unstable/sql`. Driver picked at runtime (`persistence/Layers/Sqlite.ts:19-31`):
- Bun → `@effect/sql-sqlite-bun/SqliteClient`
- Node → local `apps/server/src/persistence/NodeSqliteClient.ts` wrapping `node:sqlite`
  (`DatabaseSync`; needs Node >=22.16/23.11/24)

On connect: `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, then run migrations
(`Sqlite.ts:33-40`). No JSON/LevelDB store for chat data.

### Architecture — event sourced, not a plain row store
1. **Append-only event log** → `orchestration_events` (`Migrations/001_OrchestrationEvents.ts`).
   Immutable rows; global `sequence AUTOINCREMENT` + per-stream `stream_version` with optimistic
   concurrency (unique on `(aggregate_kind, stream_id, stream_version)`). Store only INSERTs /
   reads forward (`persistence/Layers/OrchestrationEventStore.ts`).
2. **Projector** folds events → read-model tables, tracking a per-projector cursor
   `last_applied_sequence` in `projection_state` (`orchestration/Layers/ProjectionPipeline.ts`,
   `persistence/Layers/ProjectionState.ts`).
3. **Read side** queries the projection tables to build UI snapshots
   (`orchestration/Layers/ProjectionSnapshotQuery.ts`).

Flow: commands → append events → project into `projection_*` → snapshot queries read them.

### Main read-model tables (`Migrations/005_Projections.ts`)
- `projection_projects`
- `projection_threads` — `thread_id PK`, `project_id`, `title`, `model`, `branch`,
  `worktree_path`, `latest_turn_id`, timestamps, `deleted_at` (indexed by `project_id`)
- `projection_thread_messages` — `message_id PK`, `thread_id`, `turn_id?`, `role`, `text`,
  `is_streaming`, timestamps; `attachments_json` added in migration 007. Ordered history via
  `idx_projection_thread_messages_thread_created (thread_id, created_at)`
- `projection_turns` — one request/response cycle; `UNIQUE (thread_id, turn_id)`
- `projection_thread_activities` (tool calls), `projection_thread_sessions` (live session state)

Messages are written by idempotent upsert `INSERT ... ON CONFLICT(message_id) DO UPDATE`
(`persistence/Layers/ProjectionThreadMessages.ts`), so streaming assistant text repeatedly
upserts the same row. A message links to its conversation via `thread_id` and its cycle via `turn_id`.

### On-disk path config (`ServerConfig`)
- `apps/server/src/config.ts:91-121` (`deriveServerPaths`):
  `stateDir = baseDir/{userdata|dev}`, `dbPath = stateDir/state.sqlite`
- `apps/server/src/os-jank.ts:86-92` — default `baseDir = ~/.t3`; override via `--baseDir` /
  `T3_HOME` (`apps/server/src/cli/config.ts:262-274`)
- Wired in `persistence/Layers/Sqlite.ts:66-68` — `layerConfig` reads `dbPath` off `ServerConfig`;
  `:memory:` variant for tests

### Migrations
`apps/server/src/persistence/Migrations/`, registered in `persistence/Migrations.ts` (32 migrations),
run via Effect `Migrator` (tracking table `effect_sql_migrations`).

---

## Q3: vibe-mistro persistence vs t3code, and the adoption path

### What vibe-mistro does today (`/Users/abdullahatrash/mistral/vibe-mistro`)
Purely files, **no database** (design in `docs/adr/0005-persistence-json-metadata-vibe-owns-history.md`).
Single-writer: only the Electron main process mutates; renderer is pure.

- **`metadata.json`** — one flat index file: `{ workspaces[], threads[] }` (`src/main/persistence/metadata-store.ts`).
  - `WorkspaceMeta` = `{ id, dir, displayName, lastOpenedAt }` (keyed by absolute `dir`)
  - `ThreadMeta` = `{ id, workspaceId, sessionId, title, createdAt, lastActiveAt }` (`src/shared/ipc.ts:570`)
  - **No messages here** — it's a light index. Atomic write via tmp + `fs.rename` (`metadata-store.ts:186`).
- **`transcripts/<threadId>.jsonl`** — one append-only JSONL per thread (`src/main/persistence/transcript.ts`).
  - Each line is a `TranscriptEntry` union: `user-prompt | acp-event | turn-complete | turn-error |
    resolve-permission | agent-rebound` (`ipc.ts:598`)
  - Replayed through the renderer's `conversationReducer` on reopen to rebuild the view.
- Rooted at Electron `userData` (`app.getPath('userData')`, macOS `~/Library/Application Support/vibe-mistro/`),
  derived in `src/main/index.ts:1004-1019`. Project dirs are referenced only by absolute path in metadata.
- Store modules: `metadata-store.ts` (`load`/`persist`/`upsertWorkspace`/`upsertThread`/`deleteThread`),
  `transcript.ts` (`append`/`read`/`delete`, per-thread promise-chained appends), `delete-thread.ts`.

### Head-to-head

| | vibe-mistro | t3code |
|---|---|---|
| Store | JSON index + per-thread JSONL | single SQLite `state.sqlite` (WAL) |
| Model | metadata rows + append-only transcript | event log + projected read tables (CQRS) |
| Source of truth | the JSONL transcript | `orchestration_events` (immutable) |
| Read model | rebuilt in renderer reducer at open | `projection_*` tables, cursor-tracked |
| Queries | load whole file, filter in JS | SQL (indexed by project/thread/turn) |
| Schema evolution | ad-hoc shape-filtering on load | numbered migrations (`Migrator`) |

**Key insight:** vibe-mistro already has the important half of t3code's design — an append-only event
stream (its JSONL *is* the log; `TranscriptEntry` ≈ an event). What's missing is (1) a queryable
projected read-model and (2) formal migrations. So this is less of a rewrite than it looks.

### Adoption path (staged, each stage shippable)

**Stage 0 — scope.** Likely don't need full CQRS. Real wins: SQL queryability, indexed lists,
migrations. Target "SQLite + a projections layer," not "adopt the whole Effect orchestration engine."

**Stage 1 — SQLite behind the existing store interface.**
- Add `node:sqlite` (Node ≥22.16, like t3code's `NodeSqliteClient.ts`) or `better-sqlite3`.
- Keep `MetadataStore`/`TranscriptStore` public methods identical; swap bodies for SQL. IPC/renderer unchanged.
- On open: `journal_mode=WAL`, `foreign_keys=ON` (mirror `Sqlite.ts:33`).
- _Captures ~80% of the durability benefit for ~10% of the effort._

**Stage 2 — port the event log.**
- Table `events(sequence INTEGER PK AUTOINCREMENT, thread_id, stream_version, type, payload_json, created_at)`
  = the JSONL, one row per `TranscriptEntry`. `append()` → INSERT (mirror `OrchestrationEventStore.ts`).
- Optional `UNIQUE(thread_id, stream_version)` for optimistic concurrency — probably skip initially
  given single-writer.

**Stage 3 — projection tables + projector.**
- `projection_threads`, `projection_thread_messages`, `projection_turns` (crib from `Migrations/005_Projections.ts`),
  plus `projection_state(name, last_applied_sequence)`.
- Projector folds events → tables (mirror `ProjectionPipeline.ts`); messages via idempotent
  `INSERT ... ON CONFLICT(message_id) DO UPDATE` for streaming (mirror `ProjectionThreadMessages.ts`).
- `listMetadata` becomes an indexed SQL query instead of load-whole-JSON + filter.

**Stage 4 — migrations + one-time importer.**
- Adopt a numbered-migration runner (Effect `Migrator`, or a tiny `PRAGMA user_version` one).
- Importer reads existing `metadata.json` + every `transcripts/*.jsonl`, replays into `events`,
  rebuilds projections. Keep JSON files as backup for one release.

**Pragmatic stopping points:** Stages 1–2 alone give atomic multi-thread writes, crash safety, and
cross-thread queries without a projector. Stages 3–4 add the fast indexed read-model and safe schema
evolution. Full Effect-style CQRS is optional — only worth it at t3code-like scale/concurrency.

**Caveat:** vibe-mistro's current design is clean, documented, single-writer. Justify the migration by
real pain: (a) large-JSON load/filter getting slow, (b) wanting relational cross-thread/turn queries,
(c) schema-evolution churn. If none bite yet, do Stage 1 and stop.

---

## Decision log — grill session 2026-07-01 (branch `docs/persistence-adoption`)

**Persistence migration: DEFERRED, per ADR-0005.** Re-evaluated adopting t3code's SQLite + event-
sourcing. Verdict: no fired trigger.
- Search (0005's stated trigger) is a *future* feature, not present → not yet.
- The "slow cold-start" symptom was traced and is **NOT** a storage problem: launch reads only the small
  `metadata.json`; zero JSONL is touched at startup; transcripts load lazily on thread-open. SQLite would
  not fix it. Real suspects live outside persistence (`vibe-detect` `execFile`, bundle startup, lazy
  agent spawn, per-open replay). *Separate investigation if cold-start is worth chasing.*

**Instead: hardened the seam (done this session).**
- **Seam audit: clean.** All `metadata.json` / `*.jsonl` access is funneled through `MetadataStore` /
  `TranscriptStore`; path derivation single-sourced in `index.ts:1007/1013`; single-writer (main) holds;
  renderer/preload go through IPC only. The SQLite swap is genuinely drop-in (reimplement the two classes
  behind their injected `deps`). Added a SEAM CONTRACT comment atop each store to keep it that way.
- **Metadata versioning + fail-closed.** `metadata.json` is now a `{ schemaVersion, workspaces, threads }`
  envelope (`METADATA_SCHEMA_VERSION = 1`; legacy files read as v1). A file with a *newer* version
  **locks** the store: `load()` refuses to load and `persist()` becomes a no-op, so an older build can
  never atomically overwrite (wipe) newer data. `isLocked()` exposed for a future UI notice.
- **Transcript versioning.** Each log's first line is a version header
  (`TRANSCRIPT_SCHEMA_VERSION = 1`), written once, restart-safe (checks file contents), skipped on replay.
  `transcriptVersionOf(raw)` for future migrators; legacy header-less logs read as v1.

**Empty-thread bug: confirmed + specified fix (ADR-0011 written, code fix pending).**
- Opening a Workspace persists an empty Thread (`startThread` → `openThread()` + `recordThread()`,
  `index.ts:671`). The #58 draft fix (`85e95ef`) only ever covered the + button.
- Decision: **Option 1** — Workspace-open creates a renderer-only Draft (like the + button); defer both
  `session/new` and persistence to first prompt. Workspace metadata still persists on open; only the
  Thread defers. Captured as the **Draft Thread** term (CONTEXT.md) + **ADR-0011**.
- ⚠️ Code fix to `selectWorkspace`/`connectWorkspace`/`startThread` is NOT yet implemented — next task.

**Docs touched:** `CONTEXT.md` (Thread + new Draft Thread terms), `docs/adr/0011-*.md` (new),
`src/main/persistence/{metadata-store,transcript}.ts` (+ tests). All 501 tests green, typecheck clean.
