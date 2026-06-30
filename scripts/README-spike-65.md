# Spike #65 — verify how `vibe-acp` changes Agent controls (Mode / Model / Reasoning effort)

`scripts/spike-config-option.ts` is a throwaway, heavily-logged probe that drives `vibe-acp` directly to
answer issue **#65** (prerequisite for the Agent-controls picker, #66 / ADR-0007): what is the method to
*change* a session's Mode / Model / Reasoning effort, does the change emit a notification, and does it
survive a `session/load`?

It reuses the app's own transport (`src/main/acp/client.ts::AcpClient`) so the JSON-RPC framing is
byte-identical to production, and sends the same `initialize` params as `src/main/workspace-agent.ts`.

## ⚠️ This is LIVE — run it yourself, signed in

- Uses your **real Mistral account**: it calls `session/new`, the config setters, and (for the Q2 check)
  **one trivial `session/prompt`** ("reply with: ok") so the session becomes loadable — it consumes a
  few credits. The prompt runs **after** switching to read-only `plan` mode, so the agent cannot touch
  the workspace.
- It does **NOT** call `authenticate` / `_auth/signOut` and never changes your sign-in state (only reads
  `_auth/status` to fail fast). Safe under the house security rules.
- **Prerequisite:** be **SIGNED IN** (run `vibe` once if not). The probe exits with code `2` if
  `_auth/status` reports `authenticated:false` or any call returns `-32000`.

## Run it (under node, NOT bun)

```
bun build scripts/spike-config-option.ts --target=node --outfile=/tmp/spike-config.mjs && node /tmp/spike-config.mjs
```

Bun's `node:child_process` doesn't deliver `stdin.write()` to a piped child (see acp-capture §9), so the
script must be bundled to a node target and run under `node`.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--skip-q2` | off | Skip the credit-costing prompt + `session/load` persistence check (Q1/Q3 only). |
| `--cwd=<dir>` | a stable temp dir | Session working dir. |
| `--command=<bin>` | `vibe-acp` | Launch command. |
| `--idle-ms=<n>` | `2000` | Idle window to collect notifications after each change. |

## Findings (vibe-acp 2.18.0, captured 2026-06-30)

Authoritative writeup is **acp-capture §10**. In short:

- **Mode** → `session/set_mode {sessionId, modeId}` → `{}`
- **Model** → `session/set_model {sessionId, modelId}` → `{}` (⚠️ false-accepts any string)
- **Reasoning effort** → `session/set_config_option {sessionId, configId, value}` → `{}` (it's `configId`, not `id`)
- **No notification** on change → the renderer updates optimistically.
- **Mode does NOT survive `session/load`** (resets to `default`) → cache + re-assert per ADR-0007.
