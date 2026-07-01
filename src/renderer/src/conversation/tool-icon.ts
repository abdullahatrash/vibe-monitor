/**
 * ToolRow leading tone-icon (#115) — the PURE resolution from an ACP tool `kind`
 * (docs/acp-capture §7: `read` / `edit` / `delete` / `move` / `search` /
 * `execute` / `think` / `fetch` / `other`, plus loose synonyms Vibe may emit) to
 * a lucide icon NAME. Kept name-only (no JSX) so it's unit-tested as data
 * (`tool-icon.test.ts`); the tsx maps the name to a lucide component via an
 * explicit switch (NO dynamic import). Unknown/missing kinds fall back to
 * `wrench` — a generic "tool" affordance.
 */
export type ToolIconName =
  | 'eye'
  | 'square-pen'
  | 'terminal'
  | 'globe'
  | 'brain'
  | 'trash'
  | 'move'
  | 'search'
  | 'wrench'

export function toolKindIcon(kind: string | null | undefined): ToolIconName {
  switch (kind) {
    case 'read':
      return 'eye'
    case 'edit':
      return 'square-pen'
    case 'execute':
    case 'command':
      return 'terminal'
    case 'fetch':
    case 'web':
      return 'globe'
    case 'think':
      return 'brain'
    case 'delete':
      return 'trash'
    case 'move':
      return 'move'
    case 'search':
      return 'search'
    default:
      // `other`, unknown, or missing → the generic tool glyph.
      return 'wrench'
  }
}
