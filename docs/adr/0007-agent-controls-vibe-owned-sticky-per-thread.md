# Agent controls (Mode / Model / Reasoning effort) are Vibe-owned, sticky per-Thread, and display-from-session-state

**Agent controls** — a Thread's **Mode** (collaboration/approval posture: `default`/`chat`/`plan`/`auto-approve`),
**Model** (which LLM), and **Reasoning effort** (`thinking`: off…max) — are surfaced from `session/new`
(and `session/load`), changed mid-Thread via Vibe's config-option method, and **owned by Vibe at
runtime**: we display whatever the session reports and relay changes, rather than persisting the
selection in our metadata store. They are **sticky per-Thread** (set once, hold until changed — matching
ACP's session-state model), not per-turn.

## Decisions

- **Scope:** the three ACP-native axes only (Mode, Model, Reasoning effort), grouped as Agent controls.
  Out: t3code's separate access/`RuntimeMode` axis (covered for us by `default` mode gating writes +
  fs confinement, ADR-0004) and the `/fast` service tier (no ACP surface in our capture).
- **Ownership / persistence:** Vibe owns the live value; we render it from `session/new`/`session/load`
  and do NOT persist it as authoritative in our metadata store (ADR-0005: Vibe owns session state, we
  own only the durable Thread id, resume cursor, title, transcript). A cold (un-resumed) Thread simply
  shows no Mode until opened.
- **Change flow:** renderer initiates → main relays the change method (like `respondPermission`) → the
  agent is authoritative for the new current value, ideally via a `current_mode_update` `session/update`
  the renderer folds into the connection's `modes`/`models` (NOT the conversation reducer, which holds
  items). Optimistic update is the fallback if no notification is emitted.
- **Timing:** between-turns only for the first slice (controls disabled while a turn is in flight, like
  the send button). A Mode change is **forward-acting** — it never retroactively auto-resolves a pending
  Permission request (auto-approving without the user's click would be a trust-violating side effect).
- **Pre-session:** a #58 renderer-only draft has no session, so Agent controls are enabled only once the
  Thread is bound (after first prompt); a draft starts under Vibe's defaults. A draft-level pending
  selection (extending the #60 composer-draft store) is a deferred follow-up.

## Status: blocked on a verification spike

The change mechanism is unverified. `session/new` exposes `configOptions` with ids `mode`/`model`/
`thinking`, and notes guess the setter is `set_config_option` — but the exact method name/shape is not
captured on the wire. A probe spike (run under node, not bun — the bun child-process gotcha; safe under
the house rules since it only touches `session/*`) must capture, before the picker is built (mirroring
the #29 `session/load` spike): (1) the change method name + params, (2) whether a resumed session
preserves the last-set Mode or resets to default — if it **resets**, we add our-side caching +
re-assert via the setter after `session/load` (the only case where Mode/Model touches our metadata), and
(3) whether a change emits a `current_mode_update` notification.

## Considered alternatives

- **Persist the selection per-Thread in our metadata (t3code's approach: committed on the thread +
  pending on the composer draft, `composer ?? thread ?? default`).** Rejected as the default: it
  duplicates state Vibe already tracks and risks drift; we adopt it only as the spike-contingent
  fallback if Vibe doesn't preserve Mode across reload.
- **Per-turn Model switching** ("use model X for this message"). Rejected: fights ACP's sticky
  session-state model and introduces a per-turn override concept we don't otherwise have.
