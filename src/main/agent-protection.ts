/**
 * The warm-pool eviction-protection predicate (TB5 #50), as a PURE function over
 * the three protection signals main tracks. This is the safety-critical guarantee
 * of the hardening slice — an agent that is protected is NEVER evicted by the idle
 * sweep OR the warm-count cap — so it lives here, decoupled from Electron/IPC, to
 * be unit-tested directly. `index.ts`'s `isAgentProtected` is a thin wrapper that
 * feeds it the live state; the pool calls that wrapper via its `isProtected` input.
 *
 * An agent is protected when it is ANY of:
 *   - the on-screen Workspace's agent (`activeAgentId`, reported by the renderer) —
 *     the Workspace the user is looking at is never evicted out from under them;
 *   - mid-turn (`inFlightTurns[agentId] > 0`) — a streaming Workspace is never
 *     disposed while a prompt is running;
 *   - mid-sign-in (`signingInAgents`) — a backgrounded delegated browser OAuth can
 *     pend longer than the idle timeout, so the agent is shielded for the flow's
 *     duration (a one-shot touch wouldn't outlast `IDLE_EVICT_MS`).
 */
export interface ProtectionState {
  /** The agentId of the currently selected (on-screen) Workspace, or null. */
  activeAgentId: string | null
  /** Per-agent count of in-flight prompt turns (absent / 0 = none). */
  inFlightTurns: ReadonlyMap<string, number>
  /** Agents with a sign-in flow in progress. */
  signingInAgents: ReadonlySet<string>
}

export function isProtected(agentId: string, state: ProtectionState): boolean {
  if (agentId === state.activeAgentId) return true
  if ((state.inFlightTurns.get(agentId) ?? 0) > 0) return true
  if (state.signingInAgents.has(agentId)) return true
  return false
}
