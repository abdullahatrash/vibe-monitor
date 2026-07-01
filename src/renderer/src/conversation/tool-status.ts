/**
 * ToolRow status mapping (#115) — the PURE bridge from OUR ACP tool `status`
 * string (docs/acp-capture §4/§7: `pending` → `in_progress` → `completed`, or
 * `failed`) to the compact right-hand status glyph the row renders. Kept DOM-free
 * so it's unit-tested as data (`tool-status.test.ts`); the tsx just switches the
 * returned `glyph` to a lucide component.
 *
 * `state` collapses the protocol lifecycle to four display buckets; `glyph`
 * selects the trailing indicator — a spinner while the call is live (pending or
 * in-progress: "absence of a terminal check"), a `Check` once completed, a
 * destructive `X` on failure. An unknown/missing status defaults to `pending`
 * (spinner) — a freshly-created `tool_call` with no status yet is still "live".
 */
export type ToolDisplayState = 'pending' | 'running' | 'done' | 'failed'

export type ToolStatusGlyph = 'spinner' | 'check' | 'x'

export interface ToolStatusDisplay {
  state: ToolDisplayState
  glyph: ToolStatusGlyph
}

export function describeToolStatus(status: string | null | undefined): ToolStatusDisplay {
  switch (status) {
    case 'completed':
      return { state: 'done', glyph: 'check' }
    case 'failed':
      return { state: 'failed', glyph: 'x' }
    case 'in_progress':
      return { state: 'running', glyph: 'spinner' }
    case 'pending':
      return { state: 'pending', glyph: 'spinner' }
    default:
      // Unknown or missing status (e.g. a just-minted `tool_call`) is treated as
      // still-live: show the spinner, never a false "done".
      return { state: 'pending', glyph: 'spinner' }
  }
}
