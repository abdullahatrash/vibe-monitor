# Spike #29 — verify `vibe-acp` `session/load` replay behaviour (LIVE / HITL)

`scripts/spike-session-load.ts` is a throwaway, heavily-logged probe that drives
`vibe-acp` directly to answer issue **#29**: when you `session/load` a `sessionId`
created in an *earlier* process, does the agent resume and replay the conversation
(as `session/update` notifications), return it some other way, or not at all — and
what error comes back for an unknown id (the signal **TB4 #33** re-binds on)?

It **reuses the app's own transport** (`src/main/acp/client.ts::AcpClient`), so the
newline-delimited JSON-RPC framing is byte-identical to production, and sends the
same `initialize` params as `src/main/workspace-agent.ts`.

## ⚠️ This is LIVE — run it yourself, signed in

- It uses your **real Mistral account**: it calls `session/new` + `session/prompt`,
  so it **consumes credits** and writes to the **real session store**.
- It does **not** call `authenticate` or `_auth/signOut` — it never changes your
  sign-in state. It only *reads* it via `_auth/status` to fail fast if signed out.
- **Prerequisite:** you must be **SIGNED IN**. If you aren't, run `vibe` once to
  sign in. The probe exits with code `2` and a clear message if `_auth/status`
  reports `authenticated:false` or any call returns `-32000`.

## Run it

From the spike worktree (where this branch is checked out):

```
cd /Users/abdullahatrash/mistral/vibe-mistro-wt29 && bun scripts/spike-session-load.ts --phase=all
```

`bun` runs the TypeScript directly (no build/compile step). `vibe-acp` must be on
your `PATH` (it is if `vibe` works in your shell).

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--phase=a\|b\|c\|all` | `all` | Which phase(s) to run. `all` = A→B→C in sequence. |
| `--cwd=<dir>` | a stable temp dir | Session working dir. **B must use the same cwd as A.** |
| `--session=<id>` | — | Run B/C against a known sessionId (else read from a prior A run). |
| `--command=<bin>` | `vibe-acp` | Launch command. |
| `--state-file=<path>` | temp file | Where A persists `{sessionId,cwd}` for a later B/C. |
| `--idle-ms=<n>` | `5000` | Replay idle-gap in B: "replay done" after this much silence. |

Standalone resume (e.g. after a real prior session):
`bun scripts/spike-session-load.ts --phase=b --session=<uuid> --cwd=<same cwd as A>`

## What each phase prints (and how to read it)

- **PHASE A** — `initialize` result, `_auth/status`, `session/new` result, the
  `>>> sessionId = …` line, every `session/update` during the trivial turn, and the
  `session/prompt` turn-end result. Ends by persisting `{sessionId,cwd}`.
- **PHASE B** — spawns a **fresh** `vibe-acp`, then `session/load{sessionId,cwd,
  mcpServers:[]}`. Logs the **raw** `session/load` result **and every replayed
  `session/update`** as it arrives, waits out the idle-gap, then prints
  **PHASE B SUMMARY**: did load succeed? how many notifications replayed, grouped by
  `sessionUpdate` type? → tells us if history replays over the wire or must come
  from our JSONL.
- **PHASE C** — `session/load` with a random bogus UUID. Prints
  **PHASE C SUMMARY** with the exact `error.code` / `error.message` / `error.data`
  (or flags an unexpected success). **This is the resume-failure signal TB4 keys on.**

## Paste results back into `docs/acp-capture.md`

Add a new section using this template, filling in the verbatim JSON from the run:

```markdown
## 9. `session/load` (resume) — captured <date>, vibe-acp <version>

### Request (Phase B)
\`\`\`json
{"id":N,"method":"session/load","params":{"sessionId":"<uuid>","cwd":"<abs>","mcpServers":[]}}
\`\`\`

### Response (result)
\`\`\`json
<paste the "session/load result" JSON from PHASE B>
\`\`\`

### Replay
- Replayed `session/update` notifications: <count> (or "none").
- By `sessionUpdate` type: <paste the PHASE B SUMMARY breakdown>.
- Replay-done signal: idle-gap of ~<idle-ms>ms (no terminal marker observed / marker = …).
- Shape: <paste one representative replayed notification, verbatim>.

### Unknown session (Phase C)
\`\`\`
error.code    = <code>
error.message = "<message>"
error.data    = <data>
\`\`\`

### Conclusion
- Does reopen-for-continue need anything beyond our JSONL replay? <yes/no + why>.
- How TB4 should detect resume failure: key on `error.code == <code>` from `session/load`.
```
