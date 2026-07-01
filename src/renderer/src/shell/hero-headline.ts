/**
 * The empty-state hero headline, split so the workspace name can render in the
 * accent colour ("What should we build in <workspace>?"). PURE: given a workspace
 * name it yields the lead-in, the (orange) name, and the trailing "?"; given none
 * (nothing selected, or a blank name) it collapses to a plain "What should we
 * build?" with no name span.
 */
export interface HeroHeadline {
  /** The text before the (optional) emphasized workspace name. */
  lead: string
  /** The workspace name to render in the accent colour, or null when absent. */
  name: string | null
  /** The trailing text after the name (the "?"), empty when there's no name. */
  tail: string
}

export function heroHeadline(workspaceName?: string | null): HeroHeadline {
  const trimmed = workspaceName?.trim()
  if (!trimmed) return { lead: 'What should we build?', name: null, tail: '' }
  return { lead: 'What should we build in ', name: trimmed, tail: '?' }
}
