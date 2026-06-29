# Filesystem access: reads stay unconfined (CLI parity); writes are confined to the Workspace and symlink-resolved

The client serves the agent's file I/O over ACP — `fs/read_text_file` and `fs/write_text_file` — because
Vibe delegates all reads/edits to us (see `docs/acp-capture.md` §5, §7). That makes vibe-mistro the
enforcement point for what the agent can touch on disk. We adopt an **asymmetric** policy:

- **Reads are UNCONFINED.** `fs/read_text_file` serves any absolute path the user can read. This is
  deliberate parity with the `vibe` CLI, which reads unconfined: a coding agent routinely needs files
  outside the project (system headers, global `~/.gitconfig`, dependencies, sibling repos). The trust
  model is the same as running `vibe` in a terminal — *you launched this agent against your account*.
  Confining reads to the Workspace would make the GUI strictly less capable than the CLI it wraps.
- **Writes are CONFINED to the Workspace, with symlink resolution.** `fs/write_text_file` rejects any
  path that resolves outside the opened Workspace directory. Writes are destructive and only reach us
  after the user approved the `session/request_permission` for that tool call, but the user approved a
  write *they believe lands in this Workspace*. The confinement check resolves the **real path of the
  nearest existing ancestor** of the target (the file itself may not exist yet) and rejects it unless
  that real path is within the real path of the Workspace — so a symlink *inside* the Workspace pointing
  outside cannot be used to escape. This closes the lexical-only gap from the TB3 (#4) review.

## Considered options

- **Confine reads to the Workspace (or an allowlist)** — rejected for now. Strongest posture, consistent
  with writes, but it breaks legitimate cross-directory reads and diverges from the wrapped CLI. The real
  exfiltration risk (a prompt-injected agent reading `~/.ssh` and surfacing it) is not meaningfully solved
  by lexical path confinement; the right mitigation is permission-gating reads, which is a separate
  feature, not a path-hardening change. A `--add-dir`-style allowlist remains a viable future middle path.
- **Keep writes lexical-only** — rejected. `path.relative` on resolved paths correctly rejects `..` and
  absolute escapes but trusts symlinks, leaving a real confinement bypass for an approved write.
- **Asymmetric: unconfined reads + symlink-resolved confined writes** (chosen) — matches the CLI's read
  capability while closing the one concrete write-escape bug.

## Consequences

- The agent CAN read any file the user can (`~/.ssh`, `/etc`, sibling repos, global config). This is an
  accepted, documented trust-model decision, not an oversight — surface it when reasoning about
  exfiltration. A future permission-gating-for-reads feature can tighten it without reversing this ADR's
  *parity-by-default* stance.
- Write confinement now performs a filesystem lookup (realpath of the nearest existing ancestor), so the
  check is async and depends on the real filesystem layout, not just the strings. A symlinked Workspace
  root is handled because both sides are realpath-resolved before comparison.
- `fs-read.ts` and `fs-write.ts` reference this ADR so the asymmetry isn't mistaken for an inconsistency.
