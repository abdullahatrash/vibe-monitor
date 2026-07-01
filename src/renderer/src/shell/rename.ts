/**
 * Resolve a sidebar rename-edit submission to the title to APPLY, or `null` for a
 * no-op. Pure (no React) so the commit rule is unit-tested apart from the input.
 *
 * A rename commits only a MEANINGFUL change: the trimmed input, unless it is empty
 * (blanking a title is a cancel, never a persisted "") or equals the current title
 * (nothing to do). `current` is the Thread's existing title (`null` when untitled),
 * so renaming an untitled Thread to non-empty text commits, and re-typing the same
 * title no-ops.
 */
export function normalizeRename(raw: string, current: string | null): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === (current ?? '')) return null
  return trimmed
}
